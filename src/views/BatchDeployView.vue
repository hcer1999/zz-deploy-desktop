<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import {
  ENVS,
  fetchProjects,
  fetchBranches,
  fetchCommits,
  fetchTaskList,
  submitDeploy,
} from "@/api/deploy";
import type { CommitInfo, DeployType, Project } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import { useSettingsStore } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import { useBatchStore } from "@/stores/batch";
import { useBatchFavoritesStore } from "@/stores/batchFavorites";
import type { BatchFavorite } from "@/api/batchFavorites";
import EnvPicker from "@/components/deploy/EnvPicker.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/*
 * 批量部署 = 「购物车」模型。
 *
 * 左边是熟悉的选环境 / 选项目 / 选分支 / 选 commit，点「加入批量计划」把这一项丢进右边的清单；
 * **每一项自带环境与部署类型**，所以一份计划可以跨环境、跨分支、跨类型。
 * 右边清单里每项都能单独改分支/commit，也能移除；最后统一提交。
 *
 * 为什么不再是"一个环境 + 一批项目"：发版经常要同时给测试环境与正式环境、
 * 给同一批项目的**不同分支**提交，原来的约束直接把这种用法挡掉了。
 */

const settings = useSettingsStore();
const tasks = useTasksStore();
const tabs = useTabsStore();
const batches = useBatchStore();
const batchFavorites = useBatchFavoritesStore();

// ---------- 左侧：选择器 ----------

const deployType = ref<DeployType>(settings.lastDeployType);
const envId = ref<number | null>(settings.lastEnvId);
const envName = computed(() => ENVS.find((e) => e.id === envId.value)?.name ?? "");

const projects = ref<Project[] | null>(null);
const projectSearch = ref("");
const selectedProject = ref<Project | null>(null);

const branches = ref<string[]>([]);
/** 预选分支/commit：加入计划时带进去（不选也行，加进去再补） */
const branch = ref("");
const commits = ref<CommitInfo[]>([]);
const commit = ref("");
const loading = ref({ projects: false, branches: false, commits: false });
/**
 * 这两条必须在下面 `immediate: true` 的 watcher 之前声明：
 * 那个 watcher 在 setup 阶段就会跑一次，声明在它后面会撞上 TDZ
 * （表现为首屏项目列表静默加载失败）。实测被测试抓出来过。
 */
const error = ref("");
const flash = ref("");
let branchToken = 0;

const filteredProjects = computed(() => {
  const q = projectSearch.value.trim().toLowerCase();
  const list = projects.value ?? [];
  return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
});

const branchOptions = computed(() => branches.value.map((b) => ({ value: b, label: b })));
const commitOptions = computed(() =>
  commits.value.map((c) => ({
    value: c.fullString,
    label: `${c.hash.slice(0, 8)} ${c.message}`,
  })),
);

// 换环境/类型：重拉项目，并清掉下游选择（计划不受影响）
watch(
  [deployType, envId],
  async ([, env]) => {
    projects.value = null;
    selectedProject.value = null;
    resetAfterProject();
    error.value = "";
    if (!env) return;
    loading.value.projects = true;
    try {
      projects.value = await fetchProjects(deployType.value, env);
    } catch (e) {
      error.value = toUserMessage(e);
    } finally {
      loading.value.projects = false;
    }
  },
  { immediate: true },
);

/** 记住上次用的类型+环境（与向导共用同一份记忆） */
watch([deployType, envId], ([type, env]) => {
  if (!settings.loaded) return;
  void settings.patch({ lastDeployType: type, lastEnvId: env });
});

function resetAfterProject(): void {
  branches.value = [];
  branch.value = "";
  commits.value = [];
  commit.value = "";
}

async function pickProject(p: Project): Promise<void> {
  selectedProject.value = p;
  resetAfterProject();
  error.value = "";
  const token = ++branchToken;
  loading.value.branches = true;
  try {
    const list = await fetchBranches(deployType.value, p.id);
    if (token !== branchToken) return;
    branches.value = list;
  } catch (e) {
    if (token === branchToken) error.value = toUserMessage(e);
  } finally {
    if (token === branchToken) loading.value.branches = false;
  }
}

