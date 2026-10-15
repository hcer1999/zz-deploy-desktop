import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.0") }));
vi.mock("@tauri-apps/plugin-os", () => ({
  platform: () => "macos",
  arch: () => "aarch64",
  version: () => "15.0.0",
}));

import AboutView from "./AboutView.vue";
import { CHANGELOG } from "@/data/changelog";

describe("AboutView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("展示 logo 原图（assets/app-icon.png，不是重绘的矢量标）", async () => {
    const w = mount(AboutView);
    await flushPromises();
    const img = w.find('[data-test="about-icon"]');
    expect(img.exists()).toBe(true);
    // 构建后是带 hash 的资源路径，dev/测试下是源码路径，两种都含文件名
    expect(img.attributes("src")).toContain("app-icon");
    expect(img.attributes("alt")).toContain("图标原图");
  });

  it("展示品牌名、版本号、构建时间与运行环境", async () => {
    const w = mount(AboutView);
    await flushPromises();

    expect(w.find("h1").text()).toBe("至真部署");
    expect(w.find('[data-test="about-version"]').text()).toContain("v0.1.0");
    // 构建时间来自 vite define 注入（不是运行时时间）
    const built = w.find('[data-test="about-build-time"]').text();
    expect(built).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(w.find('[data-test="about-platform"]').text()).toBe("macos aarch64 · 系统 15.0.0");
  });

  it("渲染更新日志：每条含版本号与日期，条目非空", async () => {
    const w = mount(AboutView);
    await flushPromises();

    const entries = w.findAll('[data-test="changelog-entry"]');
    expect(entries).toHaveLength(CHANGELOG.length);
    expect(entries[0].text()).toContain("v0.1.0");
    expect(entries[0].text()).toContain("2026-10-15");
    // 至少写了点人话（不是空壳条目）
    expect(entries[0].text().length).toBeGreaterThan(80);
  });

  it("写清了这是什么工具（介绍）", async () => {
    const w = mount(AboutView);
    await flushPromises();
    expect(w.text()).toContain("ITSM 的桌面客户端");
    expect(w.text()).toContain("批量部署");
  });
});
