<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ENVS, fetchProjects, fetchBranches, fetchCommits } from "@/api/deploy";
import type { CommitInfo, DeployType, Project } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import EnvPicker from "@/components/deploy/EnvPicker.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/*
 * 状态全部放在组件本地：每个向导标签渲染一个独立实例，
 * 因此天然是"每个标签一份状态"，不需要额外的 store 或 tabId 映射。
 */
const deployType = ref<DeployType>("auto");
const envId = ref<number | null>(null);
const projects = ref<Project[] | null>(null);
const projectSearch = ref("");
const selectedProject = ref<Project | null>(null);
const branches = ref<string[]>([]);
const selectedBranch = ref("");
const commits = ref<CommitInfo[]>([]);
const selectedCommit = ref("");
const title = ref("");

const loading = ref({ projects: false, branches: false, commits: false });
const error = ref("");

const envName = computed(() => ENVS.find((e) => e.id === envId.value)?.name ?? "");

const filteredProjects = computed(() => {
  const q = projectSearch.value.trim().toLowerCase();
  const list = projects.value ?? [];
  return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
});

/** 换了部署类型或环境，后面所有选择都要清空——两套路由的项目 id 不通用 */
watch([deployType, envId], async ([, env]) => {
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
});

function resetAfterProject(): void {
  branches.value = [];
  selectedBranch.value = "";
  commits.value = [];
  selectedCommit.value = "";
}

async function pickProject(p: Project): Promise<void> {
  selectedProject.value = p;
  resetAfterProject();
  error.value = "";
  loading.value.branches = true;
  try {
    branches.value = await fetchBranches(deployType.value, p.id);
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    loading.value.branches = false;
  }
}

async function pickBranch(branch: string): Promise<void> {
  selectedBranch.value = branch;
  commits.value = [];
  selectedCommit.value = "";
  if (!selectedProject.value || !branch) return;
  error.value = "";
  loading.value.commits = true;
  try {
    commits.value = await fetchCommits(selectedProject.value.name, branch);
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    loading.value.commits = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <h1 class="text-base font-semibold">新建部署</h1>

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
        <Label>项目（{{ filteredProjects.length }} / {{ projects.length }}）</Label>
        <Input v-model="projectSearch" placeholder="搜索项目…" class="w-56 h-8" />
      </div>
      <div v-if="projects.length === 0" class="text-xs text-text-muted">该环境下没有项目</div>
      <div v-else class="flex flex-wrap gap-2 max-h-[240px] overflow-auto p-1">
        <Button
          v-for="p in filteredProjects"
          :key="p.id"
          :variant="selectedProject?.id === p.id ? 'default' : 'secondary'"
          size="sm"
          class="text-xs"
          @click="pickProject(p)"
        >
          {{ p.name }}
        </Button>
      </div>
    </section>

    <section v-if="selectedProject" class="space-y-2">
      <Label>分支</Label>
      <div v-if="loading.branches" class="text-xs text-text-muted">正在加载分支…</div>
      <div v-else-if="branches.length === 0" class="text-xs text-text-muted">未找到分支</div>
      <div v-else class="flex flex-wrap gap-2 max-h-[180px] overflow-auto p-1">
        <Button
          v-for="b in branches"
          :key="b"
          :variant="selectedBranch === b ? 'default' : 'secondary'"
          size="sm"
          class="text-xs font-mono"
          @click="pickBranch(b)"
        >
          {{ b }}
        </Button>
      </div>
    </section>

    <section v-if="selectedBranch" class="space-y-2">
      <Label>Commit</Label>
      <div v-if="loading.commits" class="text-xs text-text-muted">正在加载 Commit…</div>
      <div v-else-if="commits.length === 0" class="text-xs text-text-muted">未找到 Commit 记录</div>
      <select
        v-else
        v-model="selectedCommit"
        class="w-full max-w-[760px] h-9 rounded-md border border-border bg-surface px-2 text-xs font-mono"
      >
        <option value="">-- 选择 Commit --</option>
        <option v-for="c in commits" :key="c.fullString" :value="c.fullString">
          {{ c.hash.slice(0, 8) }} {{ c.message }}
        </option>
      </select>
    </section>

    <section v-if="selectedCommit" class="pt-2 border-t border-border space-y-2">
      <Label for="deploy-title">任务标题（留空则由服务端生成）</Label>
      <Input id="deploy-title" v-model="title" class="h-8 max-w-[760px]" placeholder="可选" />
      <p class="text-xs text-text-muted">
        即将部署：{{ envName }} / {{ selectedProject?.name }} / {{ selectedBranch }}
      </p>
    </section>

    <p v-if="error" class="text-xs text-danger">{{ error }}</p>
  </div>
</template>
