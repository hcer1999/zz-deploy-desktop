<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { useHistoryStore } from "@/stores/history";
import { useTabsStore } from "@/stores/tabs";
import { setOpenLog } from "@/stores/tabPayload";
import { stripAnsi } from "@/lib/ansi";
import { toUserMessage } from "@/api/http";
import { exportHistory } from "@/api/history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";

const history = useHistoryStore();
const tabs = useTabsStore();

const search = ref("");
const openKey = ref("");
const openText = ref("");
const openLoading = ref(false);
const flash = ref("");
const clearing = ref(false);
const pendingClear = ref(false);

onMounted(() => void history.load());

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return history.entries;
  return history.entries.filter((e) =>
    [e.projectName, e.envName, String(e.taskId)].some((s) => s.toLowerCase().includes(q)),
  );
});

function keyOf(e: { deployType: string; taskId: number }): string {
  return `${e.deployType}_${e.taskId}`;
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function timeText(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN");
}

function showFlash(msg: string): void {
  flash.value = msg;
  setTimeout(() => (flash.value = ""), 2500);
}

async function toggle(e: { deployType: "auto" | "docker"; taskId: number }): Promise<void> {
  const k = keyOf(e);
  if (openKey.value === k) {
    openKey.value = "";
    return;
  }
  openKey.value = k;
  openText.value = "";
  openLoading.value = true;
  try {
    // 留存的是原始内容，渲染前剥离 ANSI（与实时日志同一套逻辑）
    const raw = await history.readOne(e.deployType, e.taskId);
    openText.value = raw === null ? "（日志文件已不存在）" : stripAnsi(raw);
  } catch (err) {
    openText.value = toUserMessage(err);
  } finally {
    openLoading.value = false;
  }
}

/** 导出用户看到的内容（已剥离 ANSI），而不是带转义码的原始文件 */
async function exportOne(e: {
  deployType: "auto" | "docker";
  taskId: number;
  projectName: string;
}): Promise<void> {
  try {
    const raw = await history.readOne(e.deployType, e.taskId);
    if (raw === null) {
      showFlash("日志文件已不存在");
      return;
    }
    const dest = await save({
      defaultPath: `${e.projectName}_${e.taskId}.log`,
      filters: [{ name: "日志文件", extensions: ["log", "txt"] }],
    });
    if (!dest) return;
    await exportHistory(dest, stripAnsi(raw));
    showFlash("已导出");
  } catch (err) {
    showFlash(toUserMessage(err));
  }
}

/** 在日志标签里打开这条任务：服务端会把已完成的构建日志从头重放一次 */
function openLive(e: {
  taskId: number;
  projectName: string;
  envName: string;
  deployType: "auto" | "docker";
}): void {
  const payload = {
    taskId: e.taskId,
    deployType: e.deployType,
    projectName: e.projectName,
    envName: e.envName,
  };
  const id = tabs.open({ kind: "log", ...payload });
  setOpenLog(id, payload);
}

async function removeOne(e: { deployType: "auto" | "docker"; taskId: number }): Promise<void> {
  try {
    await history.remove(e.deployType, e.taskId);
    if (openKey.value === keyOf(e)) openKey.value = "";
    showFlash("已删除");
  } catch (err) {
    showFlash(toUserMessage(err));
  }
}

async function doClear(): Promise<void> {
  clearing.value = true;
  try {
    await history.clear();
    openKey.value = "";
    pendingClear.value = false;
    showFlash("已清空全部日志");
  } catch (err) {
    showFlash(toUserMessage(err));
  } finally {
    clearing.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-base font-semibold">历史日志</h1>
      <span class="text-[11px] text-text-muted">
        {{ history.entries.length }} 条 · 占用 {{ sizeText(history.totalSize) }}
      </span>
      <Input v-model="search" placeholder="搜索项目 / 环境 / 任务号…" class="w-56 h-8" />
      <Button variant="outline" size="sm" :disabled="history.loading" @click="history.load()">
        {{ history.loading ? "加载中…" : "刷新" }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="text-danger hover:text-danger"
        :disabled="history.entries.length === 0"
        @click="pendingClear = true"
      >
        清空全部
      </Button>
    </div>

    <p class="text-[11px] text-text-muted">
      只留存你**主动打开过**日志的任务（spec §6.3），不会把全站日志拉下来。
    </p>

    <div
      v-if="filtered.length === 0 && !history.loading"
      class="text-xs text-text-muted py-8 text-center"
    >
      {{ history.entries.length === 0 ? "还没有留存任何日志" : "没有匹配的日志" }}
    </div>

    <ul v-else class="space-y-1.5">
      <li v-for="e in filtered" :key="keyOf(e)" class="rounded-md border border-border bg-surface">
        <div class="flex items-center gap-3 px-3 py-2 text-xs">
          <button class="flex-1 min-w-0 text-left" @click="toggle(e)">
            <span class="font-medium">{{ e.projectName }}</span>
            <span class="text-text-muted"> · {{ e.envName }} · #{{ e.taskId }}</span>
            <span class="text-text-muted"> · {{ e.deployType === "auto" ? "自动化" : "Docker" }}</span>
          </button>
          <span class="text-text-muted whitespace-nowrap">{{ timeText(e.startedAt) }}</span>
          <span class="text-text-muted w-16 text-right">{{ sizeText(e.size) }}</span>
          <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="openLive(e)">
            实时
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="h-6 px-2 text-[11px]"
            @click="exportOne(e)"
          >
            导出
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="h-6 px-2 text-[11px] text-danger hover:text-danger"
            @click="removeOne(e)"
          >
            删除
          </Button>
        </div>

        <div
          v-if="openKey === keyOf(e)"
          class="border-t border-border bg-[#0b0d12] text-[#d4d4d4] px-3 py-2 max-h-[420px] overflow-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all"
        >
          <span v-if="openLoading" class="text-white/40">读取中…</span>
          <template v-else>{{ openText }}</template>
        </div>
      </li>
    </ul>

    <p v-if="flash" class="text-xs text-success">{{ flash }}</p>

    <ConfirmDialog
      :open="pendingClear"
      title="清空全部历史日志？"
      description="将删除所有已留存的日志文件，不可恢复"
      confirm-text="清空"
      danger
      :loading="clearing"
      @update:open="
        (v: boolean) => {
          if (!v) pendingClear = false;
        }
      "
      @confirm="doClear"
    />
  </div>
</template>
