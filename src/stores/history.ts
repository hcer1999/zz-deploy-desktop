import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/api/history";
import type { HistoryEntry, HistoryTail } from "@/api/history";

export type { HistoryEntry, HistoryTail };

export const useHistoryStore = defineStore("history", () => {
  const entries = ref<HistoryEntry[]>([]);
  const totalSize = ref(0);
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      const r = await api.listHistory();
      entries.value = r.entries;
      totalSize.value = r.totalSize;
    } finally {
      loading.value = false;
    }
  }

  /** 读取单条正文（原始内容，未剥离 ANSI） */
  function readOne(deployType: string, taskId: number): Promise<string | null> {
    return api.readHistory(deployType, taskId);
  }

  /** 读取单条末尾一段（预览用，避免大日志整段穿过 IPC） */
  function readTail(
    deployType: string,
    taskId: number,
    maxBytes?: number,
  ): Promise<HistoryTail | null> {
    return api.readHistoryTail(deployType, taskId, maxBytes);
  }

  async function remove(deployType: string, taskId: number): Promise<void> {
    await api.deleteHistory(deployType, taskId);
    await load();
  }

  async function clear(): Promise<void> {
    await api.clearHistory();
    entries.value = [];
    totalSize.value = 0;
  }

  /** 设置页改了保留策略后调用：先清理再重新读数 */
  async function applyRetention(): Promise<number> {
    const removed = await api.applyHistoryRetention();
    await load();
    return removed;
  }

  return { entries, totalSize, loading, load, readOne, readTail, remove, clear, applyRetention };
});

// Pinia 的 HMR 支持。
// 没有它时，Vite 热更新只替换模块，**已创建的 store 实例仍是旧定义**，
// 表现为改了 store 却在界面上拿到 undefined 的方法
// （实测报错：tasks.refresh is not a function）。加这段后新定义立即生效。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHistoryStore, import.meta.hot));
}
