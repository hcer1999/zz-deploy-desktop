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
