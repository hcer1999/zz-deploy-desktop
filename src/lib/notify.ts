import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useSettingsStore } from "@/stores/settings";

/**
 * 系统通知的统一出口。
 *
 * 抽成模块是因为有两个发送方：逐条构建完成通知（`useBuildNotifications`）
 * 与批量部署的汇总通知（`stores/batch.ts`）。权限申请与「要不要打扰用户」
 * 的判断必须只有一份，否则两边迟早会出现"一个遵守设置、一个不听"。
 */

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** 由设置决定：默认「始终通知」；改成「仅窗口失焦时」则窗口在前台就不弹 */
async function shouldNotify(): Promise<boolean> {
  const settings = useSettingsStore();
  if (settings.notifyMode === "always") return true;
  return !(await getCurrentWindow().isFocused());
}

/** 发一条系统通知。`id` 用于点击通知后定位任务（批量汇总没有单个任务，传 undefined） */
export async function sendSystemNotification(opts: {
  title: string;
  body: string;
  id?: number;
}): Promise<boolean> {
  if (!(await ensurePermission())) return false;
  if (!(await shouldNotify())) return false;
  sendNotification(opts);
  return true;
}
