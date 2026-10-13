import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import * as authApi from "@/api/auth";

export const useAuthStore = defineStore("auth", () => {
  const loggedIn = ref(false);
  const username = ref("");
  const baseUrl = ref("https://itsm.zhizhengroup.com");
  const credentialBackend = ref<"encryptedFile">("encryptedFile");
  const credentialPath = ref("");
  const loading = ref(false);
  const error = ref("");

  /** 从 Rust 侧同步真实状态。启动、登录成功后、收到 auth://ready 时都会调 */
  async function refresh(): Promise<void> {
    const s = await authApi.getAuthStatus();
    loggedIn.value = s.loggedIn;
    username.value = s.username;
    baseUrl.value = s.baseUrl;
    credentialBackend.value = s.credentialBackend;
    credentialPath.value = s.credentialPath;
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
    credentialPath,
    loading,
    error,
    refresh,
    login,
    logout,
    handleExpired,
  };
});

// Pinia 的 HMR 支持。
// 没有它时，Vite 热更新只替换模块，**已创建的 store 实例仍是旧定义**，
// 表现为改了 store 却在界面上拿到 undefined 的方法
// （实测报错：tasks.refresh is not a function）。加这段后新定义立即生效。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAuthStore, import.meta.hot));
}
