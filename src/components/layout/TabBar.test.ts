import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// 关日志标签会调 Rust 释放长连接；jsdom 里没有 Tauri，必须挡掉
vi.mock("@/api/log", () => ({
  logOpen: vi.fn(async () => "s"),
  logClose: vi.fn(async () => {}),
}));
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { useTabsStore } from "@/stores/tabs";
import { useLogsStore } from "@/stores/logs";
import { createLogBuffer } from "@/lib/ansi";
import TabBar from "./TabBar.vue";

let pinia: Pinia;
let mounted: ReturnType<typeof mount> | null = null;

/** 菜单内容通过 portal 渲染到 body，用例之间必须清干净 */
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = "";
});

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
});

function mountBar(): ReturnType<typeof mount> {
  mounted = mount(TabBar, { global: { plugins: [pinia] }, attachTo: document.body });
  return mounted;
}

function tabNodes(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-test='tab']")];
}

/** 右键第 index 个标签并等待菜单渲染 */
async function openMenu(w: ReturnType<typeof mount>, index: number): Promise<void> {
  await tabNodes()[index].dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 8 }),
  );
  await flushPromises();
  await w.vm.$nextTick();
}

function menuItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
}

async function clickItem(w: ReturnType<typeof mount>, label: string): Promise<void> {
  const item = menuItems().find((el) => el.textContent?.includes(label));
  expect(item, `菜单项「${label}」应存在`).toBeTruthy();
  await item!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
  await w.vm.$nextTick();
}

describe("TabBar 右键菜单", () => {
  it("右键标签列出四个关闭项", async () => {
    const tabs = useTabsStore();
    tabs.open({ kind: "wizard" });
    tabs.open({ kind: "list" });
    tabs.open({ kind: "history" });
    const w = mountBar();
    await w.vm.$nextTick();

    await openMenu(w, 1);
    expect(menuItems().map((el) => el.textContent?.trim())).toEqual([
      "关闭",
      "关闭其它标签",
      "关闭右侧标签",
      "关闭全部标签",
    ]);
  });

  it("只有一个标签、且是最右时，禁用其它/右侧", async () => {
    useTabsStore().open({ kind: "settings" });
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 0);
    const byLabel = new Map(menuItems().map((el) => [el.textContent?.trim(), el]));
    expect(byLabel.get("关闭其它标签")?.getAttribute("aria-disabled")).toBe("true");
    expect(byLabel.get("关闭右侧标签")?.getAttribute("aria-disabled")).toBe("true");
    expect(byLabel.get("关闭全部标签")?.getAttribute("aria-disabled")).not.toBe("true");
  });

  it("关闭其它标签只留右键的那个", async () => {
    const tabs = useTabsStore();
    tabs.open({ kind: "wizard" });
    const b = tabs.open({ kind: "list" });
    tabs.open({ kind: "history" });
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 1);
    await clickItem(w, "关闭其它标签");
    expect(tabs.tabs.map((t) => t.id)).toEqual([b]);
    expect(tabs.activeId).toBe(b);
  });

  it("关闭右侧标签保留左侧与自身", async () => {
    const tabs = useTabsStore();
    const a = tabs.open({ kind: "wizard" });
    const b = tabs.open({ kind: "list" });
    tabs.open({ kind: "history" });
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 1);
    await clickItem(w, "关闭右侧标签");
    expect(tabs.tabs.map((t) => t.id)).toEqual([a, b]);
  });

  it("右键的标签在菜单打开期间被关掉：菜单随之关闭，剩下的标签一个都不受影响", async () => {
    const tabs = useTabsStore();
    const a = tabs.open({ kind: "wizard" });
    tabs.open({ kind: "list" });
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 0);
    expect(menuItems().length).toBeGreaterThan(0);

    // 菜单还开着，目标标签被别处关掉：reka-ui 会连同 trigger 一起卸载菜单内容
    tabs.close(a);
    await flushPromises();
    await w.vm.$nextTick();

    expect(menuItems()).toHaveLength(0);
    expect(tabs.tabs).toHaveLength(1);
  });

  it("右键切换菜单目标但不切换激活标签", async () => {
    const tabs = useTabsStore();
    tabs.open({ kind: "wizard" });
    const b = tabs.open({ kind: "list" });
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 0);
    expect(tabs.activeId).toBe(b);
  });

  it("关闭全部标签：有日志在输出时先确认，取消则一个都不关", async () => {
    const tabs = useTabsStore();
    tabs.open({ kind: "wizard" });
    tabs.open({ kind: "log", taskId: 7 });
    useLogsStore().sessions["s1"] = {
      sessionId: "s1",
      taskId: 7,
      projectName: "zz-pay",
      envName: "测试环境",
      buffer: createLogBuffer(),
      state: "connected",
      detail: "",
      lastDataAt: Date.now(),
      ingesting: false,
    };
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 1);
    await clickItem(w, "关闭全部标签");
    expect(document.body.textContent).toContain("1 个日志仍在输出");
    expect(tabs.tabs).toHaveLength(2);

    // 取消：关掉确认框，标签一个都不少
    const cancel = [...document.querySelectorAll<HTMLElement>("button")].find((el) =>
      el.textContent?.trim() === "取消",
    );
    expect(cancel).toBeTruthy();
    await cancel!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(tabs.tabs).toHaveLength(2);
  });

  it("关闭全部标签：确认后全部关闭", async () => {
    const tabs = useTabsStore();
    tabs.open({ kind: "wizard" });
    tabs.open({ kind: "log", taskId: 8 });
    useLogsStore().sessions["s2"] = {
      sessionId: "s2",
      taskId: 8,
      projectName: "zz-pay",
      envName: "测试环境",
      buffer: createLogBuffer(),
      state: "connecting",
      detail: "",
      lastDataAt: Date.now(),
      ingesting: false,
    };
    const w = mountBar();
    await w.vm.$nextTick();
    await openMenu(w, 1);
    await clickItem(w, "关闭全部标签");

    const confirm = [...document.querySelectorAll<HTMLElement>("[role='dialog'] button")].find(
      (el) => el.textContent?.trim() === "关闭",
    );
    expect(confirm).toBeTruthy();
    await confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(tabs.tabs).toHaveLength(0);
    expect(tabs.activeId).toBeNull();
  });
});
