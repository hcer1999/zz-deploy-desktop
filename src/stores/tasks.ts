import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { fetchTaskList } from "@/api/deploy";
import type { DeployType } from "@/api/deploy";
import type { DeployTask, PageInfo } from "@/api/parser";
import { toUserMessage } from "@/api/http";

export const useTasksStore = defineStore("tasks", () => {
  const deployType = ref<DeployType>("auto");
  const page = ref(1);
  const search = ref("");
  const tasks = ref<DeployTask[]>([]);
  const pageInfo = ref<PageInfo>({
    currentPage: 1,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
  });
  const loading = ref(false);
  const error = ref("");

  /**
   * 拉取当前条件下的列表。
   *
   * 失败只记录到 error，**不抛给调用方**——它同时被轮询和按钮调用，
   * 抛异常会变成未捕获的 promise rejection。
   */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const r = await fetchTaskList(deployType.value, page.value, search.value);
      tasks.value = r.tasks;
      pageInfo.value = r.pageInfo;
    } catch (e) {
      error.value = toUserMessage(e);
    } finally {
      loading.value = false;
    }
  }

  async function setDeployType(t: DeployType): Promise<void> {
    if (deployType.value === t) return;
    deployType.value = t;
    page.value = 1;
    await refresh();
  }

  async function applySearch(q: string): Promise<void> {
    search.value = q;
    page.value = 1;
    await refresh();
  }

  async function goPage(p: number): Promise<void> {
    if (p < 1 || p > pageInfo.value.totalPages || p === page.value) return;
    page.value = p;
    await refresh();
  }

  /** 删除成功后本地移除，避免为了刷新多打一次请求（列表随后会被轮询刷新） */
  function removeLocal(taskId: number): void {
    tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
  }

  /** 当前页 ±2 的页码窗口，已按上下界裁剪 */
  function pageWindow(): number[] {
    const { currentPage, totalPages } = pageInfo.value;
    const from = Math.max(1, currentPage - 2);
    const to = Math.min(totalPages, currentPage + 2);
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  }

  return {
    deployType,
    page,
    search,
    tasks,
    pageInfo,
    loading,
    error,
    refresh,
    setDeployType,
    applySearch,
    goPage,
    removeLocal,
    pageWindow,
  };
});

// Pinia 的 HMR 支持。
// 没有它时，Vite 热更新只替换模块，**已创建的 store 实例仍是旧定义**，
// 表现为改了 store 却在界面上拿到 undefined 的方法
// （实测报错：tasks.refresh is not a function）。加这段后新定义立即生效。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTasksStore, import.meta.hot));
}
