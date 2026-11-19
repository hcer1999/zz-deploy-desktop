<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { fetchBranches, fetchCommits, fetchTaskList, submitDeploy } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import { useFavoritesStore } from "@/stores/favorites";
import { useTasksStore } from "@/stores/tasks";
import { useBatchStore } from "@/stores/batch";
import { useTagsStore } from "@/stores/tags";
import type { Favorite } from "@/api/favorites";
import { useTabsStore } from "@/stores/tabs";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";
import MetaDialog from "@/components/favorites/MetaDialog.vue";
import TagFilterBar from "@/components/favorites/TagFilterBar.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { VueDraggable } from "vue-draggable-plus";
import { GripVertical } from "@lucide/vue";

const favorites = useFavoritesStore();
const tasks = useTasksStore();
const tabs = useTabsStore();
const batches = useBatchStore();
const tags = useTagsStore();

const expandedId = ref<string | null>(null);
const pendingDelete = ref<string | null>(null);

// ---------- 筛选 ----------

const filter = ref("");
/** 选中的标签按 AND 收窄（再多一个标签 = 更小的结果集），与关键词取交集 */
const selectedTags = ref<string[]>([]);
const filterActive = computed(
  () => filter.value.trim() !== "" || selectedTags.value.length > 0,
);

/** 当前收藏里出现过的标签（没被任何收藏引用的标签不必占一行位置） */
const availableTags = computed(() => {
  const seen: string[] = [];
  for (const f of favorites.items) {
    for (const t of f.tags ?? []) if (!seen.includes(t)) seen.push(t);
  }
  return seen;
});

/** 匹配项目名 / 环境 / 分支 / 类型。空白字符归一化，方便按「正式 环境」这种写法搜 */
const filteredItems = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return favorites.items.filter((f) => {
    // 标签是 AND：每选一个都要求命中
    if (!selectedTags.value.every((t) => (f.tags ?? []).includes(t))) return false;
    if (!q) return true;
    return [
      f.projectName,
      f.envName,
      f.branch ?? "",
      f.deployType === "auto" ? "自动化" : "Docker",
      f.note ?? "",
      (f.tags ?? []).join(" "),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
});

/**
 * 列表渲染源。
 *
 * 筛选时只渲染命中的子集，但必须**同时禁用拖动**（见模板的 `:disabled`）：
 * 排序语义只在完整列表上成立，否则拖动会把子集的顺序写回整表。
 * setter 里再挡一道，避免将来忘了改 disabled 就把数据写坏。
 */
const displayedItems = computed({
  get: () => filteredItems.value,
  set: (next) => {
    if (!filterActive.value) favorites.items = next;
  },
});

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

/**
 * 每条收藏的「构建成功后自动上线」勾选状态。
 * 用 id 做键、默认不存在（= 关）：收起再展开可以保留本次勾选，
 * 但换一条收藏不会带上别人的选择，且**不写进收藏数据**（危险开关每次都重新勾）。
 */
const autoOnlineByFav = ref<Record<string, boolean>>({});

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

/** 标签表加载失败不该挡住收藏列表：颜色会退化成按名字哈希的兜底色 */
async function ensureTags(): Promise<void> {
  if (tags.loaded) return;
  try {
    await tags.load();
  } catch {
    // 忽略：兜底色可用
  }
}

onMounted(() => void ensureTags());

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
    // 收起即忘掉这次的自动上线勾选：下次展开默认还是关的
    delete autoOnlineByFav.value[id];
    return;
  }
  expandedId.value = id;
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;

  const d = draft(id);
  d.error = "";

  // 分支列表总是拉：收藏里记的分支只是**默认值**，用户随时可以改成别的，
  // 所以下拉里必须有全部分支可选项（旧实现只在「没记分支」时才拉分支列表，
  // 并把记了分支的收藏锁死——这正是本次要修的问题）。
  await loadBranches(id);
  if (fav.branch) {
    d.branch = fav.branch;
    await loadCommits(id);
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
    // 默认选最新一条：收藏的意义就是少点几下；用户仍可在下拉里改
    d.commit = d.commits[0]?.fullString ?? "";
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.loadingCommits = false;
  }
}

/** 改分支：清掉旧 commit 并重拉（旧 commit 属于别的分支，不能留） */
async function onBranchChange(id: string, branch: string): Promise<void> {
  const d = draft(id);
  d.branch = branch;
  d.commit = "";
  d.commits = [];
  if (branch) await loadCommits(id);
}

