import { defineStore } from "pinia";
import { ref } from "vue";
import * as authApi from "@/api/auth";

export const useAuthStore = defineStore("auth", () => {
  const loggedIn = ref(false);
  const username = ref("");
  const baseUrl = ref("https://itsm.zhizhengroup.com");
  const credentialBackend = ref<"keyring" | "encryptedFile">("keyring");
  const loading = ref(false);
  const error = ref("");

  /** 从 Rust 侧同步真实状态。启动、登录成功后、收到 auth://ready 时都会调 */
  async function refresh(): Promise<void> {
    const s = await authApi.getAuthStatus();
    loggedIn.value = s.loggedIn;
    username.value = s.username;
    baseUrl.value = s.baseUrl;
    credentialBackend.value = s.credentialBackend;
  }

  async function login(user: string, password: string, remember: boolean): Promise<boolean> {
    loading.value = true;
    error.value = "";
    try {
      const r = await authApi.login(user, password, remember);
      if (r.ok) {
        loggedIn.value = true;
        username.value = user;
        await refresh();
      } else {
        error.value = r.message || "登录失败";
      }
      return r.ok;
    } finally {
      // 抛异常时也要复位，否则按钮会一直卡在「登录中」
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    await authApi.logout();
    loggedIn.value = false;
    username.value = "";
    error.value = "";
  }

  async function changeBaseUrl(url: string): Promise<void> {
    await authApi.setBaseUrl(url);
    baseUrl.value = url.replace(/\/$/, "");
  }

  /** 收到 Rust 的 auth://expired 事件时调用 */
  function handleExpired(reason: string): void {
    loggedIn.value = false;
    error.value = reason || "登录状态已失效，请重新登录";
  }

  return {
    loggedIn,
    username,
    baseUrl,
    credentialBackend,
    loading,
    error,
    refresh,
    login,
    logout,
    changeBaseUrl,
    handleExpired,
  };
});