async function pickBranch(value: string): Promise<void> {
  branch.value = value;
  commits.value = [];
  commit.value = "";
  if (!selectedProject.value || !value) return;
  const token = branchToken;
  loading.value.commits = true;
  try {
    const list = await fetchCommits(selectedProject.value.name, value);
    if (token !== branchToken) return;
    commits.value = list;
    // 默认选最新一条，省一次点击
    commit.value = list[0]?.fullString ?? "";
  } catch (e) {
    if (token === branchToken) error.value = toUserMessage(e);
  } finally {
    if (token === branchToken) loading.value.commits = false;
  }
}

// ---------- 右侧：批量计划 ----------

interface PlanItem {
  /** 同「类型 + 环境 + 项目」视为同一项（再点一次就是更新它） */
  key: string;
  deployType: DeployType;
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  branches: string[];
  commits: CommitInfo[];
  branch: string;
  commit: string;
  loading: boolean;
  /** 不能提交的原因（比如没有 commit） */
  invalid: string;
  /** 上次提交的结果 */
  error?: string;
  done?: boolean;
}

const plan = ref<PlanItem[]>([]);
const submitting = ref(false);
const confirmOpen = ref(false);
const autoOnline = ref(false);
const submitted = ref(false);

const completeItems = computed(() => plan.value.filter((i) => !i.invalid && i.commit));
const envCount = computed(() => new Set(plan.value.map((i) => i.envName)).size);

function itemKey(type: DeployType, env: number, projectId: number): string {
  return `${type}_${env}_${projectId}`;
}

/** 把一项加进计划；已存在同（类型+环境+项目）则更新它 */
async function addToPlan(): Promise<void> {
  const p = selectedProject.value;
  if (!p || envId.value === null) return;
  submitted.value = false;
  error.value = "";
  const key = itemKey(deployType.value, envId.value, p.id);

  const existing = plan.value.find((i) => i.key === key);
  if (existing) {
    flashMsg(`已更新计划里的「${p.name}」`);
  } else {
    plan.value.push({
      key,
      deployType: deployType.value,
      envId: envId.value,
      envName: envName.value,
      projectId: p.id,
      projectName: p.name,
      branches: [],
      commits: [],
      branch: "",
      commit: "",
      loading: true,
      invalid: "",
    });
    flashMsg(`已加入计划：${envName.value} · ${p.name}`);
  }
  // 加入后清掉项目选择，方便接着点下一个项目
  const prefill = { branch: branch.value, commit: commit.value };
  selectedProject.value = null;
  resetAfterProject();

  await hydrate(key, prefill);
}

/**
 * 补齐一项的候选分支与 commit。
 *
 * `prefill` 是左侧预选的值：分支在项目里存在就用它，否则退回第一条；
 * commit 只认服务端返回列表里真实存在的那条（否则退回最新一条）。
 */
async function hydrate(
  key: string,
  prefill: { branch?: string; commit?: string },
): Promise<void> {
  // ⚠️ 必须从 plan 里取回**响应式代理**再改：直接改刚 push 进去的原始对象
  // 不会触发重渲染（界面会永远停在"加载分支与 commit…"，实测踩过）。
  const item = plan.value.find((i) => i.key === key);
  if (!item) return;
  item.loading = true;
  item.invalid = "";
  try {
    if (item.branches.length === 0) {
      item.branches = await fetchBranches(item.deployType, item.projectId);
    }
    const wanted = prefill.branch ?? item.branch;
    item.branch = wanted && item.branches.includes(wanted) ? wanted : (item.branches[0] ?? "");
    if (!item.branch) {
      item.invalid = "该项目没有可用分支";
      return;
    }
    item.commits = await fetchCommits(item.projectName, item.branch);
    const wantCommit = prefill.commit ?? item.commit;
    item.commit =
      wantCommit && item.commits.some((c) => c.fullString === wantCommit)
        ? wantCommit
        : (item.commits[0]?.fullString ?? "");
    if (!item.commit) item.invalid = "没有 commit 记录";
  } catch (e) {
    item.invalid = toUserMessage(e);
  } finally {
    item.loading = false;
  }
}

/** 清单里改分支：重拉 commit，旧 commit 属于别的分支，必须丢掉 */
async function changeItemBranch(item: PlanItem, value: string): Promise<void> {
  item.branch = value;
  item.commit = "";
  item.invalid = "";
  item.loading = true;
  try {
    item.commits = await fetchCommits(item.projectName, value);
    item.commit = item.commits[0]?.fullString ?? "";
    if (!item.commit) item.invalid = "没有 commit 记录";
  } catch (e) {
    item.invalid = toUserMessage(e);
  } finally {
    item.loading = false;
  }
}

