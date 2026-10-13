<script setup lang="ts">
import { X } from "@lucide/vue";
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();
</script>

<template>
  <div class="h-9 shrink-0 flex items-stretch border-b border-border bg-surface overflow-x-auto">
    <div
      v-for="t in tabs.tabs"
      :key="t.id"
      :class="[
        'group flex items-center gap-1.5 pl-3 pr-1 text-xs border-r border-border cursor-pointer whitespace-nowrap transition-colors',
        tabs.activeId === t.id ? 'bg-bg text-text' : 'text-text-muted hover:bg-surface-2',
      ]"
      @click="tabs.focus(t.id)"
    >
      <span>{{ tabs.titleOf(t) }}</span>
      <button
        class="w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-surface-2 hover:text-danger transition-opacity"
        :title="`关闭 ${tabs.titleOf(t)}`"
        @click.stop="tabs.close(t.id)"
      >
        <X :size="12" />
      </button>
    </div>

    <div v-if="tabs.tabs.length === 0" class="flex items-center px-3 text-xs text-text-muted">
      从左侧导航打开一个页面
    </div>
  </div>
</template>
