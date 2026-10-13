import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { handleKeydown } from "./useShortcuts";
import { useTabsStore } from "@/stores/tabs";

/** 造一个键盘事件；target 默认是 body */
function key(k: string, opts?: { meta?: boolean; target?: HTMLElement }): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key: k,
    metaKey: opts?.meta ?? true,
    bubbles: true,
    cancelable: true,
  });
  if (opts?.target) {
    Object.defineProperty(e, "target", { value: opts.target });
  }
  return e;
}

describe("handleKeydown", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("Cmd+N 新建部署标签", () => {
    const tabs = useTabsStore();
    expect(handleKeydown(key("n"), tabs)).toBe(true);
    expect(tabs.activeTab?.kind).toBe("wizard");
  });

  it("没有修饰键时不拦截", () => {
    const tabs = useTabsStore();
    expect(handleKeydown(key("n", { meta: false }), tabs)).toBe(false);
    expect(tabs.tabs).toHaveLength(0);
  });

  it("Cmd+, 打开设置", () => {
    const tabs = useTabsStore();
    handleKeydown(key(","), tabs);
    expect(tabs.activeTab?.kind).toBe("settings");
  });

  it("Cmd+1..5 按固定顺序切换标签", () => {
    const tabs = useTabsStore();
    handleKeydown(key("3"), tabs);
    expect(tabs.activeTab?.kind).toBe("list");
    handleKeydown(key("5"), tabs);
    expect(tabs.activeTab?.kind).toBe("settings");
  });

  it("Cmd+W 关闭当前标签", () => {
    const tabs = useTabsStore();
    handleKeydown(key("n"), tabs);
    expect(tabs.tabs).toHaveLength(1);
    handleKeydown(key("w"), tabs);
    expect(tabs.tabs).toHaveLength(0);
  });

  it("Cmd+R 广播刷新事件", () => {
    const tabs = useTabsStore();
    let fired = 0;
    const onRefresh = (): void => {
      fired += 1;
    };
    window.addEventListener("app://refresh", onRefresh);
    handleKeydown(key("r"), tabs);
    window.removeEventListener("app://refresh", onRefresh);
    expect(fired).toBe(1);
  });

  it("输入框内不劫持快捷键", () => {
    const tabs = useTabsStore();
    const input = document.createElement("input");
    // 在搜索框里按 Cmd+W 不该关标签
    expect(handleKeydown(key("w", { target: input }), tabs)).toBe(false);
  });

  it("输入框内仍允许 Cmd+, 进设置", () => {
    const tabs = useTabsStore();
    const input = document.createElement("input");
    expect(handleKeydown(key(",", { target: input }), tabs)).toBe(true);
    expect(tabs.activeTab?.kind).toBe("settings");
  });

  it("Cmd+6 等越界数字不处理", () => {
    const tabs = useTabsStore();
    expect(handleKeydown(key("6"), tabs)).toBe(false);
    expect(tabs.tabs).toHaveLength(0);
  });
});