function onCommitChange(id: string, commit: string): void {
  draft(id).commit = commit;
}

async function quickDeploy(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  if (!d.branch || !d.commit) return;

  d.submitting = true;
  d.error = "";
  try {
    const autoOnline = autoOnlineByFav.value[id] === true;
    // 与向导同构：勾了自动上线就先记下当前最大 taskId 作为认领基线
    let baseline = 0;
    if (autoOnline) {
      try {
        const page = await fetchTaskList(fav.deployType, 1, { search: "", envId: 0 });
        baseline = page.tasks.reduce((max, t) => Math.max(max, t.taskId), 0);
      } catch {
        baseline = 0;
      }
    }
    const ok = await submitDeploy(fav.deployType, fav.projectId, {
      title: "",
      branchtag: d.branch,
      version: d.commit,
    });
    if (!ok) {
      d.error = "提交失败，请重试";
      return;
    }
    if (autoOnline) {
      batches.start({
        kind: "single",
        autoOnline: true,
        baselines: { [fav.deployType]: baseline },
        items: [
          {
            deployType: fav.deployType,
            envId: fav.envId,
            envName: fav.envName,
            projectId: fav.projectId,
            projectName: fav.projectName,
            branch: d.branch,
            version: d.commit,
          },
        ],
      });
      batches.ensureWatching();
    }
    // 与向导保持一致：切到对应类型的任务列表。
    // 任务列表会因 activeId 变化自动刷新（见 TaskListView 的 syncVisibility），
    // 不需要在这里手动触发。
    tasks.deployType = fav.deployType;
    tasks.page = 1;
    tabs.open({ kind: "list" });
    expandedId.value = null;
    // 展开项收起，自动上线勾选一并不再保留（与手动收起同一语义）
    delete autoOnlineByFav.value[id];
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.submitting = false;
  }
}

// ---------- 备注与标签 ----------

const metaTarget = ref<Favorite | null>(null);

