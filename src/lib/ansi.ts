export interface LogLine {
  /** 稳定 id，供 v-for 的 key 使用（行内容会原地变化，不能用内容做 key） */
  id: number;
  text: string;
  /** 被原地覆盖的次数。>1 说明是进度行 */
  updates: number;
}

export interface LogBuffer {
  lines: LogLine[];
  /** 未以换行结尾的残留片段，等下一个 chunk 拼接 */
  pending: string;
  /** 进度行 key → lines 下标 */
  progressIndex: Map<string, number>;
  maxLines: number;
  nextId: number;
}

const DEFAULT_MAX_LINES = 5000;

export function createLogBuffer(opts?: { maxLines?: number }): LogBuffer {
  return {
    lines: [],
    pending: "",
    progressIndex: new Map(),
    maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
    nextId: 1,
  };
}

/**
 * 剥离 ANSI 转义序列。
 * 覆盖三类：CSI（颜色/光标）、OSC（终端标题，以 BEL 或 ST 结尾）、
 * 以及单字符转义（如 ESC ( B 这类字符集切换）。
 */
export function stripAnsi(input: string): string {
  return (
    input
      // CSI: ESC [ 参数 中间字节 终止字节
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      // OSC: ESC ] ... (BEL | ESC \)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      // 其余单字符转义（字符集切换等）
      .replace(/\u001b[()][AB012]/g, "")
      // 兜底：任何漏网的 ESC 序列
      .replace(/\u001b[@-Z\\-_]/g, "")
  );
}

/**
 * 进度行前缀，例如 "a1b2c3d4: Pushing"。
 * 必须与服务端 docker build 的输出格式一致（插件 src/media/log.js 同款判定）。
 */
const PROGRESS_RE = /^([0-9a-f]+: (?:Pushing|Pulling|Downloading|Extracting|Waiting|Preparing))/;

/**
 * 把一个日志 chunk 并入缓冲区。
 *
 * 处理三件事：
 * 1. 剥离 ANSI
 * 2. 按 \r\n | \n | \r 切分，跨 chunk 的不完整行留在 pending 里
 * 3. 进度行（同一层同一动作）**原地覆盖**而不是不断新增——
 *    docker build 每推进一次进度都会重新打印整行，不合并会刷出几千行
 */
export function ingest(buf: LogBuffer, chunk: string): void {
  // \r 统一按换行处理；进度行正是靠 \r 原地刷新，这里会先把它们分成多行，
  // 再由下面的进度行合并逻辑收敛回一行
  const text = stripAnsi(buf.pending + chunk);
  const parts = text.split(/\r\n|\n|\r/);
  // 最后一个片段可能是不完整的行
  buf.pending = parts.pop() ?? "";

  for (const raw of parts) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    pushLine(buf, line);
  }
}

/** 流结束时把残留片段作为最后一行收尾 */
export function flush(buf: LogBuffer): void {
  const rest = buf.pending.trim();
  buf.pending = "";
  if (rest) pushLine(buf, rest);
}

function pushLine(buf: LogBuffer, line: string): void {
  const m = line.match(PROGRESS_RE);
  if (m) {
    const key = m[1];
    const idx = buf.progressIndex.get(key);
    if (idx !== undefined && idx < buf.lines.length && buf.lines[idx].text.startsWith(key)) {
      buf.lines[idx].text = line;
      buf.lines[idx].updates += 1;
      return;
    }
  }
  buf.lines.push({ id: buf.nextId++, text: line, updates: 1 });
  if (m) buf.progressIndex.set(m[1], buf.lines.length - 1);
  trimIfNeeded(buf);
}

/**
 * 超出上限时从头部丢弃，并重建进度行索引。
 *
 * 必须重建索引：被丢弃的进度行如果还留在 map 里，
 * 下次同名进度会去找一个已经不存在（或被别的行占用）的下标，
 * 导致覆盖到错误的行。
 */
function trimIfNeeded(buf: LogBuffer): void {
  if (buf.lines.length <= buf.maxLines) return;
  const overflow = buf.lines.length - buf.maxLines;
  buf.lines.splice(0, overflow);
  buf.progressIndex.clear();
  buf.lines.forEach((l, i) => {
    const m = l.text.match(PROGRESS_RE);
    if (m) buf.progressIndex.set(m[1], i);
  });
}
