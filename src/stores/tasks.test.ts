import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

  describe("最后刷新时间", () => {
    it("刷新成功后记录时间", async () => {
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      expect(s.lastRefreshedAt).toBeNull();
      await s.refresh();
      expect(s.lastRefreshedAt).toBeInstanceOf(Date);
    });

    it("刷新失败时保留上一次的时间，不置空", async () => {
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      await s.refresh();
      const first = s.lastRefreshedAt;

      vi.mocked(deployApi.fetchTaskList).mockRejectedValue({ kind: "network", message: "x" });
      await s.refresh();
      expect(s.lastRefreshedAt).toBe(first);
    });

    it("轮询也会更新时间（回归：曾经只有手动刷新才更新）", async () => {
      // 原实现把 lastRefresh 放在视图的 doRefresh 里，轮询走的是
      // store.refresh()，不经过 doRefresh，于是时间戳永远不动。
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();

      s.startPolling(1);
      await vi.advanceTimersByTimeAsync(1000);

      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
      expect(s.lastRefreshedAt).toBeInstanceOf(Date);

      s.stopPolling();
      vi.useRealTimers();
    });
  });

  describe("轮询", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("startPolling 到点会刷新", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();

      // 注意：startPolling 的参数是【秒】（与配置字段 pollIntervalSecs 一致），
      // 内部会 ×1000 转毫秒。早期测试误写成 startPolling(1000)（=1000 秒），
      // 推进 1000ms 自然不触发，白白排查了很久。
      s.startPolling(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(2);

      s.stopPolling();
    });

    it("stopPolling 之后不再刷新", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      s.startPolling(1);
      s.stopPolling();
      await vi.advanceTimersByTimeAsync(5000);
      expect(deployApi.fetchTaskList).not.toHaveBeenCalled();
    });

    it("重复 startPolling 不会叠加多个定时器", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      s.startPolling(1);
      s.startPolling(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
      s.stopPolling();
    });

    it("连续失败 3 次后自动停止轮询（离线时不再无效打服务端）", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockRejectedValue({ kind: "network", message: "down" });
      const s = useTasksStore();
      s.startPolling(1);

      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      const callsAfterThree = vi.mocked(deployApi.fetchTaskList).mock.calls.length;
      expect(callsAfterThree).toBe(3);

      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.mocked(deployApi.fetchTaskList).mock.calls.length).toBe(callsAfterThree);
      expect(s.offline).toBe(true);
    });

    it("成功后清零失败计数，不会累积到离线", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList)
        .mockRejectedValueOnce({ kind: "network", message: "x" })
        .mockResolvedValue(PAGE)
        .mockRejectedValueOnce({ kind: "network", message: "x" });
      const s = useTasksStore();
      s.startPolling(1);

      await vi.advanceTimersByTimeAsync(1000); // 失败 1
      await vi.advanceTimersByTimeAsync(1000); // 成功，计数清零
      // 先确认真的发了请求，否则 offline===false 只是"什么都没发生"的假通过
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(2);
      expect(s.offline).toBe(false);

      await vi.advanceTimersByTimeAsync(1000); // 再失败 1
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(3);
      expect(s.offline).toBe(false);
      s.stopPolling();
    });

    it("间隔可配置", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      s.startPolling(10);
      expect(s.pollIntervalSecs).toBe(10);
      await vi.advanceTimersByTimeAsync(10000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
      s.stopPolling();
    });
  });
});
