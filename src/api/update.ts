import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * 客户端内更新（Tauri updater）。
 *
 * 与「打开浏览器下载 dmg」的区别：
 * - 清单里的安装包由 updater 带 Tauri 签名（minisign）校验，**不通过就拒绝安装**
 * - 下载、替换、重启都在客户端内完成，用户不需要自己去下载新包
 *
 * 注意：这里只做「检测 / 下载安装 / 重启」，是否提示、何时安装由 store 决定。
 */

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  notes: string;
  publishedAt: string | null;
}

export interface InstallProgress {
  phase: "downloading" | "installing";
  downloaded: number;
  total: number;
}

/** 已检查到、等待安装的更新由插件持有（Rust 侧资源），不要放进 Vue 响应式对象 */
let pendingUpdate: Update | null = null;

/**
 * 没有发布 latest.json 时插件会抛 `ReleaseNotFound` / 无效 release JSON。
 * 这等价于「暂无新版本」，不该在界面上显示成故障。
 */
function isNoReleaseError(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e);
  return /release.?not.?found|valid release|404/i.test(msg);
}

export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (pendingUpdate) {
    const old = pendingUpdate;
    pendingUpdate = null;
    await old.close().catch(() => {});
  }

  let update: Update | null;
  try {
    update = await check();
  } catch (e) {
    if (isNoReleaseError(e)) return null;
    throw e;
  }
  if (!update) return null;

  pendingUpdate = update;
  return {
    currentVersion: update.currentVersion,
    latestVersion: update.version,
    available: true,
    notes: update.body ?? "",
    publishedAt: update.date ?? null,
  };
}

/**
 * 下载并安装已经检查到的更新。
 *
 * 平台差异（由 Tauri 处理）：
 * - Windows：安装器启动后应用会自动退出，随后由安装器重新拉起
 * - macOS / Linux：替换完成后需要调用 `restartApp` 重启才生效
 */
export async function installUpdate(
  onProgress: (p: InstallProgress) => void,
): Promise<void> {
  const update = pendingUpdate;
  if (!update) throw new Error("没有待安装的更新");

  let downloaded = 0;
  let total = 0;

  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? 0;
      onProgress({ phase: "downloading", downloaded, total });
      return;
    }
    if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
      onProgress({ phase: "downloading", downloaded, total });
      return;
    }
    onProgress({ phase: "installing", downloaded, total });
  });

  pendingUpdate = null;
}

/** 用刚安装的新版本重启应用 */
export async function restartApp(): Promise<void> {
  await relaunch();
}

/** 用户忽略某个版本时释放 Rust 侧的更新资源 */
export async function discardUpdate(): Promise<void> {
  if (!pendingUpdate) return;
  const old = pendingUpdate;
  pendingUpdate = null;
  await old.close().catch(() => {});
}
