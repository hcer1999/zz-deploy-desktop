import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/config", () => ({ getConfig: vi.fn(), setConfig: vi.fn() }));
vi.mock("@/api/auth", () => ({ getAuthStatus: vi.fn(), setBaseUrl: vi.fn() }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.1") }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTitle: vi.fn(async () => {}) }),
}));
vi.mock("@tauri-apps/plugin-os", () => ({ platform: () => "macos" }));

import * as configApi from "@/api/config";
import SideNav from "./SideNav.vue";
import TitleBar from "./TitleBar.vue";
import { useSettingsStore } from "@/stores/settings";

const CONFIG: configApi.AppConfig = {
  baseUrl: "https://itsm.zhizhengroup.com",
  theme: "system",
  username: "zhangsan",
  closeBehavior: "tray",
  pollIntervalSecs: 60,
  logRetentionDays: 30,
  logRetentionEntries: 500,
  notifyMode: "unfocused",
  sidebarExpanded: false,
  lastDeployType: "auto",
  lastEnvId: null,
};

let pinia: Pinia;

async function mountSidebar(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
  await useSettingsStore().load();
  return mount(SideNav, { global: { plugins: [pinia] } });
}

describe("SideNav", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);
  });

  it("默认折叠：只有图标，不显示导航名", async () => {
    const w = await mountSidebar();
    expect(w.text()).not.toContain("任务列表");
    // 折叠态靠 title 提供提示
    expect(w.find('[aria-label="任务列表"]').exists()).toBe(true);
  });

  it("点击切换按钮后展开并显示每个导航名", async () => {
    const w = await mountSidebar();
    await w.find('[data-test="sidebar-toggle"]').trigger("click");
    await flushPromises();

    for (const label of ["新建部署", "收藏", "任务列表", "历史日志", "设置"]) {
      expect(w.text()).toContain(label);
    }
  });

  it("展开状态会写入配置（重启后保持）", async () => {
    const w = await mountSidebar();
    await w.find('[data-test="sidebar-toggle"]').trigger("click");
    await flushPromises();

    const calls = vi.mocked(configApi.setConfig).mock.calls;
    const sent = calls[calls.length - 1][0];
    expect(sent.sidebarExpanded).toBe(true);
    // 其它字段不能被写回默认值
    expect(sent.username).toBe("zhangsan");
    expect(sent.baseUrl).toBe(CONFIG.baseUrl);
  });

  it("已展开时再点一次收起", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue({ ...CONFIG, sidebarExpanded: true });
    pinia = createPinia();
    setActivePinia(pinia);
    await useSettingsStore().load();
    const w = mount(SideNav, { global: { plugins: [pinia] } });
    expect(w.text()).toContain("任务列表");

    await w.find('[data-test="sidebar-toggle"]').trigger("click");
    await flushPromises();
    expect(w.text()).not.toContain("任务列表");
  });
});

describe("TitleBar", () => {
  it("标题显示名称 + 运行时版本", async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    const w = mount(TitleBar, { global: { plugins: [pinia] } });
    await flushPromises();
    expect(w.text()).toContain("至真部署-桌面版 Ver0.1.1");
  });
});
