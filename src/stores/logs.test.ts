import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/api/log", () => ({
  logOpen: vi.fn(async () => "s1"),
  logClose: vi.fn(async () => {}),
}));

import { useLogsStore } from "./logs";

async function waitForIdle(sessionId: string): Promise<void> {
  const logs = useLogsStore();
  for (let i = 0; i < 100; i++) {
    if (!logs.sessions[sessionId]?.ingesting) {
      // 再等一轮宏任务，确保队列里排在后面的小块也落地了
      await new Promise((r) => setTimeout(r, 0));
      if (!logs.sessions[sessionId]?.ingesting) return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error("日志处理超时");
}

describe("logs store 大日志分片", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("大 chunk 分片处理，期间到达的小 chunk 仍按顺序追加", async () => {
    const logs = useLogsStore();
    const sid = await logs.open({
      taskId: 1,
      deployType: "auto",
      projectName: "p",
      envName: "e",
    });

    const big = ("A".repeat(120) + "\n").repeat(2000);
    logs.onData({ sessionId: sid, reset: false, chunk: big });
    logs.onData({ sessionId: sid, reset: false, chunk: "tail-after-big\n" });

    await waitForIdle(sid);

    const lines = logs.sessions[sid].buffer.lines;
    expect(lines).toHaveLength(2001);
    expect(lines[0].text).toBe("A".repeat(120));
    expect(lines[lines.length - 1].text).toBe("tail-after-big");
  });

  it("finished 状态排在已排队的日志之后收尾（半行不会被提前落地）", async () => {
    const logs = useLogsStore();
    const sid = await logs.open({
      taskId: 1,
      deployType: "auto",
      projectName: "p",
      envName: "e",
    });

    const big = ("B".repeat(100) + "\n").repeat(2000) + "半个";
    logs.onData({ sessionId: sid, reset: false, chunk: big });
    logs.onStatus({ sessionId: sid, state: "finished" });

    await waitForIdle(sid);

    const lines = logs.sessions[sid].buffer.lines;
    expect(lines[lines.length - 1].text).toBe("半个");
    expect(logs.sessions[sid].state).toBe("finished");
  });

  it("关标签后分片任务停止，不再往已删除的会话里写", async () => {
    const logs = useLogsStore();
    const sid = await logs.open({
      taskId: 1,
      deployType: "auto",
      projectName: "p",
      envName: "e",
    });

    logs.onData({ sessionId: sid, reset: false, chunk: ("C".repeat(100) + "\n").repeat(5000) });
    await logs.close(sid);
    // 让排队中的切片跑到下一次 cancelled 检查
    await new Promise((r) => setTimeout(r, 0));

    expect(logs.sessions[sid]).toBeUndefined();
  });
});
