import { acceptHMRUpdate, defineStore } from "pinia";
import { reactive } from "vue";
import * as api from "@/api/log";
import { createLogBuffer, flush, ingest, type LogBuffer } from "@/lib/ansi";

export type LogState = "connecting" | "connected" | "disconnected" | "finished" | "error";

export interface LogSession {
  sessionId: string;
  taskId: number;
  projectName: string;
  envName: string;
  buffer: LogBuffer;
  state: LogState;
  /** 最近一次收到数据的时间，用于"T 秒无输出"提示 */
  lastDataAt: number;
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
      lastDataAt: Date.now(),
    };
    return sessionId;
  }

  /** 由 App.vue 的事件监听调用 */
  function onData(e: api.LogDataEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return; // 会话已关闭，事件还在路上，正常丢弃
    ingest(s.buffer, e.chunk);
    s.lastDataAt = Date.now();
    if (s.state === "connecting") s.state = "connected";
  }

  function onStatus(e: api.LogStatusEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return;
    s.state = e.state;
    // 流结束时最后一段没有换行的残留也要显示出来
    if (e.state === "finished" || e.state === "disconnected") flush(s.buffer);
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
