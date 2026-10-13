<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { fetchBranches, fetchCommits, submitDeploy } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import { useFavoritesStore } from "@/stores/favorites";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { VueDraggable } from "vue-draggable-plus";
import { GripVertical } from "@lucide/vue";

const favorites = useFavoritesStore();
const tasks = useTasksStore();
const tabs = useTabsStore();

const expandedId = ref<string | null>(null);
const pendingDelete = ref<string | null>(null);

interface Draft {
  branches: string[];
  commits: { hash: string; message: string; fullString: string }[];
  branch: string;
  commit: string;
  loadingBranches: boolean;
  loadingCommits: boolean;
  submitting: boolean;
  error: string;
}

/** 每个展开项的临时状态。用 id 做键，收起后再展开会重置 */
const drafts = ref<Record<string, Draft>>({});

function draft(id: string): Draft {
  if (!drafts.value[id]) {
    drafts.value[id] = {
      branches: [],
      commits: [],
      branch: "",
      commit: "",
      loadingBranches: false,
      loadingCommits: false,
      submitting: false,
      error: "",
    };
  }
  return drafts.value[id];
}

const deleteTarget = computed(() =>
  pendingDelete.value ? favorites.items.find((f) => f.id === pendingDelete.value) : undefined,
);

/**
 * 变为可见时从服务端重读一次。
 *
 * 与任务列表同一个理由：TabHost 用 v-show 隐藏标签而非卸载，
 * 所以组件只挂载一次，onMounted 不会重跑；若别处（如向导里保存收藏）
 * 变更了数据，本页会停在旧列表。
 *
 * 注意这层是**兜底**而不是主要保障——主要保障是"所有变更都走 store"
 * （见 stores/favorites.ts 的 save/remove）。兜底的价值是：
 * 即使将来又出现绕过 store 的写入，这里也不会显示过期数据。
 */
function syncVisibility(): void {
  if (tabs.activeTab?.kind === "favorites") void favorites.load();
}

onMounted(syncVisibility);
watch(() => tabs.activeId, syncVisibility);

// Cmd/Ctrl+R 的刷新手势（与任务列表一致）
function onRefreshShortcut(): void {
  if (tabs.activeTab?.kind === "favorites") void favorites.load();
}
onMounted(() => window.addEventListener("app://refresh", onRefreshShortcut));
onUnmounted(() => window.removeEventListener("app://refresh", onRefreshShortcut));

// ---------- 拖动排序 ----------

/**
 * 拖动结束后持久化顺序。
 *
 * 用 SortableJS 系的 vue-draggable-plus 而非 HTML5 原生拖拽：
 * 它基于指针事件，在 macOS/Windows/Linux 三端 webview
 * （WKWebView / WebView2 / WebKit GTK）上行为一致得多。
 *
 * ⚠️ 光用这个库不够——**必须同时打开 `force-fallback`**：
 * SortableJS 默认优先用浏览器原生 HTML5 拖放，而各 webview 对原生拖放的
 * 支持差异很大（实测在 Tauri 的 WKWebView 里拖不动，表现为"排序不生效"）。
 *
 * 直接读 v-model 里的数组：SortableJS 的事件顺序是 `update` → `end`，
 * 库里挂的 onUpdate 会在 `end` 之前把新顺序写回 v-model，所以 `end` 时数组
 * 已是用户看到的顺序（真浏览器实测：拖第一项过第二项后，提交的顺序是换过的）。
 * 反过来说，别拿 `oldDraggableIndex/newDraggableIndex` 再自己算一遍：
 * 那会把位移应用两次，又转回原顺序。
 */
const reorderError = ref("");

async function onReorderEnd(): Promise<void> {
  reorderError.value = "";
  try {
    await favorites.persistOrder(favorites.items.map((f) => f.id));
  } catch (e) {
    reorderError.value = `排序未保存：${toUserMessage(e)}`;
    // 本地可能已被拖动改过，从服务端重新读回真实顺序
    await favorites.load();
  }
}

async function toggle(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = id;
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;

  const d = draft(id);
  d.error = "";
  if (fav.branch) {
    // 收藏自带分支 → 直接拉 commit
    d.branch = fav.branch;
    await loadCommits(id);
  } else {
    await loadBranches(id);
  }
}

async function loadBranches(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  d.loadingBranches = true;
  d.error = "";
  try {
    d.branches = await fetchBranches(fav.deployType, fav.projectId);
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.loadingBranches = false;
  }
}

async function loadCommits(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  if (!d.branch) return;
  d.loadingCommits = true;
  d.error = "";
  try {
    d.commits = await fetchCommits(fav.projectName, d.branch);
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.loadingCommits = false;
  }
}

async function pickBranch(id: string, branch: string): Promise<void> {
  const d = draft(id);
  d.branch = branch;
  d.commit = "";
  d.commits = [];
  if (branch) await loadCommits(id);
}

