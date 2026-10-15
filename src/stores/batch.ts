import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import { fetchTaskList, submitOnline } from "@/api/deploy";
import type { DeployType } from "@/api/deploy";
import type { DeployTask } from "@/api/parser";
import { terminalState } from "@/lib/taskStatus";
import { sendSystemNotification } from "@/lib/notify";

/**
 * 批量部署的「一次提交」记录 + 结算。
 *
 * 为什么需要它：服务端提交接口只回 302、**不返回新建任务的 taskId**
 * （见 spec §4.2）。而「整批构建完只弹一条通知」与「构建成功即自动上线」
 * 都必须知道哪些任务属于这一批，所以提交后按
 * `commit hash + 分支 + 比 baseline 新的 taskId` 去任务列表里**认领**新行。
 *
 * 认领不到不会静默丢东西：那种任务照常走单条通知（本 store 没认领就没抑制）。
 *
 * 轮询放在这里而不是复用任务列表的轮询：任务列表只轮询**当前标签**的类型，
 * 用户切去看 docker 时 auto 的批次就停止更新，汇总通知会永远等不到。
 */

export interface BatchItem {
  /** 每项自带部署类型：一份计划可以同时有自动化和 Docker 的项 */
  deployType: DeployType;
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  branch: string;
  /** 提交时用的 commit 全串（hash + 分隔符 + message）：比对时只看 hash 部分 */
  version: string;
  /** 认领到的 taskId；一直 undefined 表示没能定位（UI 里会标出来） */
  taskId?: number;
  /** 构建终态；只有被观察到才有值 */
  result?: "success" | "failed";
  /** 自动上线：undefined 未尝试 / pending 进行中 / ok / failed */
  online?: "pending" | "ok" | "failed";
}

export interface BatchRun {
  id: string;
  at: number;
  /** 开启后：本批任务构建成功即自动上线（默认关，UI 上有醒目警告） */
  autoOnline: boolean;
  /**
   * 提交前**每种部署类型**各自的最大 taskId：只认比它新的任务，
   * 避免认领到别人更早的同类部署。计划可以混类型，所以按类型分别记。
   */
  baselines: Partial<Record<DeployType, number>>;
  items: BatchItem[];
  notified: boolean;
}

/** 提交用的是 `hash#-----#message`，任务列表里只有纯 hash —— 只比 hash 部分 */
export function commitHash(version: string): string {
  return version.split("#-----#")[0] || version;
}

/**
 * 认领判据：
 * - 必须比 baseline 新（避免认到别人更早的同版本部署）
 * - commit hash 对得上（列表里可能是完整 40 位，也可能是短 hash，两边都试）
 * - 分支对得上（列表里拿不到分支时跳过这一条，不因此否掉整个候选）
 */
function matches(item: BatchItem, task: DeployTask, baseline: number): boolean {
  if (item.taskId !== undefined) return false;
  if (task.taskId <= baseline) return false;
  const h = commitHash(item.version);
  if (!task.version) return false;
  if (!(task.version.startsWith(h) || h.startsWith(task.version))) return false;
  if (item.branch && task.branch && item.branch !== task.branch) return false;
  return true;
}

/** 一个批次多久没进展就当作「剩下那些认领不到了」，把已有结果先汇总掉 */
export const BATCH_TTL_MS = 30 * 60 * 1000;
/** 批次活跃时的轮询间隔（只为结算这一批，不看用户当前在哪个标签） */
export const BATCH_POLL_MS = 10_000;

