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
import { useBuildNotifications } from "./composables/useBuildNotifications";
import { registerLogEvents } from "./composables/useLogEvents";
import { useShortcuts } from "./composables/useShortcuts";
import { ENVS } from "./api/deploy";

const tabs = useTabsStore();
const auth = useAuthStore();
const settings = useSettingsStore();
const theme = useThemeStore();
// 构建完成通知：本 composable 会在内部完成"状态跃迁 diff"与"通知点击"的订阅
const notify = useBuildNotifications();
// 应用级快捷键（Cmd/Ctrl+N/R/W/1-5/,）
useShortcuts();

onMounted(async () => {
  // 续登失败 → 弹回登录页
  await listen<string>("auth://expired", (e) => auth.handleExpired(e.payload));
  // Rust 启动时的静默续登结束 → 刷新一次真实状态
  await listen("auth://ready", () => auth.refresh());
  // 托盘菜单：Rust 只负责"显示窗口"，开哪个标签由前端决定
  await listen<string>("tray://command", (e) => {
    if (e.payload === "new_deploy") tabs.open({ kind: "wizard" });
    else if (e.payload === "task_list") tabs.open({ kind: "list" });
  });

  await settings.load();
  theme.apply(settings.theme);
  await auth.refresh();

  // 构建日志是事件流：Rust 推给所有 Webview，由 logs store 按 sessionId 分发；
  // 同一条 log://status 还要驱动构建完成通知，所以统一从一个入口订阅
  await registerLogEvents(notify);

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
