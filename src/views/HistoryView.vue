<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { useHistoryStore } from "@/stores/history";
import { useTabsStore } from "@/stores/tabs";
import { setOpenLog } from "@/stores/tabPayload";
import { normalizeToLinesAsync, normalizeToTextAsync } from "@/lib/logLoad";
import { highlightLineCached } from "@/lib/logHighlight";
import { toUserMessage } from "@/api/http";
import { exportHistory } from "@/api/history";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";

const history = useHistoryStore();
const tabs = useTabsStore();

const search = ref("");
const openKey = ref("");
const openLines = ref<string[]>([]);
/** 文件比预览读取上限大（更早的内容没有读进来） */
const openTruncated = ref(false);
/** 解析后因超过 5000 行被丢弃的行数 */
const openOmitted = ref(0);
const openLoading = ref(false);
const openProgress = ref(0);
/** 当前展开请求的令牌：快速切换条目时丢弃旧请求的结果 */
let openToken = 0;
const flash = ref("");
const clearing = ref(false);
const pendingClear = ref(false);
const exporting = ref(false);

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

  const token = ++openToken;
  openKey.value = k;
  openLines.value = [];
  openTruncated.value = false;
  openOmitted.value = 0;
  openProgress.value = 0;
  openLoading.value = true;
  try {
    // 只读末尾一段：几十 MB 的日志整段读进来再解析会占住主线程（点一下卡死）。
    // 预览本来也只展示最后 5000 行，完整内容走「导出」。
    const tail = await history.readTail(e.deployType, e.taskId);
    if (token !== openToken) return;
    if (tail === null) {
      openLines.value = ["（日志文件已不存在）"];
      return;
    }

    openTruncated.value = tail.truncated;
    // 分片解析 + 每片让出主线程：期间界面仍能滚动、点击、显示进度
    const result = await normalizeToLinesAsync(tail.text, {
      maxLines: 5000,
      onProgress: (done, total) => {
        if (token === openToken) openProgress.value = Math.round((done / Math.max(1, total)) * 100);
      },
      cancelled: () => token !== openToken,
    });
    if (token !== openToken) return;

    openLines.value = result.lines;
    openOmitted.value = result.omitted;
  } catch (err) {
    if (token === openToken) openLines.value = [toUserMessage(err)];
  } finally {
    if (token === openToken) openLoading.value = false;
  }
}

/** 导出用户看到的内容（已剥离 ANSI），而不是带转义码的原始文件 */
async function exportOne(e: {
  deployType: "auto" | "docker";
  taskId: number;
  projectName: string;
}): Promise<void> {
  if (exporting.value) return;
  exporting.value = true;
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

    showFlash("正在整理日志…");
    // 导出需要完整内容，同样分片处理，避免大文件把界面卡住
    const content = await normalizeToTextAsync(raw);
    await exportHistory(dest, content);
    showFlash("已导出");
  } catch (err) {
    showFlash(toUserMessage(err));
  } finally {
    exporting.value = false;
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
            :disabled="exporting"
            @click="exportOne(e)"
          >
            {{ exporting ? "整理中…" : "导出" }}
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
          <span v-if="openLoading" class="text-white/40">
            读取中…{{ openProgress ? ` ${openProgress}%` : "" }}
          </span>
          <template v-else>
            <p
              v-if="openTruncated || openOmitted"
              class="mb-2 rounded-sm bg-amber-400/10 px-2 py-1 text-[11px] text-amber-300/90"
            >
              日志较大，仅显示最后 {{ openLines.length }} 行<template v-if="openOmitted"
                >（已省略前 {{ openOmitted }} 行）</template
              ><template v-if="openTruncated">（更早的内容未读取）</template
              >；完整内容请用「导出」。
            </p>
            <div
              v-for="(line, i) in openLines"
              :key="i"
              class="log-line whitespace-pre-wrap break-all"
            >
              <span v-for="(seg, j) in highlightLineCached(line)" :key="j" :class="seg.cls">{{
                seg.text
              }}</span>
            </div>
          </template>
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
