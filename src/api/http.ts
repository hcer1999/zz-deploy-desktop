import { call } from "./ipc";
import { toAppError, isAuthError, toUserMessage, type AppError } from "./errors";

export interface HttpResult {
  status: number;
  /** 302 的跳转目标；语义判定见下方两个谓词 */
  location: string | null;
  body: string;
}

export type Query = Record<string, string | number> | undefined;
export type Form = Record<string, string>;

function toPairs(o: Record<string, string | number> | undefined): [string, string][] {
  if (!o) return [];
  return Object.entries(o).map(([k, v]) => [k, String(v)]);
}

const GET_RETRY_LIMIT = 2;
const RETRY_BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET 请求。
 *
 * 只有 GET 会自动重试（幂等）。POST 一律不重试——见 spec §6.6 的安全红线：
 * 提交部署 / 上线 / 回滚 / 删除都不可重复执行。
 */
export async function httpGet(path: string, query?: Query): Promise<HttpResult> {
  let last: AppError | null = null;
  for (let attempt = 0; attempt <= GET_RETRY_LIMIT; attempt++) {
    try {
      return await call<HttpResult>("http_request", {
        args: { method: "GET", path, query: toPairs(query), form: [] },
      });
    } catch (e) {
      const err = toAppError(e);
      last = err;
      // 认证类错误交给上层走重新登录流程，重试无意义
      if (isAuthError(err)) throw err;
      if (!err.retryable || attempt === GET_RETRY_LIMIT) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw last ?? toAppError("未知错误");
}

/** POST 请求，绝不重试 */
export async function httpPost(path: string, form?: Form): Promise<HttpResult> {
  return call<HttpResult>("http_request", {
    args: { method: "POST", path, query: [], form: toPairs(form) },
  });
}

/**
 * 302 指向登录页 = 会话过期（而非操作成功）。
 *
 * 与 Rust `net/redirect.rs::is_login_redirect` 是同一套判定，两边都要保持一致。
 * 只看 path 部分，避免 query 中出现的 `/login/` 造成误判。
 */
export function isLoginRedirect(r: HttpResult): boolean {
  if (r.status !== 302 || !r.location) return false;
  const path = r.location.split("?")[0].replace(/\/+$/, "");
  return path === "/login" || path === "login" || path.endsWith("/login");
}

/** 业务成功判定：302 且不是被踢到登录页 */
export function isSuccessRedirect(r: HttpResult): boolean {
  return r.status === 302 && !isLoginRedirect(r);
}

export { toUserMessage, toAppError, isAuthError };
export type { AppError };