function removeFromPlan(item: PlanItem): void {
  plan.value = plan.value.filter((i) => i.key !== item.key);
  submitted.value = false;
}

function clearPlan(): void {
  plan.value = [];
  submitted.value = false;
}

// ---------- 提交 ----------

async function doSubmit(): Promise<void> {
  confirmOpen.value = false;
  submitting.value = true;
  error.value = "";
  const targets = [...completeItems.value];

  try {
    // 每种部署类型提交前的最大 taskId（认领判据的一部分，见 stores/batch.ts）
    const baselines: Partial<Record<DeployType, number>> = {};
    for (const type of new Set(targets.map((i) => i.deployType))) {
      try {
        const page = await fetchTaskList(type, 1, "");
        baselines[type] = page.tasks.reduce((max, t) => Math.max(max, t.taskId), 0);
      } catch {
        baselines[type] = 0; // 拿不到也能跑，只是少了"比它新"这层保护
      }
    }

    // 串行提交：提交不可重试（spec §6.6 红线），一项失败不影响其余
    for (const item of targets) {
      item.error = undefined;
      item.done = false;
      try {
        const ok = await submitDeploy(item.deployType, item.projectId, {
          title: "",
          branchtag: item.branch,
          version: item.commit,
        });
        if (ok) item.done = true;
        else item.error = "提交失败，请重试";
      } catch (e) {
        item.error = toUserMessage(e);
      }
    }

    const okItems = targets.filter((i) => i.done);
    const failedItems = targets.filter((i) => i.error);

    if (okItems.length > 0) {
      const run = batches.start({
        autoOnline: autoOnline.value,
        baselines,
        items: okItems.map((i) => ({
          deployType: i.deployType,
          envId: i.envId,
          envName: i.envName,
          projectId: i.projectId,
          projectName: i.projectName,
          branch: i.branch,
          version: i.commit,
        })),
      });
      batches.ensureWatching();
      // 提交成功的从计划里摘掉（失败的留着，方便直接重试）
      plan.value = plan.value.filter((i) => !i.done);
      submitted.value = true;
      // 与新建部署一致：切到任务列表看结果（混类型时看第一项的类型）
      tasks.deployType = run.items[0]?.deployType ?? deployType.value;
      tasks.page = 1;
      tabs.open({ kind: "list" });
      if (failedItems.length === 0) plan.value = [];
    } else {
      error.value = "全部提交失败，请检查网络后重试";
    }
  } finally {
    submitting.value = false;
  }
}

// ---------- 批量收藏 ----------

const loadedFavId = ref<string | null>(null);
const saveOpen = ref(false);
const favName = ref("");
const pendingDelete = ref<string | null>(null);

const deleteTarget = computed(() =>
  pendingDelete.value ? batchFavorites.items.find((f) => f.id === pendingDelete.value) : undefined,
);
const loadedFavName = computed(
  () => batchFavorites.items.find((f) => f.id === loadedFavId.value)?.name ?? "",
);

/** 载入一份计划：**替换**当前清单（比追加更可预期），逐项补齐分支/commit */
async function loadFavorite(fav: BatchFavorite): Promise<void> {
  loadedFavId.value = fav.id;
  submitted.value = false;
  error.value = "";
  plan.value = fav.items.map((it) => ({
    key: itemKey(it.deployType, it.envId, it.projectId),
    deployType: it.deployType,
    envId: it.envId,
    envName: it.envName,
    projectId: it.projectId,
    projectName: it.projectName,
    branches: [],
    commits: [],
    branch: "",
    commit: "",
    loading: true,
    invalid: "",
  }));
  flashMsg(`已载入「${fav.name}」（${plan.value.length} 项）`);
  const wanted = fav.items.map((it) => it.branch);
  // 传 key 而不是对象：hydrate 内部要从 plan 里取响应式代理再改（见那里的注释）
  await Promise.all(plan.value.map((item, i) => hydrate(item.key, { branch: wanted[i] })));
}

function openSaveDialog(): void {
  favName.value = loadedFavId.value ? loadedFavName.value : "";
  saveOpen.value = true;
}

