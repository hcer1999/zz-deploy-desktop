<script setup lang="ts">
import { onMounted } from "vue";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import TabHost from "./components/TabHost.vue";
import LoginView from "./views/LoginView.vue";
import { useTabsStore } from "./stores/tabs";
import { useAuthStore } from "./stores/auth";
import { useSettingsStore } from "./stores/settings";
import { useThemeStore } from "./stores/theme";
import { useFavoritesStore } from "./stores/favorites";
import { useLogsStore } from "./stores/logs";
import { ENVS } from "./api/deploy";
import type { LogDataEvent, LogStatusEvent } from "./api/log";

const tabs = useTabsStore();
const auth = useAuthStore();
const settings = useSettingsStore();
const theme = useThemeStore();

onMounted(async () => {
  // 续登失败 → 弹回登录页
  await listen<string>("auth://expired", (e) => auth.handleExpired(e.payload));
  // Rust 启动时的静默续登结束 → 刷新一次真实状态
  await listen("auth://ready", () => auth.refresh());

  await settings.load();
  theme.apply(settings.theme);
  await auth.refresh();

  // 构建日志是事件流：Rust 推给所有 Webview，由 logs store 按 sessionId 分发
  const logs = useLogsStore();
  await listen<LogDataEvent>("log://data", (e) => logs.onData(e.payload));
  await listen<LogStatusEvent>("log://status", (e) => logs.onStatus(e.payload));

  const favorites = useFavoritesStore();
  await favorites.load();
  // 环境列表是硬编码的，用最新名字刷新收藏里存的旧环境名
  favorites.refreshEnvNames(ENVS);
});
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />

    <LoginView v-if="!auth.loggedIn" />

    <div v-else class="flex-1 flex min-h-0">
      <SideNav />
      <div class="flex-1 flex flex-col min-w-0">
        <TabBar />
        <main class="flex-1 min-h-0 overflow-auto">
          <TabHost v-if="tabs.tabs.length > 0" />
          <div v-else class="h-full flex items-center justify-center text-text-muted text-sm">
            从左侧导航打开一个页面
          </div>
        </main>
      </div>
    </div>
  </div>
</template>