async function saveMeta(meta: { note: string; tags: string[] }): Promise<void> {
  const target = metaTarget.value;
  if (!target) return;
  try {
    await favorites.setMeta(target.id, meta);
  } catch (e) {
    reorderError.value = toUserMessage(e);
  } finally {
    metaTarget.value = null;
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

    <div v-if="favorites.items.length > 0" class="flex items-center gap-3">
      <Input
        v-model="filter"
        data-test="fav-filter"
        placeholder="筛选收藏…（项目 / 环境 / 分支）"
        class="h-8 max-w-[320px] text-xs"
      />
      <span v-if="filterActive" class="text-[11px] text-text-muted">
        匹配 {{ filteredItems.length }} / 共 {{ favorites.items.length }}
      </span>
    </div>

    <TagFilterBar
      v-if="favorites.items.length > 0 && availableTags.length > 0"
      v-model="selectedTags"
      :available="availableTags"
    />

    <div v-if="favorites.items.length === 0" class="text-xs text-text-muted py-8 text-center">
      暂无收藏。在「新建部署」里选好项目后点「保存为收藏」。
    </div>

    <div
      v-else-if="filteredItems.length === 0"
      class="text-xs text-text-muted py-8 text-center"
    >
      没有匹配的收藏
    </div>

    <p v-if="reorderError" class="text-xs text-danger">{{ reorderError }}</p>

    <VueDraggable
      v-if="filteredItems.length > 0"
      v-model="displayedItems"
      :animation="150"
      handle=".drag-handle"
      ghost-class="opacity-40"
      class="space-y-2"
      :force-fallback="true"
      :fallback-on-body="true"
      :fallback-tolerance="4"
      :disabled="filterActive"
      @end="onReorderEnd"
    >
      <div
        v-for="f in displayedItems"
        :key="f.id"
        :class="[
          'rounded-md border bg-surface overflow-hidden',
          expandedId === f.id ? 'border-primary' : 'border-border',
        ]"
      >
        <div class="flex items-center gap-3 px-4 py-3">
          <button
            :class="[
              'drag-handle shrink-0 text-text-muted hover:text-text',
              filterActive ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing',
            ]"
            :disabled="filterActive"
            :title="filterActive ? '筛选状态下不可拖动排序' : '拖动以排序'"
            :aria-label="filterActive ? '筛选状态下不可拖动排序' : '拖动以排序'"
          >
            <GripVertical :size="16" />
          </button>
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="text-sm truncate">{{ f.projectName }}</span>
              <span
                v-for="name in f.tags ?? []"
                :key="name"
                data-test="fav-tag"
                class="text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap shrink-0"
                :style="{
                  backgroundColor: tags.colorOf(name) + '22',
                  color: tags.colorOf(name),
                  borderColor: tags.colorOf(name) + '55',
                }"
              >
                {{ name }}
              </span>
            </div>
            <div class="text-[11px] text-text-muted truncate">
              {{ f.envName }} · {{ f.deployType === "auto" ? "自动化" : "Docker" }}
              <template v-if="f.branch"> · {{ f.branch }}</template>
            </div>
            <div v-if="f.note" class="text-[11px] text-text-muted/80 truncate" :title="f.note">
              {{ f.note }}
            </div>
          </div>
          <span
            :class="[
              'text-[10px] px-1.5 py-0.5 rounded-full border whitespace-nowrap',
              f.type === 'project'
                ? 'border-border text-text-muted'
                : 'border-primary/40 text-primary',
            ]"
            :title="f.type === 'project' ? '只记住项目，部署时再选分支' : '记住了分支（部署时仍可改）'"
          >
            {{ f.type === "project" ? "仅项目" : "项目+分支" }}
          </span>
          <Button
            size="sm"
            variant="outline"
            data-test="edit-meta"
            @click="metaTarget = f"
          >
            编辑
          </Button>
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
          <!-- 分支总是可改：收藏里记的只是默认值 -->
          <div class="space-y-1.5 max-w-[560px]">
            <div class="text-[11px] text-text-muted">
              分支{{ draft(f.id).loadingBranches ? "（加载中…）" : "" }}
            </div>
            <div
              v-if="!draft(f.id).loadingBranches && draft(f.id).branches.length === 0"
              class="text-[11px] text-text-muted"
            >
              未找到分支
            </div>
            <SearchSelect
              v-else
              :model-value="draft(f.id).branch"
              :options="draft(f.id).branches.map((b) => ({ value: b, label: b }))"
              :disabled="draft(f.id).loadingBranches"
              placeholder="搜索并选择分支…"
              empty-text="没有匹配的分支"
              @update:model-value="(v: string) => onBranchChange(f.id, v)"
            />
          </div>

          <div class="space-y-1.5 max-w-[760px]">
            <div class="text-[11px] text-text-muted">
              Commit{{ draft(f.id).loadingCommits ? "（加载中…）" : "" }}
            </div>
            <SearchSelect
              :model-value="draft(f.id).commit"
              :options="
                draft(f.id).commits.map((c) => ({
                  value: c.fullString,
                  label: `${c.hash.slice(0, 8)} ${c.message}`,
                }))
              "
              :disabled="!draft(f.id).branch || draft(f.id).loadingCommits"
              placeholder="搜索并选择 Commit…"
              empty-text="没有匹配的 Commit"
              @update:model-value="(v: string) => onCommitChange(f.id, v)"
            />
          </div>

          <p v-if="draft(f.id).error" class="text-[11px] text-danger">{{ draft(f.id).error }}</p>

          <label class="flex items-start gap-2 text-xs">
            <input
              type="checkbox"
              data-test="auto-online-single"
              class="mt-0.5"
              :checked="autoOnlineByFav[f.id] === true"
              @change="
                (e) =>
                  (autoOnlineByFav[f.id] = (e.target as HTMLInputElement).checked)
              "
            />
            <span>
              构建成功后<strong>自动上线</strong>
              <span class="text-text-muted">（默认关闭）</span>
            </span>
          </label>
          <p
            v-if="autoOnlineByFav[f.id]"
            data-test="auto-online-warning"
            class="text-[11px] text-danger leading-relaxed border border-danger/40 bg-danger/10 rounded-md px-3 py-2"
          >
            ⚠️ 已开启自动上线：构建成功后立刻上线，期间不会再问你。若服务端列表里识别不到这次任务，本次不会自动上线。
          </p>

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

    <MetaDialog
      :open="metaTarget !== null"
      mode="favorite"
      :target-name="metaTarget?.projectName ?? ''"
      :note="metaTarget?.note ?? ''"
      :tags="metaTarget?.tags ?? []"
      @update:open="(v: boolean) => { if (!v) metaTarget = null; }"
      @save="saveMeta"
    />

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
