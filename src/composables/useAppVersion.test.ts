import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("useAppVersion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
  });
  afterEach(() => vi.doUnmock("@tauri-apps/api/app"));

  it("取到运行时版本，并且多个页面共用同一个 ref（只取一次）", async () => {
    const { useAppVersion } = await import("./useAppVersion");
    const a = useAppVersion();
    const b = useAppVersion();
    expect(a).toBe(b);
    await Promise.resolve();
    await Promise.resolve();
    expect(a.value).toBe("0.1.0");
  });

  it("拿不到版本时保持空串（浏览器预览不炸）", async () => {
    vi.doMock("@tauri-apps/api/app", () => ({
      getVersion: vi.fn(async () => {
        throw new Error("no tauri");
      }),
    }));
    const { useAppVersion } = await import("./useAppVersion");
    const v = useAppVersion();
    await Promise.resolve();
    await Promise.resolve();
    expect(v.value).toBe("");
  });
});