async function saveFavorite(asNew = false): Promise<void> {
  const name = favName.value.trim();
  if (!name || plan.value.length === 0) return;
  try {
    const saved = await batchFavorites.save({
      id: asNew ? "" : (loadedFavId.value ?? ""),
      name,
      // 只存「类型 + 环境 + 项目 + 分支」，不存 commit 与自动上线开关
      items: plan.value.map((i) => ({
        deployType: i.deployType,
        envId: i.envId,
        envName: i.envName,
        projectId: i.projectId,
        projectName: i.projectName,
        branch: i.branch,
      })),
    });
    loadedFavId.value = saved.id;
    saveOpen.value = false;
    flashMsg(`已保存批量收藏「${saved.name}」`);
  } catch (e) {
    saveOpen.value = false;
    error.value = toUserMessage(e);
  }
}

async function confirmDelete(): Promise<void> {
  const id = pendingDelete.value;
  if (!id) return;
  try {
    await batchFavorites.remove(id);
    if (loadedFavId.value === id) loadedFavId.value = null;
    flashMsg("已删除该批量收藏");
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    pendingDelete.value = null;
  }
}

function flashMsg(msg: string): void {
  flash.value = msg;
  setTimeout(() => (flash.value = ""), 3000);
}

onMounted(async () => {
  batches.ensureWatching();
  if (!batchFavorites.loaded) {
    try {
      await batchFavorites.load();
    } catch (e) {
      error.value = toUserMessage(e);
    }
  }
});
</script>

