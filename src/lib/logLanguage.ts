/**
 * 构建日志的 zzlog 语言（Monaco Monarch 语法）。
 *
 * 规则与旧的 `logHighlight.ts` 完全一致：先给整行定语气（失败 / 警告 / 成功 /
 * 结构行 / 进度行），没有语气的行再点 hash / sha256。顺序有意义——一行同时含
 * 「构建失败」与「成功」时必须按失败显示（例如「构建失败！！没有成功产出」）。
 *
 * 为什么保留纯函数 `lineTone` / `tokenFor`：Monarch 语法在 jsdom 里跑不起来，
 * 把判定逻辑抽出来才能单测；语法规则由这两个函数生成，避免出现两套规则。
 */

export const LOG_LANGUAGE_ID = "zzlog";

export type LogTone = "" | "danger" | "warning" | "success" | "step" | "dim";

interface ToneRule {
  re: RegExp;
  tone: Exclude<LogTone, "">;
}

const TONE_RULES: ToneRule[] = [
  // 失败最关键：「构建失败！！」「npm ERR!」「Failed」「Cannot find」…
  {
    re: /(error|failed|failure|fatal|exception|traceback|npm err!|elifecycle|cannot find|not found|失败|错误|异常)/i,
    tone: "danger",
  },
  { re: /(warn|warning|deprecat|notice|警告)/i, tone: "warning" },
  { re: /(构建成功|success|successfully|finished: success|passed|✓|done in)/i, tone: "success" },
  // 结构行：Step 1/7、[Pipeline]、npm 脚本回显、shell 里带 + 的行
  { re: /^(step \d+\/\d+|\[pipeline\]|\+\s|>\s|#\s)/i, tone: "step" },
  // docker 进度行（会被原地覆盖，压暗处理）
  { re: /^[0-9a-f]{6,}:\s(pushing|pulling|downloading|extracting|waiting|preparing)/i, tone: "dim" },
];

/** 整行语气；没有语气返回空串 */
export function lineTone(line: string): LogTone {
  for (const r of TONE_RULES) {
    if (r.re.test(line)) return r.tone;
  }
  return "";
}

/** 词法层：只认 sha256 digest 与 7~40 位纯十六进制（层 id / 提交 hash） */
const TOKEN_RE = /(sha256:[0-9a-f]{8,}|\b[0-9a-f]{7,40}\b)/;

/**
 * 该行是否需要逐 token 上色。
 * 整行已有语气时返回空串：两套颜色会打架，而且这类行本来不需要逐个 token 看。
 */
export function tokenFor(line: string): "hash" | "" {
  if (lineTone(line)) return "";
  return TOKEN_RE.test(line) ? "hash" : "";
}

interface MonarchLanguage {
  tokenizer: Record<string, unknown[]>;
  defaultToken: string;
}

/**
 * 生成 Monarch 语法。
 *
 * 整行规则用 `^.*(关键词).*$` 表达：Monarch 逐行匹配，`^` 能固定到行首，
 * `.*$` 保证整行被同一个 token 覆盖（否则只有关键词那一段变色）。
 * 顺序与 TONE_RULES 一致——Monarch 取第一条命中的规则。
 */
export function monarchTokens(): MonarchLanguage {
  const wholeLine = TONE_RULES.map((r) => {
    const body = r.re.source.replace(/^\^/, "");
    return [new RegExp(`^.*${body}.*$`, r.re.flags.replace("g", "")), r.tone];
  });
  return {
    defaultToken: "source",
    tokenizer: {
      root: [...wholeLine, [TOKEN_RE, "hash"]],
    },
  };
}

/** Monaco 主题名（背景与现有日志区一致：近黑 #0b0d12） */
export const LOG_THEME = "zzlog-dark";

/**
 * 注册语言与主题。
 *
 * 参数用最小结构类型而不是 `typeof import("monaco-editor")`：
 * 单测里注入假实现即可验证注册顺序，不必加载真实 monaco。
 */
export function registerLogLanguage(monaco: {
  languages: {
    register(p: { id: string }): void;
    setMonarchTokensProvider(id: string, p: unknown): void;
  };
  editor: { defineTheme(id: string, t: unknown): void };
}): void {
  monaco.languages.register({ id: LOG_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LOG_LANGUAGE_ID, monarchTokens());
  monaco.editor.defineTheme(LOG_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "danger", foreground: "f87171" },
      { token: "warning", foreground: "fcd34d" },
      { token: "success", foreground: "34d399" },
      { token: "step", foreground: "7dd3fc" },
      { token: "dim", foreground: "9ca3af" },
      { token: "hash", foreground: "fde68a" },
    ],
    colors: {
      "editor.background": "#0b0d12",
      "editor.foreground": "#d4d4d4",
    },
  });
}
