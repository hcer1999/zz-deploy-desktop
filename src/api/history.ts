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

export interface HistoryTail {
  /** 原始日志正文（含 ANSI），已从最后一行的开头对齐 */
  text: string;
  /** 文件比请求的 max_bytes 大，text 只是末尾一段 */
  truncated: boolean;
}

export function listHistory(): Promise<HistoryOverview> {
  return call<HistoryOverview>("history_list");
}

/** 返回原始日志正文（含 ANSI 转义码），显示前需要过 stripAnsi */
export function readHistory(deployType: string, taskId: number): Promise<string | null> {
  return call<string | null>("history_read", { deployType, taskId });
}

/**
 * 只读日志末尾的一段（预览用）。
 *
 * 大日志整段读进来会在前端同步解析几秒；预览只需要最后几千行，
 * 默认最多读 2MB。导出等需要全文的场景仍然用 readHistory。
 */
export function readHistoryTail(
  deployType: string,
  taskId: number,
  maxBytes = 2 * 1024 * 1024,
): Promise<HistoryTail | null> {
  return call<HistoryTail | null>("history_read_tail", { deployType, taskId, maxBytes });
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
