import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/auth", () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  relogin: vi.fn(),
  setBaseUrl: vi.fn(),
}));

import * as authApi from "@/api/auth";
import { useAuthStore } from "./auth";

const STATUS: authApi.AuthStatus = {
  loggedIn: true,
  username: "zhangsan",
  baseUrl: "https://itsm.zhizhengroup.com",
  credentialBackend: "keyring",
};

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(authApi.getAuthStatus).mockResolvedValue(STATUS);
  });

  it("refresh 后填入登录态", async () => {
    const s = useAuthStore();
    await s.refresh();
    expect(s.loggedIn).toBe(true);
    expect(s.username).toBe("zhangsan");
    expect(s.credentialBackend).toBe("keyring");
  });

  it("登录成功写入状态", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ ok: true, message: "" });
    const s = useAuthStore();
    const ok = await s.login("lisi", "pw", true);
    expect(ok).toBe(true);
    expect(s.loggedIn).toBe(true);
    expect(s.error).toBe("");
  });

  it("登录失败保留错误信息且不置为已登录", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ ok: false, message: "用户名或密码错误" });
    const s = useAuthStore();
    const ok = await s.login("lisi", "bad", true);
    expect(ok).toBe(false);
    expect(s.loggedIn).toBe(false);
    expect(s.error).toBe("用户名或密码错误");
  });

  it("登录期间 loading 为 true，结束后复位", async () => {
    let resolve!: (v: authApi.LoginResult) => void;
    vi.mocked(authApi.login).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const s = useAuthStore();
    const p = s.login("a", "b", false);
    expect(s.loading).toBe(true);
    resolve({ ok: true, message: "" });
    await p;
    expect(s.loading).toBe(false);
  });

  it("登录抛异常时 loading 也要复位", async () => {
    vi.mocked(authApi.login).mockRejectedValue(new Error("网络断了"));
    const s = useAuthStore();
    await expect(s.login("a", "b", false)).rejects.toThrow();
    expect(s.loading).toBe(false);
  });

  it("logout 清空状态", async () => {
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    const s = useAuthStore();
    s.loggedIn = true;
    s.username = "zhangsan";
    await s.logout();
    expect(s.loggedIn).toBe(false);
    expect(s.username).toBe("");
  });

  it("changeBaseUrl 去掉尾部斜杠", async () => {
    vi.mocked(authApi.setBaseUrl).mockResolvedValue(undefined);
    const s = useAuthStore();
    await s.changeBaseUrl("https://itsm.zhizhengroup.com/");
    expect(s.baseUrl).toBe("https://itsm.zhizhengroup.com");
  });

  it("会话过期事件把 loggedIn 置 false 并带上原因", () => {
    const s = useAuthStore();
    s.loggedIn = true;
    s.handleExpired("会话已过期，且没有保存的凭据");
    expect(s.loggedIn).toBe(false);
    expect(s.error).toContain("过期");
  });

  it("过期原因为空时也给兜底文案", () => {
    const s = useAuthStore();
    s.handleExpired("");
    expect(s.error).toBeTruthy();
  });
});
