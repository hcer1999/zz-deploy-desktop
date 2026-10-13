<script setup lang="ts">
import { computed } from "vue";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import WipView from "./views/WipView.vue";
import { useTabsStore } from "./stores/tabs";

const tabs = useTabsStore();

const activeTitle = computed(() => (tabs.activeTab ? tabs.titleOf(tabs.activeTab) : ""));
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />

    <div class="flex-1 flex min-h-0">
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