export const useBatchStore = defineStore("batch", () => {
  const runs = ref<BatchRun[]>([]);
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  function start(opts: {
    autoOnline: boolean;
    baselines: Partial<Record<DeployType, number>>;
    items: Omit<BatchItem, "taskId" | "result" | "online">[];
  }): BatchRun {
    seq += 1;
    const run: BatchRun = {
      id: `batch-${seq}`,
      at: Date.now(),
      autoOnline: opts.autoOnline,
      baselines: { ...opts.baselines },
      items: opts.items.map((i) => ({ ...i })),
      notified: false,
    };
    runs.value.push(run);
    startWatching();
    return run;
  }

  /** 还没发汇总的批次 */
  function active(): BatchRun[] {
    return runs.value.filter((r) => !r.notified);
  }

  /** 这条任务是否属于某个批次（属于的话，单条通知抑制掉，交给批次统一通知） */
  function claimsTask(taskId: number): boolean {
    return runs.value.some((r) => r.items.some((i) => i.taskId === taskId));
  }

  function itemOfTask(taskId: number): { run: BatchRun; item: BatchItem } | undefined {
    for (const run of runs.value) {
      const item = run.items.find((i) => i.taskId === taskId);
      if (item) return { run, item };
    }
    return undefined;
  }

  /** 标记「正在尝试自动上线」；已经尝试过返回 false（防止两个触发点重复上线） */
  function beginOnline(item: BatchItem): boolean {
    if (item.online !== undefined) return false;
    item.online = "pending";
    return true;
  }

  /**
   * 自动上线：**必须在构建成功之后**。
   * 列表里的上线入口只有构建成功后才由服务端给出（`canUp`），提交完立刻上线必然失败。
   * 所以这里是"构建成功即自动上线"，而不是"提交后立刻上线"。
   */
  async function autoOnline(run: BatchRun, item: BatchItem, taskId: number): Promise<void> {
    if (!run.autoOnline) return;
    if (!beginOnline(item)) return;
    try {
      item.online = (await submitOnline(item.deployType, taskId)) ? "ok" : "failed";
    } catch {
      item.online = "failed";
    }
  }

  /** 汇总一条通知（先置 notified，避免并发重复发） */
  async function notifyRun(run: BatchRun, partial = false): Promise<void> {
    if (run.notified) return;
    run.notified = true;

    const settled = run.items.filter((i) => i.result !== undefined);
    const ok = settled.filter((i) => i.result === "success").length;
    const failed = settled.filter((i) => i.result === "failed");
    const onlined = run.items.filter((i) => i.online === "ok").length;

    const envCount = new Set(run.items.map((i) => i.envName)).size;
    const scope = envCount > 1 ? `${run.items.length} 个任务（跨 ${envCount} 个环境）` : `${run.items.length} 个任务`;
    const head = partial
      ? `批量部署：已收到 ${settled.length}/${run.items.length} 个结果（${ok} 成功 / ${failed.length} 失败）`
      : `批量部署：${scope}全部结束（${ok} 成功 / ${failed.length} 失败）`;

    const tail = [
      run.autoOnline ? `已自动上线 ${onlined} 个` : "",
      failed.length
        ? `失败：${failed
            .slice(0, 3)
            .map((i) => i.projectName)
            .join("、")}${failed.length > 3 ? " 等" : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");

    await sendSystemNotification({
      title: run.autoOnline ? "批量部署完成（含自动上线）" : "批量部署完成",
      body: [head, tail].filter(Boolean).join("\n"),
    });
  }

  /**
   * 跑一轮：拉一次该批次类型的任务列表 → 认领 → 记终态 → 该汇总就汇总。
   *
   * 只拉第 1 页（最新的在前面）：刚提交的任务一定在第一页。
   */
  async function tick(): Promise<void> {
    for (const run of active()) {
      // 已经有定论的批次不用再拉
      if (run.items.every((i) => i.result !== undefined)) continue;

      // 计划可能同时有 auto 与 docker 的项：每种类型各拉一次（刚提交的都在第 1 页）
      const types = [...new Set(run.items.map((i) => i.deployType))];
      for (const deployType of types) {
        const baseline = run.baselines[deployType] ?? 0;
        let tasks: DeployTask[];
        try {
          tasks = (await fetchTaskList(deployType, 1, "")).tasks;
        } catch {
          continue; // 离线/超时就等下一轮
        }

        for (const t of tasks) {
          const unclaimed = run.items.find(
            (i) => i.deployType === deployType && matches(i, t, baseline),
          );
          if (unclaimed) unclaimed.taskId = t.taskId;

          const mine = run.items.find((i) => i.taskId === t.taskId);
          if (!mine || mine.result !== undefined) continue;

          const state = terminalState(t);
          if (!state) continue;
          // 成功才上线；先上线再记结果，汇总里的「已自动上线 N 个」才不会漏掉最后一个
          if (state === "success") await autoOnline(run, mine, t.taskId);
          mine.result = state;
        }
      }
    }

    // 全部有定论 → 汇总
    for (const run of runs.value) {
      if (!run.notified && run.items.every((i) => i.result !== undefined)) {
        await notifyRun(run);
      }
    }
    // 超时兜底：认领不到的那几个不能让汇总永远等下去
    for (const run of flushStale()) await notifyRun(run, true);

    if (active().length === 0) stopWatching();
  }

  /**
   * 超时兜底：有些任务可能一直认领不到（服务端没生成、列表被翻页等）。
   * 超过 TTL 且至少认领到过一个 → 交给调用方汇总；一个都没认领到则直接丢弃
   * （没认领就没抑制过单条通知，丢掉不会让用户少收东西）。
   */
  function flushStale(now: number = Date.now()): BatchRun[] {
    const out: BatchRun[] = [];
    for (const run of active()) {
      if (now - run.at < BATCH_TTL_MS) continue;
      if (run.items.some((i) => i.taskId !== undefined)) out.push(run);
      else run.notified = true;
    }
    return out;
  }

  function startWatching(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      void tick();
    }, BATCH_POLL_MS);
  }

  function stopWatching(): void {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  }

  /** 应用启动/打开批量页时调用：有未结算的批次就继续盯着 */
  function ensureWatching(): void {
    if (active().length > 0) startWatching();
  }

  /** 只给测试用：清空状态并停掉轮询 */
  function reset(): void {
    stopWatching();
    runs.value = [];
  }

  return {
    runs,
    start,
    active,
    claimsTask,
    itemOfTask,
    beginOnline,
    notifyRun,
    tick,
    flushStale,
    ensureWatching,
    stopWatching,
    reset,
  };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useBatchStore, import.meta.hot));
}
