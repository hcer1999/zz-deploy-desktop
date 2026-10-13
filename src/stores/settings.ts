import { defineStore } from "pinia";
import { ref } from "vue";
import * as configApi from "@/api/config";
import * as authApi from "@/api/auth";
import { useAuthStore } from "./auth";

export type ThemeMode = "system" | "dark" | "light";
export type CloseBehavior = "tray" | "quit";

/**
 * 持久化配置的**唯一持有者**（baseUrl、主题、关闭行为、轮询间隔）。
 *
 * 约定：所有写操作完成后都要以 Rust 侧为权威重新读回（见 changeBaseUrl / patch），
 * 避免内存里的缓存与磁盘上的真值漂移。
 *
 * 历史教训：早期把 baseUrl 同时放在 auth store 与 settings store，
 * 在登录页改了地址后设置页仍显示旧值——两个 store 互不知情。
 */
export const useSettingsStore = defineStore("settings", () => {
  const baseUrl = ref("https://itsm.zhizhengroup.com");
  const theme = ref<ThemeMode>("system");
  const username = ref("");
  const closeBehavior = ref<CloseBehavior>("tray");
  const pollIntervalSecs = ref(60);
  const loaded = ref(false);

  function apply(c: configApi.AppConfig): void {
    baseUrl.value = c.baseUrl;
    theme.value = c.theme;
    username.value = c.username;
    closeBehavior.value = c.closeBehavior;
    pollIntervalSecs.value = c.pollIntervalSecs;
    loaded.value = true;
  }

  /** 从 Rust 侧读回全部配置。每次打开设置页都应调用，保证不是陈旧的缓存 */
  async function load(): Promise<void> {
    apply(await configApi.getConfig());
  }

  /**
   * 修改 ITSM 地址。
   *
   * 走专门的 `set_base_url` 命令（它会在 Rust 侧重建 HttpClient，
   * 因为旧 Cookie 对新域名没有意义），随后重新读回并同步 auth store。
   */
  async function changeBaseUrl(url: string): Promise<void> {
    await authApi.setBaseUrl(url.trim());
    await load();
    await useAuthStore().refresh();
  }

  /**
   * 提交除 baseUrl 外的配置变更。
   *
   * Rust 侧的 config_set 接收的是**完整** AppConfig，因此未指定的字段必须回填当前值，
   * 少传一个就会被写成默认值（早期把 username 写成 `partial.username ?? ""`，
   * 结果「改主题会把登录用户名清空」）。
   *
   * baseUrl 不在这里改——它有独立的 changeBaseUrl 通道，那里会重建 HTTP 客户端。
   */
  async function patch(partial: Omit<Partial<configApi.AppConfig>, "baseUrl">): Promise<void> {
    const next = await configApi.setConfig({
      baseUrl: baseUrl.value,
      theme: partial.theme ?? theme.value,
      username: partial.username ?? username.value,
      closeBehavior: partial.closeBehavior ?? closeBehavior.value,
      pollIntervalSecs: partial.pollIntervalSecs ?? pollIntervalSecs.value,
    });
    apply(next);
  }

  return {
    baseUrl,
    theme,
    username,
    closeBehavior,
    pollIntervalSecs,
    loaded,
    load,
    changeBaseUrl,
    patch,
  };
});
