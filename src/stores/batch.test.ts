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
    envs: [],
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
    envs: [],
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
      // 项目名必须对得上才认领：proj-B 的部署要对应 proj-B 的任务行
      task(102, {
        buildStatus: "构建中",
        projectName: "proj-B",
        version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb",
      }),
    ]);
    await b.tick();
    expect(sendNotification).not.toHaveBeenCalled(); // 还在构建：不发

    mockTasks([
      task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, {
        buildStatus: "构建失败",
        projectName: "proj-B",
        version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb",
      }),
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
      // 项目名必须对得上才认领：proj-B 的部署要对应 proj-B 的任务行
      task(102, {
        buildStatus: "构建中",
        projectName: "proj-B",
        version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb",
      }),
    ]);
    await b.tick();
    expect(api.submitOnline).not.toHaveBeenCalled();

    // 成功 → 上线；失败的那个不碰
    mockTasks([
      task(101, { buildStatus: "构建成功", version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2" }),
      task(102, {
        buildStatus: "构建失败",
        projectName: "proj-B",
        version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb",
      }),
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
      envs: [],
    }));

    await b.tick();
    expect(run.items[0].taskId).toBe(101);
    expect(run.items[1].taskId).toBe(501);
    expect(vi.mocked(api.fetchTaskList)).toHaveBeenCalledWith("auto", 1, {
      search: "",
      envId: 0,
    });
    expect(vi.mocked(api.fetchTaskList)).toHaveBeenCalledWith("docker", 1, {
      search: "",
      envId: 0,
    });
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

describe("单次部署的 single 批次", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    sendNotification.mockClear();
  });

  function startSingle(batches: ReturnType<typeof useBatchStore>, projectName = "proj-A") {
    return batches.start({
      kind: "single",
      autoOnline: true,
      baselines: { auto: 100 },
      items: [
        {
          deployType: "auto",
          envId: 1,
          envName: "测试环境",
          projectId: 1,
          projectName,
          branch: "origin/master",
          version: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2#-----#修复",
        },
      ],
    });
  }

  it("kind 默认是 batch，显式传 single 时记下来", () => {
    const b = useBatchStore();
    expect(startRun(b).kind).toBe("batch");
    expect(startSingle(b).kind).toBe("single");
    b.reset();
  });

  it("认领到任务且构建成功 → 自动上线，并汇总成一条可点击的通知", async () => {
    const b = useBatchStore();
    startSingle(b);
    mockTasks([task(101, { buildStatus: "构建成功" })]);

    await b.tick();

    expect(api.submitOnline).toHaveBeenCalledWith("auto", 101);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const payload = sendNotification.mock.calls[0][0] as { title: string; id?: number };
    expect(payload.title).toBe("部署完成（含自动上线）");
    // 单次部署的通知必须带 taskId，点通知才能定位到这次任务
    expect(payload.id).toBe(101);
    b.reset();
  });

  it("批量批次的汇总通知不带 taskId（没有单个任务可定位）", async () => {
    const b = useBatchStore();
    startRun(b);
    mockTasks([
      task(101, { buildStatus: "构建成功" }),
      task(102, { buildStatus: "构建失败", projectName: "proj-B", version: "bbbbbbbb1b2b3b4b5b6b7b8b9b0babbbbbbbbbb" }),
    ]);

    await b.tick();

    const payload = sendNotification.mock.calls[0][0] as { title: string; id?: number };
    expect(payload.title).toContain("批量部署");
    expect(payload.id).toBeUndefined();
    b.reset();
  });

  it("构建失败时不说已自动上线，也不说认领失败", async () => {
    const b = useBatchStore();
    startSingle(b);
    mockTasks([task(101, { buildStatus: "构建失败" })]);

    await b.tick();

    const payload = sendNotification.mock.calls[0][0] as { title: string; body: string };
    expect(payload.body).toContain("失败");
    expect(payload.body).not.toContain("已自动上线");
    expect(payload.body).not.toContain("未能识别");
    b.reset();
  });

  it("上线调用失败时明确告知（不能让人以为已上线）", async () => {
    vi.mocked(api.submitOnline).mockResolvedValueOnce(false);
    const b = useBatchStore();
    startSingle(b);
    mockTasks([task(101, { buildStatus: "构建成功" })]);

    await b.tick();

    const payload = sendNotification.mock.calls[0][0] as { body: string };
    expect(payload.body).toContain("上线失败");
    b.reset();
  });

  it("认领不到任务时说明本次不会自动上线", async () => {
    const b = useBatchStore();
    const run = startSingle(b);
    run.at = Date.now() - 31 * 60 * 1000; // 超过 TTL：走"已收到部分结果"的汇总
    mockTasks([task(101, { buildStatus: "构建成功", projectName: "别的项目" })]);

    await b.tick();

    const payload = sendNotification.mock.calls[0][0] as { body: string };
    expect(payload.body).toContain("未能识别到对应任务");
    expect(payload.body).not.toContain("已自动上线");
    b.reset();
  });

  it("项目名对不上时不认领（同 commit 的别的项目不能被当成这次部署）", async () => {
    const b = useBatchStore();
    startSingle(b, "zz-pay");
    mockTasks([task(101, { buildStatus: "构建成功", projectName: "zz-crm" })]);

    await b.tick();

    expect(b.runs[0].items[0].taskId).toBeUndefined();
    expect(api.submitOnline).not.toHaveBeenCalled();
    b.reset();
  });

  it("项目名带括号后缀也能对上（cleanProjectName 规范化后比较）", async () => {
    const b = useBatchStore();
    startSingle(b, "zz-pay（tke_node）");
    mockTasks([task(101, { buildStatus: "构建成功", projectName: "zz-pay" })]);

    await b.tick();

    expect(b.runs[0].items[0].taskId).toBe(101);
    b.reset();
  });
});
