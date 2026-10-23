import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import * as api from "@/api/update";
import type { UpdateInfo } from "@/api/update";
import { toUserMessage } from "@/api/errors";

const DISMISS_KEY = "zz-deploy:update-dismissed";

function readDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) ?? "";
  } catch {
    // 隐私模式 / 非浏览器环境：忽略即可，只是每次启动都会再提示一次
    return "";
  }
}

function writeDismissed(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {
    // 同上
  }
}

export type UpdatePhase = "idle" | "downloading" | "installing" | "ready";

/**
 * 更新检测与**客户端内安装**状态。
 *
 * 流程：启动静默检查 → 有新版显示提示条 → 用户点「立即更新」→
 * 客户端下载并安装（带签名校验）→ 提示「重启完成更新」。
 *
 * 不在后台自动重启：用户可能正在跑构建 / 看日志。Windows 安装器启动后
 * 应用会自行退出，其余平台等用户点重启。
 */
export const useUpdateStore = defineStore("update", () => {
  const info = ref<UpdateInfo | null>(null);
  const checking = ref(false);
  const installing = ref(false);
  const installed = ref(false);
  const phase = ref<UpdatePhase>("idle");
  /** 0-100；总大小未知时为 0（界面显示不确定进度） */
  const progress = ref(0);
  const downloaded = ref(0);
  const total = ref(0);
  const error = ref("");
  const checkedAt = ref(0);
  const dismissedVersion = ref(readDismissed());
  let inflight: Promise<void> | null = null;

  const available = computed(() => info.value?.available === true);

  /** 用户没主动忽略这个版本时才显示提示条 */
  const showBanner = computed(
    () => available.value && info.value?.latestVersion !== dismissedVersion.value,
  );

  async function runCheck(): Promise<void> {
    checking.value = true;
    error.value = "";
    try {
      const found = await api.checkUpdate();
      info.value = found;
      checkedAt.value = Date.now();
    } catch (e) {
      error.value = toUserMessage(e);
    } finally {
      checking.value = false;
      inflight = null;
    }
  }

  /** 并发调用（启动检查 + 用户点按钮）合并成一次请求 */
  function check(): Promise<void> {
    return inflight ?? (inflight = runCheck());
  }

  /** 下载并安装更新（不自动重启） */
  async function install(): Promise<void> {
    if (!available.value || installing.value || installed.value) return;
    installing.value = true;
    error.value = "";
    phase.value = "downloading";
    progress.value = 0;
    downloaded.value = 0;
    total.value = 0;

    try {
      await api.installUpdate((p) => {
        phase.value = p.phase;
        downloaded.value = p.downloaded;
        total.value = p.total;
        progress.value = p.total > 0 ? Math.min(100, Math.round((p.downloaded / p.total) * 100)) : 0;
      });
      installed.value = true;
      phase.value = "ready";
      progress.value = 100;
    } catch (e) {
      error.value = toUserMessage(e);
      phase.value = "idle";
    } finally {
      installing.value = false;
    }
  }

  /** 重启应用让新版本生效（macOS / Linux 必须；Windows 通常安装器已自动重启） */
  async function restart(): Promise<void> {
    try {
      await api.restartApp();
    } catch (e) {
      error.value = toUserMessage(e);
    }
  }

  /** 忽略当前这个版本；下次发更高版本会重新提示 */
  function dismiss(): void {
    const v = info.value?.latestVersion;
    if (!v) return;
    dismissedVersion.value = v;
    writeDismissed(v);
    void api.discardUpdate();
  }

  /** 仅测试用：清空状态 */
  function reset(): void {
    info.value = null;
    checking.value = false;
    installing.value = false;
    installed.value = false;
    phase.value = "idle";
    progress.value = 0;
    downloaded.value = 0;
    total.value = 0;
    error.value = "";
    checkedAt.value = 0;
    inflight = null;
    dismissedVersion.value = "";
    writeDismissed("");
    void api.discardUpdate();
  }

  return {
    info,
    checking,
    installing,
    installed,
    phase,
    progress,
    downloaded,
    total,
    error,
    checkedAt,
    dismissedVersion,
    available,
    showBanner,
    check,
    install,
    restart,
    dismiss,
    reset,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUpdateStore, import.meta.hot));
}
