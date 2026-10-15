<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { submitOnline, submitRollback, submitRebuild, deleteTask } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import type { DeployTask } from "@/api/parser";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import { setOpenLog } from "@/stores/tabPayload";
import { useSettingsStore } from "@/stores/settings";
import StatusBadge from "@/components/common/StatusBadge.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const tasks = useTasksStore();
const tabs = useTabsStore();
const settings = useSettingsStore();
const searchDraft = ref(tasks.search);

/** 本标签是否为当前激活标签 */
function isActive(): boolean {
  return tabs.activeTab?.kind === "list";
}

/**
 * 变为可见：拉一次最新数据并启动轮询。
 * 变为不可见：停掉轮询，避免在后台空转打服务端。
 *
 * 为什么不能只靠 onMounted：任务列表是**单例标签**，TabHost 用 v-show
 * 隐藏而非卸载它，所以组件只挂载一次，切回来时 onMounted 不会重跑。
 *
 * 曾经的写法是「onMounted 里判断列表为空才拉」，导致实测问题：
 * 提交部署后自动跳转到任务列表，看到的却是提交前的旧列表，
 * 必须手动点一次「刷新」才看得到刚提交的任务。
 *
 * 首次挂载时 activeId 已经是本标签，watch 不会触发（无变化），
 * 由 onMounted 负责，因此不会重复请求。
 */
function syncVisibility(): void {
  if (isActive()) {
    void tasks.refresh();
    tasks.startPolling(settings.pollIntervalSecs);
  } else {
    tasks.stopPolling();
  }
}

onMounted(syncVisibility);
watch(() => tabs.activeId, syncVisibility);
onUnmounted(() => tasks.stopPolling());

// Cmd/Ctrl+R：只刷新当前页，不做整窗重载（那是浏览器行为，在桌面端没意义）
function onRefreshShortcut(): void {
  if (isActive()) void tasks.refresh();
}
onMounted(() => window.addEventListener("app://refresh", onRefreshShortcut));
onUnmounted(() => window.removeEventListener("app://refresh", onRefreshShortcut));

async function doRefresh(): Promise<void> {
  await tasks.refresh();
}

/** 最后成功刷新时间由 store 记录，手动与轮询两条路径都会更新 */
const lastRefreshText = computed(() =>
  tasks.lastRefreshedAt ? tasks.lastRefreshedAt.toLocaleTimeString("zh-CN") : "",
);

const typeLabel = computed(() => (tasks.deployType === "auto" ? "自动化" : "Docker"));

// ---------- 构建日志标签 ----------

/**
 * 每个 taskId 一个日志标签；已存在则聚焦（tabs.open 的 log 分支按 taskId 去重）。
 *
 * 参数经 tabPayload 传给 LogView：LogView 在 onMounted 时取一次，
 * 之后靠 session_id 收事件，不参与响应式渲染。
 */
function openLogTab(t: DeployTask): void {
  const id = tabs.open({
    kind: "log",
    taskId: t.taskId,
    deployType: tasks.deployType,
    projectName: t.projectName,
  });
  setOpenLog(id, {
    taskId: t.taskId,
    deployType: tasks.deployType,
    projectName: t.projectName,
    envName: t.envName,
  });
}

// ---------- 行内操作 ----------

type ActionKind = "online" | "rollback" | "rebuild" | "delete";
const pending = ref<{ kind: ActionKind; task: DeployTask } | null>(null);
const actionBusy = ref(false);
const flash = ref("");

const ACTION_TEXT: Record<
  ActionKind,
  { title: string; confirm: string; danger: boolean; done: string }
> = {
  online: { title: "确认上线？", confirm: "上线", danger: false, done: "已触发上线" },
  rollback: { title: "确认回滚？", confirm: "回滚", danger: false, done: "已触发回滚" },
  rebuild: {
    title: "确认重新构建？",
    confirm: "重新构建",
    danger: false,
    done: "已触发重新构建",
  },
  delete: { title: "确认删除？", confirm: "删除", danger: true, done: "已删除" },
};

/** 四个动作的接口形状一致（type, taskId）→ boolean，所以直接按 kind 取函数 */
const ACTIONS: Record<ActionKind, typeof submitOnline> = {
  online: submitOnline,
  rollback: submitRollback,
  rebuild: submitRebuild,
  delete: deleteTask,
};

function ask(kind: ActionKind, task: DeployTask): void {
  pending.value = { kind, task };
}

async function runAction(): Promise<void> {
  const p = pending.value;
  if (!p) return;
  actionBusy.value = true;
  try {
    const fn = ACTIONS[p.kind];
    const ok = await fn(tasks.deployType, p.task.taskId);
    if (!ok) {
      // 会话过期也会走到这里（isActionOk 已排除登录跳转），
      // 不再是插件那种"误报成功"
      flash.value = "操作失败，请重试";
      return;
    }
    flash.value = ACTION_TEXT[p.kind].done;
    if (p.kind === "delete") tasks.removeLocal(p.task.taskId);
    pending.value = null;
    await tasks.refresh();
  } catch (e) {
    flash.value = toUserMessage(e);
  } finally {
    actionBusy.value = false;
    setTimeout(() => (flash.value = ""), 3000);
  }
}
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
      <span v-if="lastRefreshText" class="text-[11px] text-text-muted">
        {{ typeLabel }} · 最后刷新 {{ lastRefreshText }}
      </span>
    </div>

    <p v-if="tasks.error" class="text-xs text-danger">{{ tasks.error }}</p>

    <p v-if="tasks.offline" class="text-xs text-warning">
      连续多次请求失败，已停止自动刷新。请检查内网连接后点「刷新」重试。
    </p>

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
              <div class="flex items-center gap-1">
                <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="openLogTab(t)">
                  Log
                </Button>
                <Button
                  v-if="t.canUp"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="ask('online', t)"
                >
                  上线
                </Button>
                <Button
                  v-if="t.canRoll"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="ask('rollback', t)"
                >
                  回滚
                </Button>
                <!--
                  只有构建失败的任务才能重新构建。服务端只给「构建状态」的文案，
                  没有结构化的失败标志位，所以按关键字判断（与 StatusBadge 同一套约定）。
                -->
                <Button
                  v-if="t.buildStatus.includes('失败')"
                  data-test="rebuild"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="ask('rebuild', t)"
                >
                  重新构建
                </Button>
                <Button
                  v-if="t.canDelete"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px] text-danger hover:text-danger"
                  @click="ask('delete', t)"
                >
                  删除
                </Button>
              </div>
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

    <ConfirmDialog
      :open="pending !== null"
      :title="pending ? ACTION_TEXT[pending.kind].title : ''"
      :description="pending ? `${pending.task.projectName} · ${pending.task.envName}` : ''"
      :confirm-text="pending ? ACTION_TEXT[pending.kind].confirm : '确认'"
      :danger="pending ? ACTION_TEXT[pending.kind].danger : false"
      :loading="actionBusy"
      @update:open="
        (v: boolean) => {
          if (!v) pending = null;
        }
      "
      @confirm="runAction"
    />

    <p v-if="flash" class="text-xs text-success">{{ flash }}</p>
  </div>
</template>
