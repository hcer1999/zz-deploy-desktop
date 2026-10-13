import { listen } from "@tauri-apps/api/event";
import type { LogDataEvent, LogStatusEvent } from "@/api/log";
import { useLogsStore } from "@/stores/logs";
import type { useBuildNotifications } from "./useBuildNotifications";

type Notifications = ReturnType<typeof useBuildNotifications>;

/**
 * 日志事件的**唯一**订阅入口。
 *
 * `log://status` 有两个消费者：logs store（更新标签状态）与通知（构建完成时弹窗）。
 * 两处各自 listen 同一事件容易写成互相覆盖（后注册的 unlisten 掉前面的），
 * 所以统一在这里订阅、再分发。
 */
export async function registerLogEvents(notify: Notifications): Promise<void> {
  const logs = useLogsStore();

  await listen<LogDataEvent>("log://data", (e) => logs.onData(e.payload));
  await listen<LogStatusEvent>("log://status", (e) => {
    // 必须在 onStatus 之前取 taskId：会话若已关闭，之后就拿不到了
    const taskId = logs.sessions[e.payload.sessionId]?.taskId;
    logs.onStatus(e.payload);
    if (e.payload.state === "finished" && taskId !== undefined) {
      notify.onLogFinished(taskId);
    }
  });
}
