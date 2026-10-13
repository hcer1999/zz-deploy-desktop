import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/deploy", () => ({
  fetchTaskList: vi.fn(),
}));

import * as deployApi from "@/api/deploy";
import { useTasksStore } from "./tasks";
import type { DeployTask } from "@/api/parser";

function task(id: number, over: Partial<DeployTask> = {}): DeployTask {
  return {
    taskId: id,
    title: `任务${id}`,
    projectName: "zz-x",
    envName: "测试环境",
    cluster: "",
    deployType: "",
    branch: "main",
    version: "v1",
    onlineStatus: "-",
    buildStatus: "构建中",
    submitTime: "2026-10-13 10:00:00",
    submitter: "zhangsan",
    canUp: true,
    canRoll: false,
    canDelete: true,
    ...over,
  };
}

const PAGE = {
  tasks: [task(1), task(2)],
  pageInfo: { currentPage: 1, totalPages: 5, hasPrev: false, hasNext: true },
};

describe("tasks store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refresh 拉取并填充", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    await s.refresh();
    expect(s.tasks).toHaveLength(2);
    expect(s.pageInfo.totalPages).toBe(5);
    expect(s.loading).toBe(false);
  });

  it("请求时带上当前的 类型/页码/搜索词", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.deployType = "docker";
    s.page = 3;
    s.search = "zz-pay";
    await s.refresh();
    expect(deployApi.fetchTaskList).toHaveBeenCalledWith("docker", 3, "zz-pay");
  });

  it("发起请求期间 loading 为 true", async () => {
    let resolve!: (v: typeof PAGE) => void;
    vi.mocked(deployApi.fetchTaskList).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const s = useTasksStore();
    const p = s.refresh();
    expect(s.loading).toBe(true);
    resolve(PAGE);
    await p;
    expect(s.loading).toBe(false);
  });

  it("失败时记录错误并停止 loading，不抛给调用方", async () => {
    // refresh 被轮询与按钮两处调用，抛异常会变成未捕获的 rejection
    vi.mocked(deployApi.fetchTaskList).mockRejectedValue({ kind: "network", message: "x" });
    const s = useTasksStore();
    await expect(s.refresh()).resolves.toBeUndefined();
    expect(s.error).toContain("网络");
    expect(s.loading).toBe(false);
  });

  it("成功后清空上一次的错误", async () => {
    vi.mocked(deployApi.fetchTaskList).mockRejectedValueOnce({ kind: "network", message: "x" });
    const s = useTasksStore();
    await s.refresh();
    expect(s.error).not.toBe("");

    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    await s.refresh();
    expect(s.error).toBe("");
  });

  it("切换部署类型会重置到第 1 页并立即刷新", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.page = 4;
    await s.setDeployType("docker");
    expect(s.deployType).toBe("docker");
    expect(s.page).toBe(1);
    expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
  });

  it("切换到当前类型时不重复请求", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    await s.setDeployType("auto");
    expect(deployApi.fetchTaskList).not.toHaveBeenCalled();
  });

  it("提交搜索会重置到第 1 页", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.page = 4;
    await s.applySearch("zz-pay");
    expect(s.search).toBe("zz-pay");
    expect(s.page).toBe(1);
  });

  it("goPage 越界或与当前页相同时不发请求", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 5, hasPrev: false, hasNext: true };
    await s.goPage(0);
    await s.goPage(99);
    await s.goPage(1);
    expect(deployApi.fetchTaskList).not.toHaveBeenCalled();
  });

  it("goPage 到有效页码会刷新", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 5, hasPrev: false, hasNext: true };
    await s.goPage(3);
    expect(s.page).toBe(3);
    expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
  });

  it("removeLocal 把删掉的任务从列表里去掉", () => {
    const s = useTasksStore();
    s.tasks = [task(1), task(2), task(3)];
    s.removeLocal(2);
    expect(s.tasks.map((t) => t.taskId)).toEqual([1, 3]);
  });

  it("pageWindow 给出当前页附近的页码且不越界", () => {
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 3, hasPrev: false, hasNext: true };
    expect(s.pageWindow()).toEqual([1, 2, 3]);

    s.pageInfo = { currentPage: 9, totalPages: 20, hasPrev: true, hasNext: true };
    expect(s.pageWindow()).toEqual([7, 8, 9, 10, 11]);

    s.pageInfo = { currentPage: 20, totalPages: 20, hasPrev: true, hasNext: false };
    expect(s.pageWindow()).toEqual([18, 19, 20]);
  });

  it("pageWindow 在总页数很少时不会产出负页码", () => {
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false };
    expect(s.pageWindow()).toEqual([1]);
  });
});
