<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useTasksStore } from "@/stores/tasks";
import StatusBadge from "@/components/common/StatusBadge.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const tasks = useTasksStore();
const searchDraft = ref(tasks.search);

onMounted(async () => {
  // 只在还没有数据时拉一次；已有数据说明刚从向导跳过来或刚从别的标签切回来
  if (tasks.tasks.length === 0) await tasks.refresh();
});

const lastRefresh = ref("");
async function doRefresh(): Promise<void> {
  await tasks.refresh();
  lastRefresh.value = new Date().toLocaleTimeString("zh-CN");
}

const typeLabel = computed(() => (tasks.deployType === "auto" ? "自动化" : "Docker"));
</script>

<template>
  <div class="p-6 space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-base font-semibold">任务列表</h1>
      <div class="flex gap-1">
        <Button
          v-for="t in (['auto', 'docker'] as const)"
          :key="t"
          :variant="tasks.deployType === t ? 'default' : 'outline'"
          size="sm"
          @click="tasks.setDeployType(t)"
        >
          {{ t === "auto" ? "自动化" : "Docker" }}
        </Button>
      </div>
      <Input
        v-model="searchDraft"
        placeholder="搜索标题 / 项目 / 提交人…"
        class="w-64 h-8"
        @keyup.enter="tasks.applySearch(searchDraft)"
      />
      <Button variant="outline" size="sm" :disabled="tasks.loading" @click="doRefresh">
        {{ tasks.loading ? "刷新中…" : "刷新" }}
      </Button>
      <span v-if="lastRefresh" class="text-[11px] text-text-muted">
        {{ typeLabel }} · 最后刷新 {{ lastRefresh }}
      </span>
    </div>

    <p v-if="tasks.error" class="text-xs text-danger">{{ tasks.error }}</p>

    <div
      v-if="tasks.tasks.length === 0 && !tasks.loading"
      class="text-xs text-text-muted py-8 text-center"
    >
      暂无数据，点「刷新」加载
    </div>

    <div v-else class="overflow-x-auto rounded-md border border-border">
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="bg-surface-2 text-text-muted">
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">标题</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">项目</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">环境</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">分支</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">版本</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">上线状态</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">构建状态</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">提交人</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">时间</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in tasks.tasks"
            :key="t.taskId"
            class="border-t border-border hover:bg-surface-2"
          >
            <td class="px-3 py-2 max-w-[240px] truncate" :title="t.title">{{ t.title }}</td>
            <td
              class="px-3 py-2 font-mono text-[11px] max-w-[180px] truncate"
              :title="t.projectName"
            >
              {{ t.projectName }}
            </td>
            <td class="px-3 py-2 whitespace-nowrap">{{ t.envName }}</td>
            <td class="px-3 py-2 font-mono text-[11px] max-w-[160px] truncate" :title="t.branch">
              {{ t.branch }}
            </td>
            <td class="px-3 py-2 font-mono text-[11px]" :title="t.version">
              {{ t.version.slice(0, 8) }}
            </td>
            <td class="px-3 py-2"><StatusBadge :text="t.onlineStatus" /></td>
            <td class="px-3 py-2"><StatusBadge :text="t.buildStatus" kind="build" /></td>
            <td class="px-3 py-2 whitespace-nowrap">{{ t.submitter }}</td>
            <td class="px-3 py-2 whitespace-nowrap text-text-muted">{{ t.submitTime.slice(5) }}</td>
            <td class="px-3 py-2">
              <!-- 行内操作在 Task 9 接上 -->
              <span class="text-text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="tasks.pageInfo.totalPages > 1" class="flex items-center gap-1 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasPrev"
        @click="tasks.goPage(1)"
      >
        首页
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasPrev"
        @click="tasks.goPage(tasks.pageInfo.currentPage - 1)"
      >
        «
      </Button>
      <Button
        v-for="p in tasks.pageWindow()"
        :key="p"
        :variant="p === tasks.pageInfo.currentPage ? 'default' : 'outline'"
        size="sm"
        class="min-w-8"
        @click="tasks.goPage(p)"
      >
        {{ p }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasNext"
        @click="tasks.goPage(tasks.pageInfo.currentPage + 1)"
      >
        »
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasNext"
        @click="tasks.goPage(tasks.pageInfo.totalPages)"
      >
        尾页
      </Button>
      <span class="text-[11px] text-text-muted ml-2">共 {{ tasks.pageInfo.totalPages }} 页</span>
    </div>
  </div>
</template>