<template>
  <div class="p-6 flex gap-5 items-start">
    <!-- 左：选择器 -->
    <div class="flex-1 min-w-0 space-y-4">
      <div class="space-y-1">
        <h1 class="text-base font-semibold">批量部署</h1>
        <p class="text-[11px] text-text-muted">
          选环境 → 选项目（可先选分支/commit）→「加入批量计划」；右边清单可跨环境、跨分支，最后一起提交
        </p>
      </div>

      <section v-if="batchFavorites.items.length > 0" class="space-y-2">
        <Label>批量收藏（点名字载入，会替换右侧清单）</Label>
        <div class="flex flex-wrap gap-2">
          <div
            v-for="f in batchFavorites.items"
            :key="f.id"
            :class="[
              'flex items-center gap-1 rounded-md border px-2 py-1 text-xs',
              loadedFavId === f.id ? 'border-primary bg-primary/10' : 'border-border bg-surface',
            ]"
          >
            <button
              data-test="load-fav"
              class="text-left hover:text-primary"
              :title="`载入：${f.items.length} 项`"
              @click="loadFavorite(f)"
            >
              {{ f.name }}
              <span class="text-text-muted">{{ f.items.length }} 项</span>
            </button>
            <button
              data-test="delete-fav"
              class="text-text-muted hover:text-danger px-1"
              title="删除这条批量收藏"
              @click="pendingDelete = f.id"
            >
              ✕
            </button>
          </div>
        </div>
      </section>

      <p v-if="flash" class="text-xs text-success">{{ flash }}</p>

      <section class="space-y-2">
        <Label>部署类型</Label>
        <div class="flex gap-2">
          <Button
            v-for="t in (['auto', 'docker'] as const)"
            :key="t"
            :variant="deployType === t ? 'default' : 'outline'"
            size="sm"
            @click="deployType = t"
          >
            {{ t === "auto" ? "自动化部署" : "Docker 部署" }}
          </Button>
        </div>
      </section>

      <section class="space-y-2">
        <Label>环境</Label>
        <EnvPicker v-model="envId" />
      </section>

      <section v-if="loading.projects" class="text-xs text-text-muted">正在加载项目…</section>

      <section v-else-if="projects" class="space-y-2">
        <div class="flex items-center justify-between gap-3">
          <Label>项目</Label>
          <Input v-model="projectSearch" placeholder="搜索项目…" class="w-56 h-8" />
        </div>
        <div v-if="projects.length === 0" class="text-xs text-text-muted">该环境下没有项目</div>
        <div v-else class="flex flex-wrap gap-2 max-h-[200px] overflow-auto p-1">
          <Button
            v-for="p in filteredProjects"
            :key="p.id"
            :data-test="`pick-${p.id}`"
            :variant="selectedProject?.id === p.id ? 'default' : 'secondary'"
            size="sm"
            class="text-xs"
            @click="pickProject(p)"
          >
            {{ p.name }}
          </Button>
        </div>
      </section>

      <!-- 选中项目后才出现：分支 / commit（都可选，不选就用默认最新） -->
      <template v-if="selectedProject">
        <section class="space-y-2">
          <Label>
            分支
            <span class="text-text-muted font-normal">（可选，不选则用各项目默认分支）</span>
          </Label>
          <div v-if="loading.branches" class="text-xs text-text-muted">正在加载分支…</div>
          <div v-else-if="branches.length === 0" class="text-xs text-text-muted">未找到分支</div>
          <SearchSelect
            v-else
            data-test="pick-branch"
            :model-value="branch"
            :options="branchOptions"
            placeholder="搜索并选择分支…"
            empty-text="没有匹配的分支"
            class="h-9 max-w-[520px] text-xs"
            @update:model-value="pickBranch"
          />
        </section>

        <section v-if="branch" class="space-y-2">
          <Label>
            Commit
            <span class="text-text-muted font-normal">（可选，不选则用最新）</span>
          </Label>
          <div v-if="loading.commits" class="text-xs text-text-muted">正在加载 Commit…</div>
          <div v-else-if="commits.length === 0" class="text-xs text-text-muted">
            未找到 Commit 记录
          </div>
          <SearchSelect
            v-else
            data-test="pick-commit"
            v-model="commit"
            :options="commitOptions"
            placeholder="搜索并选择 Commit…"
            empty-text="没有匹配的 Commit"
            class="h-9 max-w-[620px] text-xs"
          />
        </section>

        <Button data-test="add-to-plan" @click="addToPlan">
          加入批量计划{{ branch ? `（${branch}）` : "" }}
        </Button>
      </template>

      <p v-if="error" class="text-xs text-danger">{{ error }}</p>
    </div>

    <!-- 右：批量计划清单 -->
    <aside class="w-[430px] shrink-0 space-y-3">
      <div class="flex items-center justify-between">
        <div class="text-xs font-semibold">
          批量计划（{{ plan.length }} 项<span v-if="envCount > 1"> · 跨 {{ envCount }} 个环境</span>）
        </div>
        <button
          v-if="plan.length > 0"
          data-test="clear-plan"
          class="text-[11px] text-text-muted hover:text-danger"
          @click="clearPlan"
        >
          清空
        </button>
      </div>

      <div v-if="plan.length === 0" class="text-[11px] text-text-muted py-6 text-center border border-dashed border-border rounded-md">
        还没有任务。左边选好项目后点「加入批量计划」。
      </div>

      <div v-else class="space-y-2 max-h-[52vh] overflow-auto pr-1">
        <div
          v-for="(item, index) in plan"
          :key="item.key"
          data-test="plan-item"
          class="rounded-md border border-border bg-surface px-3 py-2 space-y-2"
        >
          <div class="flex items-start gap-2">
            <span class="text-[11px] text-text-muted shrink-0">{{ index + 1 }}</span>
            <div class="flex-1 min-w-0">
              <div class="text-xs truncate" :title="item.projectName">{{ item.projectName }}</div>
              <div class="text-[11px] text-text-muted truncate">
                {{ item.envName }} · {{ item.deployType === "auto" ? "自动化" : "Docker" }}
              </div>
            </div>
            <button
              data-test="remove-item"
              class="text-[11px] text-text-muted hover:text-danger shrink-0"
              title="从计划中移除"
              @click="removeFromPlan(item)"
            >
              移除
            </button>
          </div>

          <div v-if="item.loading" class="text-[11px] text-text-muted">加载分支与 commit…</div>
          <template v-else>
            <SearchSelect
              :data-test="`item-branch-${index}`"
              :model-value="item.branch"
              :options="item.branches.map((b) => ({ value: b, label: b }))"
              placeholder="选择分支…"
              empty-text="没有匹配的分支"
              class="h-8 text-xs"
              @update:model-value="(v: string) => changeItemBranch(item, v)"
            />
            <SearchSelect
              :data-test="`item-commit-${index}`"
              v-model="item.commit"
              :options="
                item.commits.map((c) => ({
                  value: c.fullString,
                  label: `${c.hash.slice(0, 8)} ${c.message}`,
                }))
              "
              placeholder="选择 commit…"
              empty-text="没有匹配的 commit"
              class="h-8 text-xs"
            />
          </template>

          <p v-if="item.invalid" class="text-[11px] text-danger">{{ item.invalid }}</p>
          <p v-else-if="item.error" class="text-[11px] text-danger">{{ item.error }}</p>
        </div>
      </div>

      <label class="flex items-start gap-2 text-xs">
        <input v-model="autoOnline" type="checkbox" class="mt-0.5" data-test="auto-online" />
        <span>
          计划内任务构建成功后<strong>自动上线</strong>
          <span class="text-text-muted">（默认关闭）</span>
        </span>
      </label>
      <p
        v-if="autoOnline"
        data-test="auto-online-warning"
        class="text-[11px] text-danger leading-relaxed border border-danger/40 bg-danger/10 rounded-md px-3 py-2"
      >
        ⚠️ 已开启自动上线：这 {{ completeItems.length }} 个任务<strong>一旦构建成功就会立刻上线</strong>，
        期间不会再问你（计划里可能包含正式环境）。确认无误再提交。
      </p>

      <div class="space-y-2">
        <Button
          data-test="batch-submit"
          class="w-full"
          :disabled="submitting || completeItems.length === 0"
          @click="confirmOpen = true"
        >
          {{ submitting ? "提交中…" : `提交 ${completeItems.length} 个部署` }}
        </Button>
        <div class="flex gap-2">
          <Button
            data-test="save-fav"
            variant="outline"
            class="flex-1"
            :disabled="plan.length === 0"
            @click="openSaveDialog"
          >
            {{ loadedFavId ? "保存修改到收藏" : "存为批量收藏" }}
          </Button>
        </div>
        <p v-if="loadedFavId" class="text-[11px] text-text-muted">
          正在编辑收藏「{{ loadedFavName }}」
        </p>
        <p v-if="plan.length > completeItems.length" class="text-[11px] text-warning">
          有 {{ plan.length - completeItems.length }} 项还不能提交（见上面的红字）
        </p>
        <p v-if="submitted" class="text-[11px] text-success">
          已提交，任务列表可见；构建结果会汇总成一条系统通知
        </p>
      </div>

      <!-- 最近批次进度 -->
      <div v-if="batches.runs.length > 0" class="space-y-1 pt-2 border-t border-border">
        <div class="text-[11px] font-semibold">最近批次</div>
        <div v-for="run in batches.runs.slice(-2)" :key="run.id" class="text-[11px] space-y-1">
          <div class="text-text-muted">
            {{ run.items.length }} 项{{ run.autoOnline ? " · 自动上线已开" : "" }}{{
              run.notified ? " · 已汇总通知" : ""
            }}
          </div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="i in run.items"
              :key="i.projectId"
              class="px-1.5 py-0.5 rounded border border-border bg-surface-2"
            >
              {{ i.projectName }}：
              <template v-if="i.result === 'success'"><span class="text-success">成功</span></template>
              <template v-else-if="i.result === 'failed'"><span class="text-danger">失败</span></template>
              <template v-else-if="i.taskId !== undefined">构建中…</template>
              <template v-else>已提交</template>
              <template v-if="i.online === 'ok'"> · 已上线</template>
              <template v-else-if="i.online === 'failed'"> · 上线失败</template>
            </span>
          </div>
        </div>
      </div>
    </aside>

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="确认提交批量计划？"
      :description="`${completeItems.length} 个部署${envCount > 1 ? `（跨 ${envCount} 个环境）` : ''}${
        autoOnline ? '\n已开启自动上线：构建成功即自动上线' : ''
      }`"
      :confirm-text="`提交 ${completeItems.length} 个`"
      :loading="submitting"
      @confirm="doSubmit"
    />

    <!-- 保存批量收藏：需要输入名字，所以不用 ConfirmDialog（那个只有确认/取消） -->
    <Dialog :open="saveOpen" @update:open="(v: boolean) => (saveOpen = v)">
      <DialogContent class="max-w-[400px]">
        <DialogHeader>
          <DialogTitle>保存为批量收藏</DialogTitle>
          <DialogDescription>
            共 {{ plan.length }} 项（{{ envCount }} 个环境）
            <br />
            收藏只记「类型 + 环境 + 项目 + 分支」，不记 commit（提交时取各自最新）也不记自动上线开关。
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-1.5">
          <Label for="batch-fav-name">名称</Label>
          <Input
            id="batch-fav-name"
            v-model="favName"
            data-test="fav-name"
            placeholder="例如：dramafinds 发版"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" @click="saveOpen = false">取消</Button>
          <Button v-if="loadedFavId" variant="outline" @click="saveFavorite(true)">
            另存为新收藏
          </Button>
          <Button :disabled="!favName.trim()" @click="saveFavorite(false)">
            {{ loadedFavId ? "保存修改" : "保存" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="删除这条批量收藏？"
      :description="deleteTarget ? deleteTarget.name : ''"
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
