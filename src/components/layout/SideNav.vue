<script setup lang="ts">
import { History, List, PanelLeftClose, PanelLeftOpen, Plus, Settings, Star } from "@lucide/vue";
import type { Component } from "vue";
import { useTabsStore, type TabKind } from "@/stores/tabs";
import { useSettingsStore } from "@/stores/settings";

const tabs = useTabsStore();
const settings = useSettingsStore();

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

/**
 * 展开状态存 config.json 而不是组件本地：重启后要保持用户选的布局。
 * 走 settings.patch 的回填约定（见 stores/settings.ts），不会把别的字段写回默认值。
 */
function toggle(): void {
  void settings.patch({ sidebarExpanded: !settings.sidebarExpanded });
}
</script>

<template>
  <nav
    :class="[
      'shrink-0 flex flex-col gap-1 border-r border-border bg-surface py-2 transition-[width] duration-150',
      settings.sidebarExpanded ? 'w-[180px] px-2 items-stretch' : 'w-14 items-center',
    ]"
  >
    <button
      data-test="sidebar-toggle"
      :title="settings.sidebarExpanded ? '收起侧边栏' : '展开侧边栏'"
      :aria-label="settings.sidebarExpanded ? '收起侧边栏' : '展开侧边栏'"
      :class="[
        'h-9 rounded-md flex items-center gap-2 text-text-muted hover:bg-surface-2 hover:text-text transition-colors',
        settings.sidebarExpanded ? 'px-2 justify-start' : 'w-10 justify-center',
      ]"
      @click="toggle"
    >
      <component :is="settings.sidebarExpanded ? PanelLeftClose : PanelLeftOpen" :size="18" :stroke-width="1.8" />
      <span v-if="settings.sidebarExpanded" class="text-xs truncate">收起</span>
    </button>

    <button
      v-for="it in items"
      :key="it.kind"
      :title="it.label"
      :aria-label="it.label"
      :class="[
        'h-10 rounded-md flex items-center transition-colors',
        settings.sidebarExpanded ? 'px-2 gap-2 justify-start' : 'w-10 justify-center',
        isActive(it.kind)
          ? 'bg-primary/15 text-primary'
          : 'text-text-muted hover:bg-surface-2 hover:text-text',
      ]"
      @click="tabs.open({ kind: it.kind })"
    >
      <component :is="it.icon" :size="18" :stroke-width="1.8" />
      <span v-if="settings.sidebarExpanded" class="text-xs truncate">{{ it.label }}</span>
    </button>
  </nav>
</template>
