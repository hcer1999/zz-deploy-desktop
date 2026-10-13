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
  chunk: string;
}

export interface LogStatusEvent {
  sessionId: string;
  state: "connected" | "disconnected" | "finished" | "error";
}
