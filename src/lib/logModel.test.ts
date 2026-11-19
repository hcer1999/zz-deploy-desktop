import { describe, it, expect } from "vitest";
import type { LogLine } from "@/lib/ansi";
import { planModelSync, type SyncPlan, type SyncState } from "./logModel";

function line(id: number, text: string, updates = 1): LogLine {
  return { id, text, updates };
}

/** 把 reset/edits 作用到"模型文本"上，用来断言最终看到的内容 */
function applyPlan(model: string, plan: SyncPlan): { text: string; state: SyncState } {
  if (plan.mode === "reset") {
    expect(model === "" || model.length > 0).toBe(true);
    return { text: plan.text, state: plan.state };
  }
  const lines = model === "" ? [] : model.split("\n");
  // 编辑按升序、互不重叠，从后往前应用不会影响前面的下标
  const sorted = [...plan.edits].sort((a, b) => b.startLine - a.startLine);
  for (const e of sorted) {
    expect(e.endLine).toBeGreaterThanOrEqual(e.startLine);
    lines.splice(e.startLine, e.endLine - e.startLine, ...(e.text === "" ? [] : e.text.split("\n")));
  }
  return { text: lines.join("\n"), state: plan.state };
}

/** 首次同步：返回文本与 state，作为后续用例的起点 */
function first(lines: LogLine[], pending = "", dropped = 0) {
  const out = applyPlan("", planModelSync(null, { lines, pending, dropped }));
  return out;
}

describe("planModelSync", () => {
  it("首次同步走整篇重置", () => {
    const plan = planModelSync(null, { lines: [line(1, "a"), line(2, "b")], pending: "", dropped: 0 });
    expect(plan.mode).toBe("reset");
    expect(applyPlan("", plan).text).toBe("a\nb");
  });

  it("pending 行是模型的最后一行（首次同步也算进去）", () => {
    const { text } = first([line(1, "a"), line(2, "b")], "loading 30%");
    expect(text).toBe("a\nb\nloading 30%");
  });

  it("纯追加只发一条插入编辑，不重置", () => {
    const base = first([line(1, "a"), line(2, "b")]);
    const plan = planModelSync(base.state, {
      lines: [line(1, "a"), line(2, "b"), line(3, "c"), line(4, "d")],
      pending: "",
      dropped: 0,
    });
    expect(plan.mode).toBe("edits");
    if (plan.mode !== "edits") return;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({ startLine: 2, endLine: 2 });
    expect(applyPlan(base.text, plan).text).toBe("a\nb\nc\nd");
  });

  it("追加发生在 pending 行之前", () => {
    const base = first([line(1, "a")], "progress");
    const plan = planModelSync(base.state, {
      lines: [line(1, "a"), line(2, "b")],
      pending: "progress",
      dropped: 0,
    });
    expect(applyPlan(base.text, plan).text).toBe("a\nb\nprogress");
  });

  it("头部丢行时先删头部再追加", () => {
    const base = first([line(1, "a"), line(2, "b"), line(3, "c")]);
    const plan = planModelSync(base.state, {
      lines: [line(3, "c"), line(4, "d")],
      pending: "",
      dropped: 2,
    });
    expect(plan.mode).toBe("edits");
    if (plan.mode !== "edits") return;
    expect(plan.edits[0]).toMatchObject({ startLine: 0, endLine: 2, text: "" });
    expect(applyPlan(base.text, plan).text).toBe("c\nd");
  });

  it("进度行原地改写只替换那一行", () => {
    const base = first([line(1, "a"), line(2, "b"), line(3, "pulling 10%")]);
    const plan = planModelSync(base.state, {
      lines: [line(1, "a"), line(2, "b"), line(3, "pulling 90%", 2)],
      pending: "",
      dropped: 0,
    });
    expect(plan.mode).toBe("edits");
    if (plan.mode !== "edits") return;
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({ startLine: 2, endLine: 3, text: "pulling 90%" });
    expect(applyPlan(base.text, plan).text).toBe("a\nb\npulling 90%");
  });

  it("原地改写的行太多时回退整篇重置（避免一帧上百次 replace）", () => {
    const many = Array.from({ length: 60 }, (_, i) => line(i + 1, `old-${i}`));
    const base = first(many);
    const plan = planModelSync(base.state, {
      lines: many.map((l) => ({ ...l, text: `${l.text}-changed`, updates: 2 })),
      pending: "",
      dropped: 0,
    });
    expect(plan.mode).toBe("reset");
  });

  it("清空（行与 pending 都没了）走重置成空文本", () => {
    const base = first([line(1, "a")], "x");
    const plan = planModelSync(base.state, { lines: [], pending: "", dropped: 0 });
    expect(plan.mode).toBe("reset");
    expect(applyPlan(base.text, plan).text).toBe("");
  });

  it("服务端 reset（dropped 归零）走整篇重置", () => {
    const base = first([line(5, "e"), line(6, "f")], "", 5);
    const plan = planModelSync(base.state, {
      lines: [line(1, "a"), line(2, "b")],
      pending: "",
      dropped: 0,
    });
    expect(plan.mode).toBe("reset");
    expect(applyPlan(base.text, plan).text).toBe("a\nb");
  });

  it("pending 内容变化替换最后一行，pending 变空删掉该行", () => {
    const base = first([line(1, "a")], "10%");
    const changed = planModelSync(base.state, { lines: [line(1, "a")], pending: "80%", dropped: 0 });
    const afterChange = applyPlan(base.text, changed);
    expect(afterChange.text).toBe("a\n80%");

    const cleared = planModelSync(afterChange.state, { lines: [line(1, "a")], pending: "", dropped: 0 });
    expect(applyPlan(afterChange.text, cleared).text).toBe("a");
  });

  it("id 回退（找不到 lastId）走整篇重置：服务端可能的乱序/换窗口", () => {
    const base = first([line(10, "x"), line(11, "y")]);
    const plan = planModelSync(base.state, {
      lines: [line(1, "a")],
      pending: "",
      dropped: 0,
    });
    expect(plan.mode).toBe("reset");
  });
});
