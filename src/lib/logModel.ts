import type { LogLine } from "@/lib/ansi";

/**
 * 日志缓冲区 → Monaco 模型的增量同步规划。
 *
 * 为什么不能"每次变化就 setValue 整篇"：日志一秒可能几十次更新，
 * 5000 行的整篇替换意味着每次都要重新 tokenize 全篇，界面会持续掉帧。
 *
 * 现状有三种变化必须都处理对（都是实测过的行为，不是假想）：
 * - **纯追加**：绝大多数情况，新增行接在末尾；
 * - **原地改写**：docker 的进度行是同一行反复改文本（`updates` 会 +1）；
 * - **头部丢行**：缓冲区超过上限时从头部 `splice`，`dropped` 递增；
 *   而"清空"按钮与服务器的 reset 会让 `dropped` 归零或行数直接变 0。
 *
 * 这里只做决策、不碰 monaco：返回 reset 或一组 edit，便于单测。
 */

export interface SyncState {
  /** 已同步的最后一行的 `LogLine.id` */
  lastId: number;
  /** 已同步的行数（不含 pending 行） */
  lines: number;
  /** 已同步时的 dropped */
  dropped: number;
  /** 已同步的 pending 文本 */
  pending: string;
  /** id → 已同步文本，用于发现原地改写（只保留最近一段） */
  texts: Map<number, string>;
}

export interface SyncInput {
  lines: LogLine[];
  pending: string;
  dropped: number;
}

/** 0 基、end 不含；start===end 表示插入 */
export interface ModelEdit {
  startLine: number;
  endLine: number;
  text: string;
}

export type SyncPlan =
  | { mode: "edits"; edits: ModelEdit[]; state: SyncState }
  | { mode: "reset"; text: string; state: SyncState };

/** 原地改写只在最近这些行里找：进度行永远出现在末尾附近 */
const UPDATE_WINDOW = 500;
/** 一帧内要 replace 的行超过这个数，不如整篇重置 */
const MAX_REPLACES = 50;
/** texts 记录的 id 上限，防止长时间构建把内存吃满 */
const TEXT_MEMORY = 1000;

export function fullText(lines: LogLine[], pending: string): string {
  const body = lines.map((l) => l.text);
  if (pending) body.push(pending);
  return body.join("\n");
}

function stateOf(input: SyncInput): SyncState {
  const texts = new Map<number, string>();
  const from = Math.max(0, input.lines.length - TEXT_MEMORY);
  for (let i = from; i < input.lines.length; i += 1) {
    const l = input.lines[i];
    texts.set(l.id, l.text);
  }
  return {
    lastId: input.lines.length ? input.lines[input.lines.length - 1].id : 0,
    lines: input.lines.length,
    dropped: input.dropped,
    pending: input.pending,
    texts,
  };
}

function resetPlan(input: SyncInput): SyncPlan {
  return { mode: "reset", text: fullText(input.lines, input.pending), state: stateOf(input) };
}

export function planModelSync(prev: SyncState | null, next: SyncInput): SyncPlan {
  // 没有历史：首次渲染，整篇写入最省事
  if (!prev) return resetPlan(next);

  // 清空（「清空」按钮）、服务端 reset（dropped 变小）、id 回退 —— 都只能整篇重来
  if (next.lines.length === 0) return resetPlan(next);
  if (next.dropped < prev.dropped) return resetPlan(next);
  if (next.lines[next.lines.length - 1].id < prev.lastId) return resetPlan(next);

  // 已同步的旧行 = id <= prev.lastId 的前缀；之后的都是新增
  let kept = 0;
  while (kept < next.lines.length && next.lines[kept].id <= prev.lastId) kept += 1;

  const edits: ModelEdit[] = [];

  // 1) 头部丢行：模型里还留着这些行，先删掉
  const droppedDelta = next.dropped - prev.dropped;
  if (droppedDelta > 0) {
    edits.push({ startLine: 0, endLine: droppedDelta, text: "" });
  }

  // 2) 原地改写：只在最近 UPDATE_WINDOW 行里比文本
  const windowStart = Math.max(0, kept - UPDATE_WINDOW);
  for (let i = windowStart; i < kept; i += 1) {
    const l = next.lines[i];
    const before = prev.texts.get(l.id);
    if (before === undefined) continue; // 超出记录范围：按"没变"处理
    if (before === l.text) continue;
    edits.push({ startLine: i + droppedDelta, endLine: i + droppedDelta + 1, text: l.text });
    if (edits.length > MAX_REPLACES + 1) return resetPlan(next);
  }

  // 3) 尾部：追加的新行 + pending 行（pending 永远是模型最后一行）
  const appended = next.lines.slice(kept).map((l) => l.text);
  const tailParts = [...appended];
  if (next.pending) tailParts.push(next.pending);
  const tailFrom = prev.lines; // pending 在旧模型里的下标（没有 pending 时就是末尾）
  const hadPending = prev.pending !== "";
  const tailText = tailParts.join("\n");
  if (hadPending || tailText) {
    edits.push({
      startLine: tailFrom,
      endLine: tailFrom + (hadPending ? 1 : 0),
      text: tailText,
    });
  }

  return { mode: "edits", edits, state: stateOf(next) };
}
