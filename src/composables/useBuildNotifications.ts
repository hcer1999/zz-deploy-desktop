import { watch } from "vue";
import {
  isPermissionGranted,
  onAction,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";
import { setOpenLog } from "@/stores/tabPayload";
import type { DeployTask } from "@/api/parser";

export type BuildResult = "success" | "failed";

/**
 * 已经通知过的 (taskId, 终态) —— 去重。
 * 两个触发点（日志流结束、轮询发现状态跃迁）都会命中同一个任务，
 * 靠它保证只弹一条。
 *
 * 放在模块级而不是实例里：通知的触发点分散在多处，去重必须是全局的。
 */
const notified = new Set<string>();
/** 长时间运行时的防膨胀上限（老 key 已无去重价值） */
const NOTIFIED_CACHE_LIMIT = 500;

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** 服务端只给文案，没有结构化状态，只能按关键字判定终态 */
function terminalState(t: DeployTask): BuildResult | null {
  if (t.buildStatus.includes("成功")) return "success";
  if (t.buildStatus.includes("失败")) return "failed";
  return null;
}

function wasBuilding(status: string): boolean {
  return status.includes("中") || status.includes("等待");
}

/**
 * 构建完成通知（spec §6.2）。
 *
 * 两个触发点都要用，但必须去重：
 * 1. 日志流收到 finished（用户正开着日志标签）
 * 2. 任务列表轮询时发现某任务从"构建中"跃迁到终态
 */
export function useBuildNotifications() {
  const tasks = useTasksStore();
  const tabs = useTabsStore();
  const settings = useSettingsStore();

  /** 记录上一次看到的构建状态，用于 diff */
  let lastSeen = new Map<number, string>();

  function notifyOnce(t: DeployTask, state: BuildResult): void {
    const key = `${t.taskId}_${state}`;
    if (notified.has(key)) return;
    if (notified.size >= NOTIFIED_CACHE_LIMIT) notified.clear();
    notified.add(key);

    void (async () => {
      if (!(await ensurePermission())) return;
      // 触发条件由设置决定（spec §6.2）：默认仅窗口失焦时通知，
      // 避免你正看着界面还被弹；改成"始终通知"就一律弹。
      if (settings.notifyMode !== "always" && (await getCurrentWindow().isFocused())) return;
      sendNotification({
        // id 用 taskId：点击通知时靠它找回是哪个任务（见 focusTask）
        id: t.taskId,
        title: state === "success" ? "构建成功" : "构建失败",
        body: `${t.projectName} · ${t.envName}\n${t.title}`,
      });
    })();
  }

  /**
   * 触发点 1：日志流结束。
   *
   * 必须限定"轮询曾看到它在构建中"：回看一条历史日志时，服务端会把旧日志
   * 重放一遍并同样发 code=1，那不是一次构建完成，不该弹通知。
   */
  function onLogFinished(taskId: number): void {
    if (!wasBuilding(lastSeen.get(taskId) ?? "")) return;
    const t = tasks.tasks.find((x) => x.taskId === taskId);
    if (!t) return;
    const state = terminalState(t);
    if (state) notifyOnce(t, state);
  }

  /** 触发点 2：刷新后对比状态跃迁 */
  function diffAfterRefresh(): void {
    const next = new Map<number, string>();
    for (const t of tasks.tasks) {
      next.set(t.taskId, t.buildStatus);
      const before = lastSeen.get(t.taskId);
      // 只在"从非终态变为终态"时通知，避免启动时把历史任务全弹一遍
      if (before !== undefined && before !== t.buildStatus) {
        const state = terminalState(t);
        if (wasBuilding(before) && state) notifyOnce(t, state);
      }
    }
    lastSeen = next;
  }

  /**
   * 点通知 → 唤起窗口并打开该任务的日志标签（spec §6.2）。
   * 任务已不在当前列表（翻页/切换类型）时只唤起窗口。
   */
  async function focusTask(taskId: number): Promise<void> {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();

    const t = tasks.tasks.find((x) => x.taskId === taskId);
    if (!t) return;
    const payload = {
      taskId,
      deployType: tasks.deployType,
      projectName: t.projectName,
      envName: t.envName,
    };
    const id = tabs.open({ kind: "log", ...payload });
    setOpenLog(id, payload);
  }

  // 通知点击（桌面端 actionId 固定为 "tap"）
  void onAction((e) => {
    if (e.actionId === "tap" && e.notification) void focusTask(e.notification.id);
  });

  // 状态跃迁统一在这里 diff：轮询与手动刷新都会替换 tasks.tasks 的数组引用，
  // 因此不必在视图里显式调用——放视图里反而会漏掉轮询这条路径。
  watch(() => tasks.tasks, diffAfterRefresh);

  return { onLogFinished, diffAfterRefresh, focusTask };
}
