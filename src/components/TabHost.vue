<script setup lang="ts">
import DeployWizard from "@/views/DeployWizard.vue";
import TaskListView from "@/views/TaskListView.vue";
import FavoritesView from "@/views/FavoritesView.vue";
import SettingsView from "@/views/SettingsView.vue";
import WipView from "@/views/WipView.vue";
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();
</script>

<template>
  <!--
    所有标签同时挂载，非激活的用 v-show 隐藏。
    这样每个向导标签的已选环境/项目/分支都能保留，切换标签不会丢；
    日志标签（Plan 3）也需要这个特性才能在后台继续收 WebSocket。

    注意：因为用的是 v-show 而非 <KeepAlive>，组件不会 deactivate，
    需要感知"是否可见"的地方要监听 tabs.activeId（见 TaskListView 的轮询）。
  -->
  <div v-for="t in tabs.tabs" v-show="tabs.activeId === t.id" :key="t.id" class="h-full">
    <DeployWizard v-if="t.kind === 'wizard'" />
    <TaskListView v-else-if="t.kind === 'list'" />
    <FavoritesView v-else-if="t.kind === 'favorites'" />
    <SettingsView v-else-if="t.kind === 'settings'" />
    <WipView v-else :title="tabs.titleOf(t)" />
  </div>
</template>
