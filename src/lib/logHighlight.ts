/**
 * 构建日志的语法高亮。
 *
 * 这是**行级**规则：先给整行定一个语气（失败 / 警告 / 成功 / 结构行 / 进度行），
 * 语气为「中性」的行再做词法高亮（sha256、层/提交 id）。做成 Segments 而不是
 * 直接拼 HTML：日志内容来自构建输出，不能把任意文本当 HTML 注入。
 *
 * 规则顺序有意义：先判失败，再警告、成功、结构行——一行同时含「构建失败」与
 * 「成功」时应该按失败显示（例如「构建失败！！没有成功产出」）。
 */

export interface LogSegment {
  text: string;
  /** Tailwind 类名；空串表示继承行样式 */
  cls: string;
}

/** 终端风格下的固定配色（日志区固定深色，不跟随主题） */
const CLS = {
  danger: "text-red-400",
  warning: "text-amber-300",
  success: "text-emerald-400",
  step: "text-sky-300",
  pipeline: "text-sky-300/70",
  dim: "text-white/45",
  hash: "text-amber-200/90",
} as const;

const RULES: { re: RegExp; cls: string }[] = [
  // 失败最关键：「构建失败！！」「npm ERR!」「Failed」「Cannot find」…
  {
    re: /(error|failed|failure|fatal|exception|traceback|npm err!|elifecycle|cannot find|not found|失败|错误|异常)/i,
    cls: CLS.danger,
  },
  { re: /(warn|warning|deprecat|notice|警告)/i, cls: CLS.warning },
  { re: /(构建成功|success|successfully|finished: success|passed|✓|done in)/i, cls: CLS.success },
  // 结构行：Step 1/7、[Pipeline]、npm 脚本回显、shell 里带 + 的行
  { re: /^(step \d+\/\d+|\[pipeline\]|\+\s|>\s|#\s)/i, cls: CLS.step },
  { re: /^\[Pipeline\]/, cls: CLS.pipeline },
  // docker 进度行（会被原地覆盖，压暗处理）
  { re: /^[0-9a-f]{6,}:\s(pushing|pulling|downloading|extracting|waiting|preparing)/i, cls: CLS.dim },
];

/**
 * 词法高亮：只挑在构建日志里真的有用的两类 token。
 * - `sha256:<hex>`：镜像 digest
 * - 7~40 位纯十六进制：层 id / 提交 hash（**不区分大小写匹配**，但只认小写更稳，
 *   避免把 "Decade" 这种英文词也点亮）
 */
const TOKEN_RE = /(sha256:[0-9a-f]{8,}|\b[0-9a-f]{7,40}\b)/g;

function lineClass(line: string): string {
  for (const r of RULES) {
    if (r.re.test(line)) return r.cls;
  }
  return "";
}

/**
 * 把一行日志切成带类名的片段。
 *
 * 整行已经有语气（失败/成功/结构）时**不再做词法高亮**：否则两套颜色会打架
 * （比如失败行里的 hash 被点成琥珀色），而且这类行本来就不需要逐 token 看。
 */
export function highlightLine(line: string): LogSegment[] {
  if (!line) return [{ text: "", cls: "" }];

  const whole = lineClass(line);
  if (whole) return [{ text: line, cls: whole }];

  const out: LogSegment[] = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  for (const m of line.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ text: line.slice(last, at), cls: "" });
    out.push({ text: m[0], cls: CLS.hash });
    last = at + m[0].length;
  }
  if (last < line.length) out.push({ text: line.slice(last), cls: "" });
  return out.length ? out : [{ text: line, cls: "" }];
}

/**
 * 行级缓存的 `highlightLine`。
 *
 * 日志持续流入时每一帧都会重算已渲染的行；同一行文本的高亮结果是不变的，
 * 缓存能把「每帧 O(总行数) 次正则」降到只算新行。上限防止长时间构建把内存吃满。
 */
const cache = new Map<string, LogSegment[]>();
const CACHE_LIMIT = 5000;

export function highlightLineCached(line: string): LogSegment[] {
  const hit = cache.get(line);
  if (hit) return hit;
  const segs = highlightLine(line);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(line, segs);
  return segs;
}

/** 只给测试用 */
export function clearHighlightCache(): void {
  cache.clear();
}

/**
 * 在一段文本里标出搜索命中，返回片段。
 *
 * 与 `highlightLine` 的结果叠加使用：调用方先拿到高亮片段，再对每个片段调这里，
 * 命中处用黄底强调，`current` 用更亮的底色（当前定位到的那一行）。
 */
export const SEARCH_HIT_CLS = "bg-amber-400/30 text-amber-100 rounded-sm";
export const SEARCH_CURRENT_CLS = "bg-amber-400/70 text-black rounded-sm";

export function markMatches(
  text: string,
  query: string,
  cls: string,
): LogSegment[] {
  if (!text || !query) return [{ text, cls }];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const out: LogSegment[] = [];
  let last = 0;
  for (;;) {
    const at = lower.indexOf(q, last);
    if (at === -1) break;
    if (at > last) out.push({ text: text.slice(last, at), cls });
    out.push({ text: text.slice(at, at + q.length), cls: `${cls} ${SEARCH_HIT_CLS}`.trim() });
    last = at + q.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), cls });
  return out.length ? out : [{ text, cls }];
}
