<script setup lang="ts">
import { ref } from "vue";
import { X } from "@lucide/vue";
import { useTabsStore } from "@/stores/tabs";
import { useLogsStore } from "@/stores/logs";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";

const tabs = useTabsStore();
const logs = useLogsStore();

const pendingClose = ref<string | null>(null);

/**
 * spec §5.2：日志处于"连接中/已连接"时关闭标签要二次确认——
 * 关掉就再也收不到这次构建的输出了（除非已落盘的能回看）。
 */
function isStreaming(tabId: string): boolean {
  const t = tabs.tabs.find((x) => x.id === tabId);
  if (!t || t.kind !== "log" || t.taskId === undefined) return false;
  return Object.values(logs.sessions).some(
    (s) => s.taskId === t.taskId && (s.state === "connected" || s.state === "connecting"),
  );
}

function requestClose(tabId: string): void {
  if (isStreaming(tabId)) {
    pendingClose.value = tabId;
    return;
  }
  tabs.close(tabId);
}
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
        @click.stop="requestClose(t.id)"
      >
        <X :size="12" />
      </button>
    </div>

    <div v-if="tabs.tabs.length === 0" class="flex items-center px-3 text-xs text-text-muted">
      从左侧导航打开一个页面
    </div>

    <ConfirmDialog
      :open="pendingClose !== null"
      title="日志仍在输出中，确认关闭？"
      description="关闭后将停止接收该任务的构建日志"
      confirm-text="关闭"
      danger
      @update:open="
        (v: boolean) => {
          if (!v) pendingClose = null;
        }
      "
      @confirm="
        () => {
          if (pendingClose) {
            tabs.close(pendingClose);
            pendingClose = null;
          }
        }
      "
    />
  </div>
</template>
