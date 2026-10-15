export interface LogLine {
  /** 稳定 id，供 v-for 的 key 使用（行内容会原地变化，不能用内容做 key） */
  id: number;
  text: string;
  /** 被原地覆盖的次数。>1 说明是进度行 */
  updates: number;
}

export interface LogBuffer {
  lines: LogLine[];
  /** 当前这一行还没落地的内容（等下一个 chunk 拼接；回行首重画时会被清掉） */
  pending: string;
  /** 进度行 key → lines 下标 */
  progressIndex: Map<string, number>;
  maxLines: number;
  nextId: number;
}

const DEFAULT_MAX_LINES = 5000;

/**
 * 未遇到换行的残留片段上限。
 *
 * 没有它时，一段不含换行的长输出（或永远不结束的进度行）会让 pending 无限增长，
 * 而且每来一块都要把整串重剔一次 ANSI（O(n²)）。超限就直接当一整行落下来。
 */
const MAX_PENDING = 64 * 1024;

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
 * ITSM 转存 docker 行内刷新时留下的字面量标记。
 *
 * docker 的进度是用 `ESC[1A ESC[1K`「上移一行 + 清行」在原地重画的，ITSM 落库时把这套
 * 控制序列转成了字面量 `$<3>`，于是在日志里长这样（真实字节）：
 *
 *   ESC[1A ESC[1K $<3> ESC[K $<3> \r 127bb7ebb685: Preparing
 *
 * 不处理的话每条进度前都会多出一行 `$<3>$<3>`，既吵又把进度行打散。
 * 按服务端原样把它当换行处理（空行会被 ingest 丢掉）。
 */
const CRUMB = "$<3>";

/**
 * 日志正文的显示前处理：剥 ANSI + 把 `$<3>` 还原成换行。
 * 实时日志（`ingest`）与历史回看（读留存文件）都走这里，免得两边显示不一致。
 */
export function normalizeLogText(input: string): string {
  return stripAnsi(input).split(CRUMB).join("\n");
}

/**
 * 进度行前缀，例如 "a1b2c3d4: Pushing"。
 * 必须与服务端 docker build 的输出格式一致（插件 src/media/log.js 同款判定）。
 */
const PROGRESS_RE = /^([0-9a-f]+: (?:Pushing|Pulling|Downloading|Extracting|Waiting|Preparing))/;

/**
 * 「回到行首重画」的控制序列。
 *
 * 终端里这些序列的语义是**把当前行擦掉重新画**，不是换行：
 * - `\r`（单独出现，不是 CRLF）
 * - `ESC[1G` / `ESC[nG`：光标移到第 n 列
 * - `ESC[2K` / `ESC[K` / `ESC[0K`：擦除整行 / 行尾
 *
 * yarn、next.js、docker 的进度条全靠它们原地刷新（实测那份日志里 `ESC[1G` 出现 915 次）。
 * 早期实现把这些当普通 ANSI 直接**删掉**，于是每帧首尾相接地焊成一行，
 * 显示成 `…1059/1059[-----] 0/1022[-----] 0/55102…` 这种没人看得懂的东西。
 */
/**
 * 光标类控制序列的分词。
 *
 * | 匹配 | 终端语义 | 我们怎么处理 |
 * |---|---|---|
 * | `\n` / `\r\n` | 换行 | **落地当前行**，开始新行 |
 * | `ESC[nA`（光标上移） | 去**上一行**重画 | 同上：docker 是"多行 + 上下移"输出，每帧代表某一层，落地成行 |
 * | `\r`（单独） | 回本行行首 | **丢弃当前行**（终端会把这一行擦掉重写） |
 * | `ESC[nG`（移列） | 回行首/某列 | 同上 |
 * | `ESC[nK`（擦行） | 擦除本行 | 同上 |
 *
 * yarn / next.js 的进度条是"同一行反复重画"（`ESC[2K ESC[1G` 刷几百帧），
 * 按上表只剩最后一帧；docker 是"多行 + 光标上下移"，每层各留一行、
 * 再由 `PROGRESS_RE` 原地更新。两者都不会再焊成一行。
 */
const TOKEN_RE = /\r\n|\n|\u001b\[[0-9;]*A|\r|\u001b\[[0-9;]*[GK]/g;

type Piece = { text: string; kind: "text" | "break" | "rewrite" };

function splitSegments(input: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of input.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: input.slice(last, at), kind: "text" });
    const tok = m[0];
    const isBreak = tok === "\n" || tok === "\r\n" || tok.endsWith("A");
    out.push({ text: "", kind: isBreak ? "break" : "rewrite" });
    last = at + tok.length;
  }
  if (last < input.length) out.push({ text: input.slice(last), kind: "text" });
  return out;
}

/**
 * 把一个日志 chunk 并入缓冲区。
 *
 * 处理四件事：
 * 1. 剥离 ANSI（并把 `$<3>` 还原成换行，见 `normalizeLogText`）
 * 2. 按换行切分，跨 chunk 的不完整行留在 pending 里
 * 3. **回行首重画**（`\r` / `ESC[G` / `ESC[K`）= 覆盖当前行（终端语义）：
 *    当前行（`pending`）的内容被新帧**替换**掉，而不是新起一行。
 *    进度条刷 500 帧，行数不涨；`pending` 由视图实时显示，所以刷新期间也看得见
 * 4. 进度行（同一层同一动作）再按 key **原地覆盖**已落地的那一行——
 *    docker 是"多行 + 光标上下移"的输出，第 3 条盖不住它，这条补上
 */
export function ingest(buf: LogBuffer, chunk: string): void {
  // 待落地的半行先并进来，后面按「重画点」重新切；pending 由这段文本自己的片段重建
  const raw = buf.pending + chunk;
  buf.pending = "";

  for (const seg of splitSegments(raw)) {
    if (seg.kind === "rewrite") {
      // 回本行行首重画：终端会把这一行擦掉，所以直接丢掉攒着的内容
      buf.pending = "";
      continue;
    }
    if (seg.kind === "break") {
      const line = buf.pending.trimEnd();
      buf.pending = "";
      if (line.trim()) pushLine(buf, line);
      continue;
    }

    // $<3> 会在这步变成换行，所以一个片段里可能有多个硬换行
    const parts = normalizeLogText(seg.text).split("\n");
    // 最后一段可能是不完整的行，先攒着（它是当前行的延续）
    const tail = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.trimEnd();
      if (!line.trim()) continue;
      pushLine(buf, line);
    }
    // 只有空白、且当前行还是空的（例如刚被重画清掉）→ 不把这段空白攒成新行的开头
    if (tail.trim() || buf.pending) buf.pending += tail;
  }

  // 迟迟等不到换行的超长片段：直接收尾，保证内存有界
  if (buf.pending.length > MAX_PENDING) flush(buf);
}

/** 流结束时把残留片段作为最后一行收尾 */
export function flush(buf: LogBuffer): void {
  const rest = buf.pending.trim();
  buf.pending = "";
  if (rest) pushLine(buf, rest);
}

/**
 * 清空缓冲区。
 *
 * 服务端推的是全量快照，Rust 侧会自动取增量；只有它换窗口（快照不再包含
 * 已有内容）时才会让前端先清空，避免把两份不相干的日志拼在一起。
 * `nextId` 故意保留：v-for 的 key 不复用，少一类重绘抖动。
 */
export function reset(buf: LogBuffer): void {
  buf.lines.length = 0;
  buf.pending = "";
  buf.progressIndex.clear();
}

/**
 * 把一整段原始日志（例如历史留存的文件内容）过成干净的行。
 *
 * 与实时显示**完全同一套规则**（ANSI、`$<3>`、回行首重画、进度行合并），
 * 否则同一个任务在"实时标签"与"历史回看"里会长得不一样。
 */
export function normalizeToLines(raw: string): string[] {
  const buf = createLogBuffer();
  ingest(buf, raw);
  flush(buf);
  return buf.lines.map((l) => l.text);
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
