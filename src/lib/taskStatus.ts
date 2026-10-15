import type { DeployTask } from "@/api/parser";

export type BuildResult = "success" | "failed";

/**
 * 服务端只给文案、没有结构化状态，只能按关键字判定终态。
 * 判定规则与 `StatusBadge`/`TaskListView` 同一套约定（它们也按 `失败` 这种关键字）。
 */
export function terminalState(t: DeployTask): BuildResult | null {
  if (t.buildStatus.includes("成功")) return "success";
  if (t.buildStatus.includes("失败")) return "failed";
  return null;
}

/** 是否处于「还没盖棺定论」的状态：构建完成通知只在从它跃迁到终态时才弹 */
export function wasBuilding(status: string): boolean {
  return status.includes("中") || status.includes("等待");
}
