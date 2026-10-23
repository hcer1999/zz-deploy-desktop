import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.1") }));

import WelcomeView from "./WelcomeView.vue";

describe("WelcomeView", () => {
  beforeEach(() => vi.clearAllMocks());

  it("显示品牌名与品牌标（品牌名用品牌色）", async () => {
    const w = mount(WelcomeView);
    await flushPromises();

    const title = w.find("h1");
    expect(title.text()).toBe("至真部署");
    // 品牌色 = Tailwind 的 text-brand（--deploy-brand，固定 #00adc3，不随主题变）
    expect(title.classes()).toContain("text-brand");
    expect(w.find("svg").exists()).toBe(true);
    expect(w.text()).toContain("ITSM 部署桌面客户端");
  });

  it("显示运行时版本号（拿不到时就不显示，不报错）", async () => {
    const w = mount(WelcomeView);
    await flushPromises();
    expect(w.text()).toContain("v0.1.1");
  });

  it("有加载中的进度条与状态文案", () => {
    const w = mount(WelcomeView);
    expect(w.find(".animate-indeterminate").exists()).toBe(true);
    expect(w.text()).toContain("正在检查登录状态…");
  });
});
