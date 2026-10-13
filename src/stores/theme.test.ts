import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useThemeStore } from "./theme";

const QUERY = "(prefers-color-scheme: dark)";

/**
 * jsdom 不实现 window.matchMedia，因此不能用 vi.spyOn（属性不存在），
 * 必须用 defineProperty 直接注入。
 */
function mockSystemDark(matches: boolean): MediaQueryList {
  const mql = {
    matches,
    media: QUERY,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: vi.fn(() => mql),
  });
  return mql;
}

describe("theme store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    // 清掉注入的 matchMedia，避免影响其它测试文件
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, "matchMedia");
  });

  it("dark 模式给根元素加 dark 类", () => {
    const s = useThemeStore();
    s.apply("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("light 模式移除 dark 类", () => {
    const s = useThemeStore();
    s.apply("dark");
    s.apply("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system 模式跟随 prefers-color-scheme（系统为深色）", () => {
    mockSystemDark(true);
    const s = useThemeStore();
    s.apply("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("system 模式跟随 prefers-color-scheme（系统为浅色）", () => {
    mockSystemDark(false);
    const s = useThemeStore();
    s.apply("dark");
    s.apply("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("记录当前 mode 以便设置页回显", () => {
    const s = useThemeStore();
    s.apply("light");
    expect(s.mode).toBe("light");
  });

  it("system 模式下注册系统主题变更监听，切走后注销", () => {
    const mql = mockSystemDark(false);
    const s = useThemeStore();

    s.apply("system");
    expect(mql.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    s.apply("light");
    expect(mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("非 system 模式下不注册监听", () => {
    const mql = mockSystemDark(true);
    const s = useThemeStore();
    s.apply("light");
    expect(mql.addEventListener).not.toHaveBeenCalled();
  });

  it("系统主题变化时实时跟随", () => {
    const mql = mockSystemDark(false);
    const s = useThemeStore();
    s.apply("system");
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // 取注册进去的那个回调，手动触发一次
    const cb = vi.mocked(mql.addEventListener).mock.calls[0][1] as unknown as (e: {
      matches: boolean;
    }) => void;
    cb({ matches: true });
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
