import { acceptHMRUpdate, defineStore } from "pinia";
import { reactive } from "vue";
import * as api from "@/api/log";
import { createLogBuffer, flush, ingest, reset, type LogBuffer } from "@/lib/ansi";
import { ingestLarge, SYNC_INGEST_LIMIT } from "@/lib/logLoad";

export type LogState = "connecting" | "connected" | "disconnected" | "finished" | "error";

export interface LogSession {
  sessionId: string;
  taskId: number;
  projectName: string;
  envName: string;
  buffer: LogBuffer;
  state: LogState;
  /** 服务端的原话（失败时显示给自己看，如 `数据格式错误`） */
  detail: string;
  /** 最近一次收到数据的时间，用于"T 秒无输出"提示 */
  lastDataAt: number;
  /** 大块日志正在分片解析（界面可提示「载入中」，避免看起来像卡住） */
  ingesting: boolean;
}

/**
 * 日志会话表：sessionId → 会话。
 *
 * 用 reactive 而不是 ref<Record>：日志是高频率更新（每秒可能几十条），
 * 整体替换对象会让 Vue 追踪整棵子树；reactive 的细粒度依赖更省。
 * buffer 里的 lines 数组是原地 push/patch，配合 LogView 的 key 复用，
 * 不会每来一行就重绘整个列表。
 */
export const useLogsStore = defineStore("logs", () => {
  const sessions = reactive<Record<string, LogSession>>({});
  /**
   * 每个会话的串行处理队列。
   *
   * 大 chunk 会分片 + 让出主线程，期间后续事件必须排在它后面；
   * 否则小块会先落地，日志顺序就乱了。
   */
  const queues = new Map<string, Promise<void>>();

  function enqueue(sessionId: string, task: () => Promise<void> | void): Promise<void> {
    const prev = queues.get(sessionId) ?? Promise.resolve();
    const next = prev.then(task).catch(() => {
      // 队列里的单个任务失败不应卡死后续日志
    });
    queues.set(sessionId, next);
    void next.finally(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  }

  async function open(params: {
    taskId: number;
    deployType: "auto" | "docker";
    projectName: string;
    envName: string;
  }): Promise<string> {
    const sessionId = await api.logOpen(params);
    sessions[sessionId] = {
      sessionId,
      taskId: params.taskId,
      projectName: params.projectName,
      envName: params.envName,
      buffer: createLogBuffer(),
      state: "connecting",
      detail: "",
      lastDataAt: Date.now(),
      ingesting: false,
    };
    return sessionId;
  }

  /** 由 App.vue 的事件监听调用 */
  function onData(e: api.LogDataEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return; // 会话已关闭，事件还在路上，正常丢弃

    const applyHead = (): LogSession | undefined => {
      const cur = sessions[e.sessionId];
      if (!cur) return undefined; // 排队期间会话被关了
      // reset 才会清空：服务端换窗口时会整段重发
      if (e.reset) reset(cur.buffer);
      cur.lastDataAt = Date.now();
      if (cur.state === "connecting") cur.state = "connected";
      return cur;
    };

    // 小 chunk 且队列空闲：同步落地，实时日志不引入额外延迟
    if (!queues.has(e.sessionId) && e.chunk.length <= SYNC_INGEST_LIMIT) {
      const cur = applyHead();
      if (cur) ingest(cur.buffer, e.chunk);
      return;
    }

    // 大 chunk（或前面还有没处理完的大 chunk）：串行分片
    void enqueue(e.sessionId, async () => {
      const cur = applyHead();
      if (!cur) return;

      if (e.chunk.length <= SYNC_INGEST_LIMIT) {
        ingest(cur.buffer, e.chunk);
        return;
      }

      cur.ingesting = true;
      try {
        await ingestLarge(cur.buffer, e.chunk, {
          cancelled: () => !sessions[e.sessionId],
        });
      } finally {
        const latest = sessions[e.sessionId];
        if (latest) {
          latest.ingesting = false;
          latest.lastDataAt = Date.now();
        }
      }
    });
  }

  function onStatus(e: api.LogStatusEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return;
    s.state = e.state;
    s.detail = e.detail ?? "";
    // 流结束时最后一段没有换行的残留也要显示出来。
    // 必须排在已排队的日志块之后处理，否则会把还没解析完的半行提前收尾。
    if (e.state === "finished" || e.state === "disconnected") {
      const doFlush = (): void => {
        const cur = sessions[e.sessionId];
        if (cur) flush(cur.buffer);
      };
      if (queues.has(e.sessionId)) void enqueue(e.sessionId, doFlush);
      else doFlush();
    }
  }

  async function close(sessionId: string): Promise<void> {
    delete sessions[sessionId];
    await api.logClose(sessionId);
  }

  /** 标签关闭时用：一个任务可能对应过多个 session（重开过标签） */
  async function closeByTask(taskId: number): Promise<void> {
    const ids = Object.values(sessions)
      .filter((s) => s.taskId === taskId)
      .map((s) => s.sessionId);
    for (const id of ids) await close(id);
  }

  return { sessions, open, onData, onStatus, close, closeByTask };
});

// Pinia 的 HMR 支持。
// 没有它时，Vite 热更新只替换模块，**已创建的 store 实例仍是旧定义**，
// 表现为改了 store 却在界面上拿到 undefined 的方法
// （实测报错：tasks.refresh is not a function）。加这段后新定义立即生效。
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useLogsStore, import.meta.hot));
}
