import { call } from "./ipc";

export interface HistoryEntry {
  taskId: number;
  deployType: "auto" | "docker";
  projectName: string;
  envName: string;
  /** 首次订阅的毫秒时间戳 */
  startedAt: number;
  size: number;
}

export interface HistoryOverview {
  entries: HistoryEntry[];
  totalSize: number;
}

export function listHistory(): Promise<HistoryOverview> {
  return call<HistoryOverview>("history_list");
}

/** 返回原始日志正文（含 ANSI 转义码），显示前需要过 stripAnsi */
export function readHistory(deployType: string, taskId: number): Promise<string | null> {
  return call<string | null>("history_read", { deployType, taskId });
}

export function deleteHistory(deployType: string, taskId: number): Promise<void> {
  return call<void>("history_delete", { deployType, taskId });
}

export function clearHistory(): Promise<void> {
  return call<void>("history_clear");
}

/** 按当前保留策略清理，返回被淘汰的条数 */
export function applyHistoryRetention(): Promise<number> {
  return call<number>("history_apply_retention");
}

/** dest 由保存对话框给出，content 是已剥离 ANSI 的文本 */
export function exportHistory(dest: string, content: string): Promise<void> {
  return call<void>("history_export", { dest, content });
}
