import { call } from "./ipc";

/**
 * 日志会话：`log_open` 立即返回 session_id，日志内容与状态通过
 * `log://data` / `log://status` 事件推送（spec §4.3）。
 * 写操作一律走 stores/logs.ts，视图不要直接调用。
 */
export function logOpen(params: {
  taskId: number;
  deployType: "auto" | "docker";
  projectName: string;
  envName: string;
}): Promise<string> {
  return call<string>("log_open", params);
}

export function logClose(sessionId: string): Promise<void> {
  return call<void>("log_close", { sessionId });
}

export interface LogDataEvent {
  sessionId: string;
  /**
   * 新增的日志内容。
   *
   * 注意服务端推的是**全量快照**（不是增量），Rust 侧已比对出增量再发过来，
   * 所以这里一律按「追加」处理；只有 `reset` 时才先清空。
   */
  chunk: string;
  /** 服务端换了窗口（快照不再包含已有内容）→ 先清空缓冲区再追加 */
  reset: boolean;
}

export interface LogStatusEvent {
  sessionId: string;
  state: "connected" | "disconnected" | "finished" | "error";
  /** 服务端的原话（如 `数据格式错误`），有就展示出来，不再把错误吞掉 */
  detail?: string;
}
