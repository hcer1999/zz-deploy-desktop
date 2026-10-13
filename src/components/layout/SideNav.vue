<script setup lang="ts">
import { History, List, Plus, Settings, Star } from "@lucide/vue";
import type { Component } from "vue";
import { useTabsStore, type TabKind } from "@/stores/tabs";

const tabs = useTabsStore();

const items: { kind: TabKind; label: string; icon: Component }[] = [
  { kind: "wizard", label: "新建部署", icon: Plus },
  { kind: "favorites", label: "收藏", icon: Star },
  { kind: "list", label: "任务列表", icon: List },
  { kind: "history", label: "历史日志", icon: History },
  { kind: "settings", label: "设置", icon: Settings },
];

function isActive(kind: TabKind): boolean {
  const t = tabs.activeTab;
  if (!t) return false;
  return kind === "wizard" ? t.kind === "wizard" : t.kind === kind;
}
</script>

<template>
  <nav class="w-14 shrink-0 flex flex-col items-center gap-1 border-r border-border bg-surface py-2">
    <button
      v-for="it in items"
      :key="it.kind"
      :title="it.label"
      :aria-label="it.label"
      :class="[
        'w-10 h-10 rounded-md flex items-center justify-center transition-colors',
        isActive(it.kind)
          ? 'bg-primary/15 text-primary'
          : 'text-text-muted hover:bg-surface-2 hover:text-text',
      ]"
      @click="tabs.open({ kind: it.kind })"
    >
      <component :is="it.icon" :size="18" :stroke-width="1.8" />
    </button>
  </nav>
</template>