async function quickDeploy(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  if (!d.branch || !d.commit) return;

  d.submitting = true;
  d.error = "";
  try {
    const ok = await submitDeploy(fav.deployType, fav.projectId, {
      title: "",
      branchtag: d.branch,
      version: d.commit,
    });
    if (!ok) {
      d.error = "提交失败，请重试";
      return;
    }
    // 与向导保持一致：切到对应类型的任务列表。
    // 任务列表会因 activeId 变化自动刷新（见 TaskListView 的 syncVisibility），
    // 不需要在这里手动触发。
    tasks.deployType = fav.deployType;
    tasks.page = 1;
    tabs.open({ kind: "list" });
    expandedId.value = null;
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.submitting = false;
  }
}

async function confirmDelete(): Promise<void> {
  if (!pendingDelete.value) return;
  const id = pendingDelete.value;
  await favorites.remove(id);
  if (expandedId.value === id) expandedId.value = null;
  delete drafts.value[id];
  pendingDelete.value = null;
}
</script>

<template>
  <div class="p-6 space-y-4">
    <h1 class="text-base font-semibold">收藏</h1>

    <div v-if="favorites.items.length === 0" class="text-xs text-text-muted py-8 text-center">
      暂无收藏。在「新建部署」里选好项目后点「保存为收藏」。
    </div>

    <p v-if="reorderError" class="text-xs text-danger">{{ reorderError }}</p>

    <VueDraggable
      v-if="favorites.items.length > 0"
      v-model="favorites.items"
      :animation="150"
      handle=".drag-handle"
      ghost-class="opacity-40"
      class="space-y-2"
      :force-fallback="true"
      :fallback-on-body="true"
      :fallback-tolerance="4"
      @end="onReorderEnd"
    >
      <div
        v-for="f in favorites.items"
        :key="f.id"
        :class="[
          'rounded-md border bg-surface overflow-hidden',
          expandedId === f.id ? 'border-primary' : 'border-border',
        ]"
      >
        <div class="flex items-center gap-3 px-4 py-3">
          <button
            class="drag-handle cursor-grab active:cursor-grabbing text-text-muted hover:text-text shrink-0"
            title="拖动以排序"
            aria-label="拖动以排序"
          >
            <GripVertical :size="16" />
          </button>
          <div class="flex-1 min-w-0">
            <div class="text-sm truncate">{{ f.projectName }}</div>
            <div class="text-[11px] text-text-muted truncate">
              {{ f.envName }} · {{ f.deployType === "auto" ? "自动化" : "Docker" }}
              <template v-if="f.branch"> · {{ f.branch }}</template>
            </div>
          </div>
          <Button size="sm" variant="outline" @click="toggle(f.id)">
            {{ expandedId === f.id ? "收起" : "快速部署" }}
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="text-danger hover:text-danger"
            @click="pendingDelete = f.id"
          >
            删除
          </Button>
        </div>

        <div
          v-if="expandedId === f.id"
          class="border-t border-border bg-surface-2 px-4 py-3 space-y-3"
        >
          <div v-if="!f.branch" class="space-y-1.5">
            <div class="text-[11px] text-text-muted">
              分支{{ draft(f.id).loadingBranches ? "（加载中…）" : "" }}
            </div>
            <div v-if="!draft(f.id).loadingBranches && draft(f.id).branches.length === 0" class="text-[11px] text-text-muted">
              未找到分支
            </div>
            <div v-else class="flex flex-wrap gap-1.5">
              <Button
                v-for="b in draft(f.id).branches"
                :key="b"
                size="sm"
                :variant="draft(f.id).branch === b ? 'default' : 'secondary'"
                class="text-[11px] font-mono h-6 px-2"
                @click="pickBranch(f.id, b)"
              >
                {{ b }}
              </Button>
            </div>
          </div>

          <div v-if="draft(f.id).branch" class="space-y-1.5">
            <div class="text-[11px] text-text-muted">
              Commit{{ draft(f.id).loadingCommits ? "（加载中…）" : "" }}
            </div>
            <select
              v-model="draft(f.id).commit"
              class="w-full max-w-[760px] h-8 rounded-md border border-border bg-surface px-2 text-[11px] font-mono"
            >
              <option value="">-- 选择 Commit --</option>
              <option v-for="c in draft(f.id).commits" :key="c.fullString" :value="c.fullString">
                {{ c.hash.slice(0, 8) }} {{ c.message }}
              </option>
            </select>
          </div>

          <p v-if="draft(f.id).error" class="text-[11px] text-danger">{{ draft(f.id).error }}</p>

          <Button
            size="sm"
            :disabled="!draft(f.id).branch || !draft(f.id).commit || draft(f.id).submitting"
            @click="quickDeploy(f.id)"
          >
            {{ draft(f.id).submitting ? "提交中…" : "提交部署" }}
          </Button>
        </div>
      </div>
    </VueDraggable>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="确认删除收藏？"
      :description="deleteTarget ? deleteTarget.projectName : ''"
      confirm-text="删除"
      danger
      @update:open="
        (v: boolean) => {
          if (!v) pendingDelete = null;
        }
      "
      @confirm="confirmDelete"
    />
  </div>
</template>
