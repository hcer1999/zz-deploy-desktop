<script setup lang="ts">
import { computed, ref } from "vue";
import { X } from "@lucide/vue";
import { useTabsStore } from "@/stores/tabs";
import { useLogsStore } from "@/stores/logs";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

const tabs = useTabsStore();
const logs = useLogsStore();

const pendingClose = ref<string | null>(null);
/** 批量关闭时待确认的集合；null 表示没有待确认的批量操作 */
const pendingMany = ref<{ ids: string[]; streaming: number } | null>(null);

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

/**
 * 批量关闭走一次确认而不是逐个弹。
 *
 * 逐个确认会在关掉 5 个标签时连弹 5 次，用户根本记不住关到了第几个；
 * 这里把"其中几个还在输出"一次说清，确认后一把关掉。
 */
function requestCloseMany(ids: string[]): void {
  if (ids.length === 0) return;
  const streaming = ids.filter(isStreaming).length;
  if (streaming > 0) {
    pendingMany.value = { ids, streaming };
    return;
  }
  tabs.closeMany(ids);
}

/** 菜单项里的「右侧标签」：数组顺序即视觉顺序（标签栏不换位） */
function tabsRightOf(id: string): string[] {
  const idx = tabs.tabs.findIndex((t) => t.id === id);
  if (idx < 0) return [];
  return tabs.tabs.slice(idx + 1).map((t) => t.id);
}

function tabsExcept(id: string): string[] {
  return tabs.tabs.filter((t) => t.id !== id).map((t) => t.id);
}

const onlyOne = computed(() => tabs.tabs.length <= 1);
</script>

<template>
  <div class="h-9 shrink-0 flex items-stretch border-b border-border bg-surface overflow-x-auto">
    <ContextMenu v-for="(t, index) in tabs.tabs" :key="t.id">
      <ContextMenuTrigger as="div" class="contents">
        <div
          data-test="tab"
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
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem @select="requestClose(t.id)">关闭</ContextMenuItem>
        <ContextMenuItem :disabled="onlyOne" @select="requestCloseMany(tabsExcept(t.id))">
          关闭其它标签
        </ContextMenuItem>
        <ContextMenuItem
          :disabled="index === tabs.tabs.length - 1"
          @select="requestCloseMany(tabsRightOf(t.id))"
        >
          关闭右侧标签
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem @select="requestCloseMany(tabs.tabs.map((x) => x.id))">
          关闭全部标签
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

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

    <ConfirmDialog
      :open="pendingMany !== null"
      title="有日志仍在输出中，确认关闭？"
      :description="
        pendingMany
          ? `其中 ${pendingMany.streaming} 个日志仍在输出，关闭后将停止接收这些任务的构建日志`
          : ''
      "
      confirm-text="关闭"
      danger
      @update:open="
        (v: boolean) => {
          if (!v) pendingMany = null;
        }
      "
      @confirm="
        () => {
          if (pendingMany) {
            tabs.closeMany(pendingMany.ids);
            pendingMany = null;
          }
        }
      "
    />
  </div>
</template>
