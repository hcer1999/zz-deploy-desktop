import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import { fetchTaskList } from "@/api/deploy";
import type { DeployType } from "@/api/deploy";
import type { DeployTask, PageInfo } from "@/api/parser";
import { toUserMessage } from "@/api/http";

export const useTasksStore = defineStore("tasks", () => {
  const deployType = ref<DeployType>("auto");
  const page = ref(1);
  const search = ref("");
  /** 0 = 全部环境。筛选条件不持久化：每次启动都从"全部"开始 */
  const envId = ref(0);
  /**
   * 环境目录按部署类型分开存：服务端的自动化与 Docker 是两条路由，
   * 各自维护一份环境列表（条数与名字都不一样），混用会拿到不属于该路由的 env id。
   */
  const envsByType = ref<Record<DeployType, { id: number; name: string }[]>>({
    auto: [],
    docker: [],
  });
  const envs = computed(() => envsByType.value[deployType.value]);
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
   * 当前登录人的显示名，随任务列表一起从服务端页面解析（见 parseTaskList）。
   * 构建完成通知用它过滤出「我提交的任务」。
   */
  const currentUser = ref("");
  /**
   * 最后一次**成功**刷新的时间。
   * 放在 store 而不是视图里：手动刷新与轮询都走 refresh()，
   * 视图自己记的话轮询路径就更新不到（实测踩过）。
   */
  const lastRefreshedAt = ref<Date | null>(null);

  // ---- 轮询 ----
  const offline = ref(false);
  const pollIntervalSecs = ref(60);
  let timer: ReturnType<typeof setInterval> | undefined;
  let consecutiveFailures = 0;
  /** 连续失败到这个次数就停止轮询并转离线，避免离线时一直无效打服务端 */
  const MAX_CONSECUTIVE_FAILURES = 3;

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
      const r = await fetchTaskList(deployType.value, page.value, {
        search: search.value,
        envId: envId.value,
      });
      tasks.value = r.tasks;
      pageInfo.value = r.pageInfo;
      // 空目录不覆盖：某次页面缺导航栏时别把已经学到的下拉清空
      if (r.envs.length) envsByType.value[deployType.value] = r.envs;
      // 空值不覆盖：个别页面若缺导航栏，别把已经学到的身份清掉
      if (r.currentUser) currentUser.value = r.currentUser;
      consecutiveFailures = 0;
      offline.value = false;
      lastRefreshedAt.value = new Date();
    } catch (e) {
      error.value = toUserMessage(e);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        offline.value = true;
        // 停止轮询；恢复由用户手动点「刷新」触发
        stopPolling();
      }
    } finally {
      loading.value = false;
    }
  }

  /** 启动轮询。重复调用不会叠加定时器 */
  function startPolling(intervalSecs: number): void {
    pollIntervalSecs.value = intervalSecs;
    stopPolling();
    timer = setInterval(() => {
      void refresh();
    }, intervalSecs * 1000);
  }

  function stopPolling(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  async function setDeployType(t: DeployType): Promise<void> {
    if (deployType.value === t) return;
    deployType.value = t;
    page.value = 1;
    // 两套路由的环境目录不通用：留着旧 env id 会把不属于该路由的筛选条件发过去
    envId.value = 0;
    await refresh();
  }

  async function setEnv(id: number): Promise<void> {
    if (envId.value === id) {
      page.value = 1;
      await refresh();
      return;
    }
    envId.value = id;
    page.value = 1;
    await refresh();
  }

  async function clearFilters(): Promise<void> {
    search.value = "";
    envId.value = 0;
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
    envId,
    envsByType,
    envs,
    tasks,
    pageInfo,
    loading,
    error,
    currentUser,
    offline,
    lastRefreshedAt,
    pollIntervalSecs,
    refresh,
    startPolling,
    stopPolling,
    setDeployType,
    setEnv,
    clearFilters,
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
