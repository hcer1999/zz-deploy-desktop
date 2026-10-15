import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { waitForAuthSettled } from "./useBoot";

describe("waitForAuthSettled - 启动时等登录状态有结论", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** 造一个"若干次 refresh 之后才变成已登录"的探针（模拟静默续登耗时） */
  function probeAfter(refreshes: number): {
    isReady: () => boolean;
    isLoggedIn: () => boolean;
    refresh: () => Promise<void>;
    calls: () => number;
  } {
    let n = 0;
    let loggedIn = false;
    return {
      isReady: () => false,
      isLoggedIn: () => loggedIn,
      refresh: async () => {
        n += 1;
        if (n >= refreshes) loggedIn = true;
      },
      calls: () => n,
    };
  }

  it("已经登录时立刻返回（不白等）", async () => {
    const probe = { isReady: () => false, isLoggedIn: () => true, refresh: vi.fn() };
    const p = waitForAuthSettled(probe, { intervalMs: 150 });
    await vi.advanceTimersByTimeAsync(0);
    await expect(p).resolves.toBe(true);
    expect(probe.refresh).not.toHaveBeenCalled();
  });

  it("续登要几轮才完成：轮询等到它完成（不闪登录页）", async () => {
    const probe = probeAfter(3); // 第 3 次 refresh 才知道已登录
    const p = waitForAuthSettled(probe, { intervalMs: 150, timeoutMs: 6000 });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(true);
    expect(probe.calls()).toBeGreaterThanOrEqual(3);
  });

  it("auth://ready 到了还没登录 → 就是真没登录，立即返回 false", async () => {
    let ready = false;
    const probe = {
      isReady: () => ready,
      isLoggedIn: () => false,
      refresh: async () => {
        ready = true; // 模拟 refresh 之后收到 ready
      },
    };
    const p = waitForAuthSettled(probe, { intervalMs: 150 });
    await vi.advanceTimersByTimeAsync(500);
    await expect(p).resolves.toBe(false);
  });

  it("refresh 抛错不会把欢迎页卡住（下一轮继续，超时兜底）", async () => {
    const probe = {
      isReady: () => false,
      isLoggedIn: () => false,
      refresh: vi.fn(async () => {
        throw new Error("IPC 挂了");
      }),
    };
    const p = waitForAuthSettled(probe, { intervalMs: 100, timeoutMs: 400 });
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toBe(false);
    expect(probe.refresh).toHaveBeenCalled();
  });

  it("一直没结论时会超时返回（不能让遮罩一直挂着）", async () => {
    const probe = { isReady: () => false, isLoggedIn: () => false, refresh: vi.fn(async () => {}) };
    const p = waitForAuthSettled(probe, { intervalMs: 100, timeoutMs: 300 });
    await vi.advanceTimersByTimeAsync(400);
    await expect(p).resolves.toBe(false);
  });
});
