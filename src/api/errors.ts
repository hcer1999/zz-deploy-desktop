/** 与 Rust `src-tauri/src/error.rs` 的 AppError 一一对应，两边字段必须同步修改 */
export type ErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "parse"
  | "server"
  | "config"
  | "io";

export interface AppError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
}

const FRIENDLY: Record<ErrorKind, string> = {
  network: "网络不可达，请检查内网连接或 VPN",
  timeout: "请求超时，请稍后重试",
  auth: "登录状态已失效，请重新登录",
  parse: "页面结构解析失败，ITSM 可能已改版",
  server: "服务端返回错误，请稍后重试",
  config: "配置有误，请到设置页检查",
  io: "本地读写失败，请检查磁盘权限",
};

function isAppError(v: unknown): v is AppError {
  if (typeof v !== "object" || v === null) return false;
  const k = (v as AppError).kind;
  return typeof k === "string" && k in FRIENDLY;
}

export function isAuthError(v: unknown): boolean {
  return isAppError(v) && v.kind === "auth";
}

/** 把任意抛出物归一成 AppError，便于统一处理 */
export function toAppError(v: unknown): AppError {
  if (isAppError(v)) return v;
  return {
    kind: "server",
    message: v instanceof Error ? v.message : String(v),
    retryable: false,
  };
}

/**
 * 转成给用户看的一句话。
 * 原始信息附在后面，方便排障时直接看到底层报错。
 */
export function toUserMessage(v: unknown): string {
  if (!isAppError(v)) {
    const raw = v instanceof Error ? v.message : typeof v === "string" ? v : "";
    return raw ? `${FRIENDLY.server}（${raw}）` : "发生未知错误";
  }
  return v.message ? `${FRIENDLY[v.kind]}（${v.message}）` : FRIENDLY[v.kind];
}
