/**
 * 标签页携带的参数暂存区。
 *
 * 为什么不放进 TabHost 的 props：标签参数只在"打开日志标签"那一刻需要，
 * 放进 props 会让每次标签变化都重渲染所有日志视图。
 * 也不放进 store：它不参与响应式渲染，只是给组件 onMounted 时取一次。
 */

export interface LogTabPayload {
  taskId: number;
  deployType: "auto" | "docker";
  projectName: string;
  envName: string;
}

const payloads = new Map<string, LogTabPayload>();

export function setOpenLog(tabId: string, payload: LogTabPayload): void {
  payloads.set(tabId, payload);
}

export function openLog(tabId: string): LogTabPayload | undefined {
  return payloads.get(tabId);
}

/** 标签关闭时清掉，避免长期运行下 Map 无限增长 */
export function clearTab(tabId: string): void {
  payloads.delete(tabId);
}
