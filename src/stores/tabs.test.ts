import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTabsStore } from "./tabs";

describe("tabs store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("单例标签重复打开只聚焦，不新建", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "settings" });
    const b = s.open({ kind: "settings" });
    expect(a).toBe(b);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(a);
  });

  it("向导标签每次打开都新建", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    expect(a).not.toBe(b);
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe(b);
  });

  it("日志标签按 taskId 去重", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "log", taskId: 101 });
    const b = s.open({ kind: "log", taskId: 101 });
    const c = s.open({ kind: "log", taskId: 102 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(s.tabs).toHaveLength(2);
  });

  it("多个向导标签的标题互不相同", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    const ta = s.tabs.find((t) => t.id === a)!;
    const tb = s.tabs.find((t) => t.id === b)!;
    expect(s.titleOf(ta)).toBe("新建部署 1");
    expect(s.titleOf(tb)).toBe("新建部署 2");
  });

  it("关闭激活标签后聚焦相邻标签", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    s.close(b);
    expect(s.activeId).toBe(a);
  });

  it("关闭非激活标签不改变当前激活项", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    s.close(a);
    expect(s.activeId).toBe(b);
  });

  it("关闭最后一个标签后 activeId 为空", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "settings" });
    s.close(a);
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });
});

describe("closeMany", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("关闭激活标签后聚焦剩余标签里最靠右的一个", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    const c = s.open({ kind: "wizard" });
    s.focus(b);
    s.closeMany([b, c]);
    expect(s.tabs.map((t) => t.id)).toEqual([a]);
    expect(s.activeId).toBe(a);
  });

  it("只关非激活标签时 activeId 不变", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    s.focus(b);
    s.closeMany([a]);
    expect(s.activeId).toBe(b);
  });

  it("忽略不存在的 id", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "settings" });
    s.closeMany(["nope", a]);
    expect(s.tabs).toHaveLength(0);
  });

  it("空数组是 no-op", () => {
    const s = useTabsStore();
    s.open({ kind: "settings" });
    s.closeMany([]);
    expect(s.tabs).toHaveLength(1);
  });

  it("closeByKind 只关掉该类型，保留其它类型", () => {
    const s = useTabsStore();
    const l1 = s.open({ kind: "log", taskId: 1 });
    const l2 = s.open({ kind: "log", taskId: 2 });
    const w = s.open({ kind: "wizard" });
    s.closeByKind("log");
    expect(s.tabs.map((t) => t.id)).toEqual([w]);
    expect([l1, l2].some((id) => s.activeId === id)).toBe(false);
  });
});
