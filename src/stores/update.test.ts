import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/api/update", () => ({
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(async () => {}),
  restartApp: vi.fn(async () => {}),
  discardUpdate: vi.fn(async () => {}),
}));

import * as api from "@/api/update";
import { useUpdateStore } from "./update";

const INFO: api.UpdateInfo = {
  currentVersion: "0.1.1",
  latestVersion: "0.2.0",
  available: true,
  notes: "修复若干问题",
  publishedAt: "2026-10-16T00:00:00Z",
};

describe("useUpdateStore", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("发现新版本时显示提示条", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    const s = useUpdateStore();
    await s.check();

    expect(s.available).toBe(true);
    expect(s.showBanner).toBe(true);
    expect(s.info?.latestVersion).toBe("0.2.0");
  });

  it("没有新版本时不显示提示条", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(null);
    const s = useUpdateStore();
    await s.check();

    expect(s.available).toBe(false);
    expect(s.showBanner).toBe(false);
  });

  it("忽略某个版本后不再提示，但更高版本会重新提示", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    const s = useUpdateStore();
    await s.check();
    s.dismiss();

    expect(s.showBanner).toBe(false);
    expect(localStorage.getItem("zz-deploy:update-dismissed")).toBe("0.2.0");
    // 释放 Rust 侧更新资源
    expect(api.discardUpdate).toHaveBeenCalled();

    vi.mocked(api.checkUpdate).mockResolvedValue({ ...INFO, latestVersion: "0.2.1" });
    await s.check();
    expect(s.showBanner).toBe(true);
  });

  it("检查失败只记录错误，不抛出（启动时静默）", async () => {
    vi.mocked(api.checkUpdate).mockRejectedValue({
      kind: "network",
      message: "unreachable",
      retryable: true,
    });
    const s = useUpdateStore();

    await expect(s.check()).resolves.toBeUndefined();
    expect(s.checking).toBe(false);
    expect(s.error).toContain("unreachable");
  });

  it("并发检查合并成一次请求", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    const s = useUpdateStore();
    await Promise.all([s.check(), s.check()]);
    expect(api.checkUpdate).toHaveBeenCalledTimes(1);
  });

  it("安装更新时记录下载进度，安装完成后等待重启", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    vi.mocked(api.installUpdate).mockImplementation(async (onProgress) => {
      onProgress({ phase: "downloading", downloaded: 50, total: 100 });
      onProgress({ phase: "downloading", downloaded: 100, total: 100 });
      onProgress({ phase: "installing", downloaded: 100, total: 100 });
    });
    const s = useUpdateStore();
    await s.check();
    await s.install();

    expect(s.installed).toBe(true);
    expect(s.phase).toBe("ready");
    expect(s.progress).toBe(100);
    expect(s.installing).toBe(false);
    expect(api.restartApp).not.toHaveBeenCalled();
  });

  it("重启应用让新版本生效", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    const s = useUpdateStore();
    await s.check();
    await s.restart();
    expect(api.restartApp).toHaveBeenCalled();
  });

  it("安装失败时显示错误，状态回到可重试", async () => {
    vi.mocked(api.checkUpdate).mockResolvedValue(INFO);
    vi.mocked(api.installUpdate).mockRejectedValue({
      kind: "network",
      message: "download failed",
      retryable: true,
    });
    const s = useUpdateStore();
    await s.check();
    await s.install();

    expect(s.error).toContain("download failed");
    expect(s.installed).toBe(false);
    expect(s.phase).toBe("idle");
    expect(s.installing).toBe(false);
  });
});
