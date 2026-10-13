import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/config", () => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}));
vi.mock("@/api/auth", () => ({
  getAuthStatus: vi.fn(),
  setBaseUrl: vi.fn(),
}));

import * as configApi from "@/api/config";
import * as authApi from "@/api/auth";
import { useSettingsStore } from "./settings";

const CONFIG: configApi.AppConfig = {
  baseUrl: "https://itsm.zhizhengroup.com",
  theme: "dark",
  username: "zhangsan",
  closeBehavior: "tray",
  pollIntervalSecs: 60,
  logRetentionDays: 30,
  logRetentionEntries: 500,
  notifyMode: "unfocused",
};

describe("settings store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(authApi.getAuthStatus).mockResolvedValue({
      loggedIn: true,
      username: "zhangsan",
      baseUrl: CONFIG.baseUrl,
      credentialBackend: "keyring",
    });
  });

  it("load 填充全部字段", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
    const s = useSettingsStore();
    await s.load();
    expect(s.baseUrl).toBe(CONFIG.baseUrl);
    expect(s.theme).toBe("dark");
    expect(s.username).toBe("zhangsan");
    expect(s.loaded).toBe(true);
  });

  it("patch 只改主题时不会清空 username", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
    vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);

    const s = useSettingsStore();
    await s.load();
    await s.patch({ theme: "light" });

    const sent = vi.mocked(configApi.setConfig).mock.calls[0][0];
    expect(sent.username).toBe("zhangsan");
    expect(sent.baseUrl).toBe(CONFIG.baseUrl);
    expect(sent.theme).toBe("light");
    expect(sent.closeBehavior).toBe("tray");
  });

  it("patch 只改轮询间隔时不会清空其它字段", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
    vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);

    const s = useSettingsStore();
    await s.load();
    await s.patch({ pollIntervalSecs: 120 });

    const sent = vi.mocked(configApi.setConfig).mock.calls[0][0];
    expect(sent.pollIntervalSecs).toBe(120);
    expect(sent.username).toBe("zhangsan");
    expect(sent.theme).toBe("dark");
  });

  it("patch 只改日志保留天数时不会把保留条数写成默认值", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue({ ...CONFIG, logRetentionEntries: 120 });
    vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);

    const s = useSettingsStore();
    await s.load();
    await s.patch({ logRetentionDays: 7 });

    const sent = vi.mocked(configApi.setConfig).mock.calls[0][0];
    expect(sent.logRetentionDays).toBe(7);
    expect(sent.logRetentionEntries).toBe(120);
  });

  it("patch 只改通知触发条件时不会把其它字段写成默认值", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
    vi.mocked(configApi.setConfig).mockImplementation(async (p) => p);

    const s = useSettingsStore();
    await s.load();
    await s.patch({ notifyMode: "always" });

    const sent = vi.mocked(configApi.setConfig).mock.calls[0][0];
    expect(sent.notifyMode).toBe("always");
    expect(sent.logRetentionDays).toBe(30);
    expect(sent.username).toBe("zhangsan");
  });

  it("patch 后本地状态跟随服务端返回值", async () => {
    vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
    vi.mocked(configApi.setConfig).mockResolvedValue({ ...CONFIG, theme: "light" });

    const s = useSettingsStore();
    await s.load();
    await s.patch({ theme: "light" });
    expect(s.theme).toBe("light");
  });

  // ---- 回归：用户报告的"登录页改了地址，设置页仍显示旧值" ----
  describe("baseUrl 的单一来源", () => {
    it("changeBaseUrl 会走 set_base_url 而不是 config_set", async () => {
      vi.mocked(authApi.setBaseUrl).mockResolvedValue(undefined);
      vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);

      const s = useSettingsStore();
      await s.changeBaseUrl("https://new.example.com");

      expect(authApi.setBaseUrl).toHaveBeenCalledWith("https://new.example.com");
      // 不能用 config_set：那条路径不会重建 HttpClient
      expect(configApi.setConfig).not.toHaveBeenCalled();
    });

    it("changeBaseUrl 后以 Rust 侧为权威重新读回，状态不漂移", async () => {
      vi.mocked(authApi.setBaseUrl).mockResolvedValue(undefined);

      const s = useSettingsStore();

      // 初始：Rust 侧是原地址
      vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
      await s.load();
      expect(s.baseUrl).toBe(CONFIG.baseUrl);

      // 在别处（如登录页）改成带后缀的地址
      vi.mocked(configApi.getConfig).mockResolvedValue({
        ...CONFIG,
        baseUrl: "https://itsm.zhizhengroup.com1",
      });
      await s.changeBaseUrl("https://itsm.zhizhengroup.com1");
      expect(s.baseUrl).toBe("https://itsm.zhizhengroup.com1");

      // 再改回来，设置页必须能看到新值（这就是用户报的场景）
      vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
      await s.changeBaseUrl("https://itsm.zhizhengroup.com");
      expect(s.baseUrl).toBe(CONFIG.baseUrl);
    });

    it("changeBaseUrl 提交前去掉首尾空白，最终值以 Rust 归一化结果为准", async () => {
      vi.mocked(authApi.setBaseUrl).mockResolvedValue(undefined);
      // Rust 侧会把尾部斜杠去掉
      vi.mocked(configApi.getConfig).mockResolvedValue({
        ...CONFIG,
        baseUrl: "https://itsm.zhizhengroup.com",
      });

      const s = useSettingsStore();
      await s.changeBaseUrl("  https://itsm.zhizhengroup.com/  ");

      expect(authApi.setBaseUrl).toHaveBeenCalledWith("https://itsm.zhizhengroup.com/");
      expect(s.baseUrl).toBe("https://itsm.zhizhengroup.com");
    });

    it("load 每次都重新读，不做「已加载就跳过」的优化", async () => {
      vi.mocked(configApi.getConfig).mockResolvedValue(CONFIG);
      const s = useSettingsStore();
      await s.load();

      vi.mocked(configApi.getConfig).mockResolvedValue({
        ...CONFIG,
        baseUrl: "https://changed.example.com",
      });
      await s.load();
      expect(s.baseUrl).toBe("https://changed.example.com");
    });
  });
});
