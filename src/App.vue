<script setup lang="ts">
import { computed, onMounted } from "vue";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import WipView from "./views/WipView.vue";
import LoginView from "./views/LoginView.vue";
import { useTabsStore } from "./stores/tabs";
import { useAuthStore } from "./stores/auth";

const tabs = useTabsStore();
const auth = useAuthStore();

const activeTitle = computed(() => (tabs.activeTab ? tabs.titleOf(tabs.activeTab) : ""));

onMounted(async () => {
  // 续登失败 → 弹回登录页
  await listen<string>("auth://expired", (e) => auth.handleExpired(e.payload));
  // Rust 启动时的静默续登结束 → 刷新一次真实状态
  await listen("auth://ready", () => auth.refresh());
  await auth.refresh();
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
          <WipView v-if="tabs.activeTab" :title="activeTitle" />
          <div v-else class="h-full flex items-center justify-center text-text-muted text-sm">
            从左侧导航打开一个页面
          </div>
        </main>
      </div>
    </div>
  </div>
</template>
