import { createLogBuffer, flush, ingest, type LogBuffer } from "./ansi";

/**
 * 大日志的**分片解析**。
 *
 * 原来把整段日志（服务端一次推的全量快照、或历史留存文件）直接丢给
 * `ingest` / `normalizeToLines`：正则要扫过整段文本，几十 MB 时主线程
 * 会被占住几秒到几十秒，表现就是「点日志按钮后程序卡死」。
 *
 * 这里按安全边界切片，每片处理完让出一次主线程：
 * - 浏览器有机会渲染进度、响应点击
 * - Vue 的响应式更新也能分批落地，不会一次性重绘几千行
 */

/** 小于这个长度直接同步处理：小 chunk 走快路径，保持实时日志的低延迟 */
export const SYNC_INGEST_LIMIT = 64 * 1024;

/** 单个切片的目标大小 */
export const INGEST_SLICE = 64 * 1024;

/** 一轮连续处理的时间预算（ms），到点就让出主线程 */
const TIME_BUDGET_MS = 12;

/**
 * 让出主线程，让浏览器有机会渲染与响应点击。
 *
 * 优先用 `scheduler.yield()`；没有时用 MessageChannel——**不用 setTimeout**：
 * 后台标签页会把 setTimeout 节流到最低 1s，打开大日志后切到别的标签，
 * 解析会被拖到几十秒。MessageChannel 不受定时器节流，同时仍会跨任务让出。
 */
export function yieldToMain(): Promise<void> {
  const scheduler = (
    globalThis as {
      scheduler?: { yield?: () => Promise<void> };
    }
  ).scheduler;
  if (typeof scheduler?.yield === "function") return scheduler.yield();

  if (typeof MessageChannel !== "undefined") {
    return new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(0);
    });
  }

  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * 找出下一个安全切点。
 *
 * 优先切在换行之后：ANSI 转义序列、`$<3>` 标记、CRLF 都不会跨行，
 * 因此按行切不会把一个控制序列撕成两半。
 * 整段没有换行时（超长单行输出）才退化为按长度切，但要避开代理对，
 * 以及尽量不切在未完成的 ESC 序列中间。
 */
export function safeCutIndex(s: string, start: number, maxLen: number): number {
  const limit = Math.min(s.length, start + maxLen);
  if (limit >= s.length) return s.length;

  const nl = s.lastIndexOf("\n", limit - 1);
  if (nl >= start) return nl + 1;

  // 上限正好落在一行中间：稍微往后找一点，尽量仍在换行处切。
  // 找不到（超长单行）再按长度切，且不会无限往后找。
  const lookAhead = Math.min(s.length, start + maxLen * 2);
  const nlAfter = s.indexOf("\n", limit);
  if (nlAfter >= 0 && nlAfter < lookAhead) return nlAfter + 1;

  // 没有换行：若切点附近有 ESC，往后让一点，避免切断控制序列
  const esc = s.lastIndexOf("\u001b", limit - 1);
  if (esc > start && limit - esc < 64) return esc;

  // 不要把一个 UTF-16 代理对切成两半（emoji / 部分生僻字）
  const code = s.charCodeAt(limit - 1);
  if (code >= 0xd800 && code <= 0xdbff) return Math.max(start + 1, limit - 1);
  return limit;
}

export interface IngestOptions {
  /** 每处理完一段回调一次（用于显示进度） */
  onProgress?: (done: number, total: number) => void;
  /** 返回 true 表示调用方已放弃（关标签 / 切到别的条目），尽快停止 */
  cancelled?: () => boolean;
}

/**
 * 把一个大 chunk 分片并入缓冲区。
 *
 * 与 `ingest` 语义完全一致（pending / 重画 / 进度行合并都保留），
 * 只是把工作拆到多个宏任务里。跨切片的半行仍留在 `buf.pending`，
 * 所以切片边界对结果没有影响。
 */
export async function ingestLarge(
  buf: LogBuffer,
  chunk: string,
  opts: IngestOptions = {},
): Promise<void> {
  const total = chunk.length;
  let offset = 0;

  while (offset < total) {
    if (opts.cancelled?.()) return;

    const startedAt = performance.now();
    while (offset < total && performance.now() - startedAt < TIME_BUDGET_MS) {
      const cut = safeCutIndex(chunk, offset, INGEST_SLICE);
      ingest(buf, chunk.slice(offset, cut));
      offset = cut;
    }
    opts.onProgress?.(offset, total);

    if (offset < total) await yieldToMain();
  }

  opts.onProgress?.(total, total);
}

export interface NormalizeResult {
  lines: string[];
  /** 超过 maxLines 被丢弃的行数 */
  omitted: number;
}

/**
 * 分片版 `normalizeToLines`，用于历史日志回看 / 导出。
 *
 * 只保留窗口内的行（默认 5000），大文件也不会让内存和 DOM 无界增长；
 * `omitted` 用于在界面上说明「省略了前面多少行」。
 */
export async function normalizeToLinesAsync(
  raw: string,
  opts: {
    maxLines?: number;
    onProgress?: (done: number, total: number) => void;
    cancelled?: () => boolean;
  } = {},
): Promise<NormalizeResult> {
  const buf = createLogBuffer({ maxLines: opts.maxLines });
  await ingestLarge(buf, raw, opts);
  if (opts.cancelled?.()) return { lines: [], omitted: 0 };
  flush(buf);
  return { lines: buf.lines.map((l) => l.text), omitted: buf.dropped };
}

/**
 * 分片版「剥离 ANSI + 按行整理」，用于导出。
 *
 * 与 `normalizeToLinesAsync` 同一套规则（空行会被丢弃），
 * 但保留全部行而不是只留最后 5000 行。
 */
export async function normalizeToTextAsync(
  raw: string,
  opts: IngestOptions = {},
): Promise<string> {
  const buf = createLogBuffer({ maxLines: Number.MAX_SAFE_INTEGER });
  await ingestLarge(buf, raw, opts);
  flush(buf);
  return buf.lines.map((l) => l.text).join("\n");
}
