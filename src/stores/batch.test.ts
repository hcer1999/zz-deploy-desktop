import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { DeployTask } from "@/api/parser";

const sendNotification = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: (o: unknown) => sendNotification(o),
  onAction: vi.fn(async () => ({ unlisten: () => {} })),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));

vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchTaskList: vi.fn(async () => ({
    tasks: [] as DeployTask[],
    pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    currentUser: "zhangsan",
  })),
  submitOnline: vi.fn(async () => true),
}));

import * as api from "@/api/deploy";
import { useBatchStore } from "./batch";

function task(id: number, over: Partial<DeployTask> = {}): DeployTask {
  return {
    taskId: id,
    title: "t",
    projectName: "proj-A",
    envName: "测试环境",
    cluster: "",
    deployType: "",
    branch: "origin/master",
    version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    onlineStatus: "未上线",
    buildStatus: "构建中",
    submitTime: "2026-10-15 10:00:00",
    submitter: "zhangsan",
    canUp: false,
    canRoll: false,
    canDelete: false,
    ...over,
  };
}

/** 造一个 2 项的批次（同一环境、同为自动化） */
function startRun(batches: ReturnType<typeof useBatchStore>, autoOnline = false) {
  return batches.start({
    autoOnline,
    baselines: { auto: 100 },
    items: [
      {
        deployType: "auto",
        envId: 1,
        envName: "测试环境",
        projectId: 1,
        projectName: "proj-A",
        branch: "origin/master",
        version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2#-----#修复",
      },
      {
        deployType: "auto",
        envId: 1,
        envName: "测试环境",
        projectId: 2,
        projectName: "proj-B",
        branch: "origin/master",
        version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb#-----#功能",
      },
    ],
  });
}

function mockTasks(tasks: DeployTask[]): void {
  vi.mocked(api.fetchTaskList).mockResolvedValue({
    tasks,
    pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    currentUser: "zhangsan",
  });
}

const SLEEP = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("batch store：认领与汇总", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sendNotification.mockClear();
  });

  it("按 commit hash 认领比 baseline 新的任务（列表里是纯 hash）", async () => {
    const b = useBatchStore();
    const run = startRun(b);

    mockTasks([
      task(101, { version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      // baseline 之内的旧任务不该被认领
      task(99, { version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
    ]);
    await b.tick();

    expect(run.items[0].taskId).toBe(101);
    expect(run.items[1].taskId).toBeUndefined();
    expect(b.claimsTask(101)).toBe(true);
    expect(b.claimsTask(99)).toBe(false);
  });

  it("全部任务有定论后只发一条汇总通知", async () => {
    const b = useBatchStore();
    const run = startRun(b);

    mockTasks([
      task(101, { buildStatus: "构建中", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, { buildStatus: "构建中", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);
    await b.tick();
    expect(sendNotification).not.toHaveBeenCalled(); // 还在构建：不发

    mockTasks([
      task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, { buildStatus: "构建失败", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);
    await b.tick();
    await SLEEP();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    const n = sendNotification.mock.calls[0][0] as { title: string; body: string };
    expect(n.title).toBe("批量部署完成");
    expect(n.body).toContain("2 个任务全部结束");
    expect(n.body).toContain("1 成功 / 1 失败");
    expect(n.body).toContain("proj-B");
    expect(run.notified).toBe(true);
  });

  it("自动上线只发生在构建成功之后，且每个任务只尝试一次", async () => {
    const b = useBatchStore();
    const run = startRun(b, true); // 开关打开

    // 还在构建 → 不上线
    mockTasks([
      task(101, { buildStatus: "构建中", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, { buildStatus: "构建中", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);
    await b.tick();
    expect(api.submitOnline).not.toHaveBeenCalled();

    // 成功 → 上线；失败的那个不碰
    mockTasks([
      task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, { buildStatus: "构建失败", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);
    await b.tick();
    await SLEEP();

    expect(api.submitOnline).toHaveBeenCalledTimes(1);
    expect(api.submitOnline).toHaveBeenCalledWith("auto", 101);
    expect(run.items[0].online).toBe("ok");
    expect(run.items[1].online).toBeUndefined();

    // 再跑一轮不会重复上线
    await b.tick();
    expect(api.submitOnline).toHaveBeenCalledTimes(1);
  });

  it("开关关闭时绝不上线", async () => {
    const b = useBatchStore();
    startRun(b, false);
    mockTasks([
      task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, { buildStatus: "构建成功", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);
    await b.tick();
    await SLEEP();
    expect(api.submitOnline).not.toHaveBeenCalled();
  });

  it("认领不到的任务不会让汇总永远等下去（超时兜底）", async () => {
    const b = useBatchStore();
    const run = startRun(b);
    mockTasks([task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" })]);
    await b.tick();
    expect(sendNotification).not.toHaveBeenCalled(); // 只认领到 1/2

    // 超过 TTL 后：把已有结果汇总成一条（partial）
    const stale = b.flushStale(Date.now() + 31 * 60 * 1000);
    expect(stale).toHaveLength(1);
    await b.notifyRun(stale[0], true);
    await SLEEP();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect((sendNotification.mock.calls[0][0] as { body: string }).body).toContain("已收到 1/2 个结果");
    expect(run.notified).toBe(true);
  });

  /// 计划可以跨部署类型：每种类型各自拉列表、各自用自己的 baseline
  it("混类型计划：按类型分别认领（各类型各自的 baseline）", async () => {
    const b = useBatchStore();
    const run = b.start({
      autoOnline: false,
      baselines: { auto: 100, docker: 500 },
      items: [
        {
          deployType: "auto",
          envId: 1,
          envName: "测试环境",
          projectId: 1,
          projectName: "proj-A",
          branch: "origin/master",
          version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2#-----#修复",
        },
        {
          deployType: "docker",
          envId: 2,
          envName: "正式环境",
          projectId: 2,
          projectName: "proj-B",
          branch: "origin/dev",
          version: "dddddddd1b2b3b4b5b6b7b8b9b0badddddddddd#-----#发布",
        },
      ],
    });

    // auto 的列表里出现 auto 项；docker 的列表里出现 docker 项
    vi.mocked(api.fetchTaskList).mockImplementation(async (type: string) => ({
      tasks:
        type === "auto"
          ? [task(101, { version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" })]
          : [
              task(501, {
                version: "dddddddd1b2b3b4b5b6b7b8b9b0badddddddddd",
                branch: "origin/dev",
                projectName: "proj-B",
              }),
            ],
      pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
      currentUser: "zhangsan",
    }));

    await b.tick();
    expect(run.items[0].taskId).toBe(101);
    expect(run.items[1].taskId).toBe(501);
    expect(vi.mocked(api.fetchTaskList)).toHaveBeenCalledWith("auto", 1, "");
    expect(vi.mocked(api.fetchTaskList)).toHaveBeenCalledWith("docker", 1, "");
  });

  it("一个任务都没认领到时超时后直接作废（不发空洞的汇总）", async () => {
    const b = useBatchStore();
    const run = startRun(b);
    mockTasks([]);
    await b.tick();

    const stale = b.flushStale(Date.now() + 31 * 60 * 1000);
    expect(stale).toHaveLength(0);
    expect(run.notified).toBe(true);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
