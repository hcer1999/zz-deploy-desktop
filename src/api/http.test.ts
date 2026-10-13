import { describe, it, expect } from "vitest";
import { isLoginRedirect, isSuccessRedirect, type HttpResult } from "./http";

function r(status: number, location: string | null): HttpResult {
  return { status, location, body: "" };
}

describe("isLoginRedirect", () => {
  it("绝对地址的登录跳转", () => {
    expect(isLoginRedirect(r(302, "https://itsm.zhizhengroup.com/login/?next=/x"))).toBe(true);
  });

  it("相对地址的登录跳转", () => {
    expect(isLoginRedirect(r(302, "/login/"))).toBe(true);
  });

  it("业务跳转不算登录跳转", () => {
    expect(isLoginRedirect(r(302, "/deployment/deploy/task/"))).toBe(false);
  });

  it("200 不算", () => {
    expect(isLoginRedirect(r(200, "/login/"))).toBe(false);
  });

  it("query 里出现 /login/ 不误判", () => {
    expect(isLoginRedirect(r(302, "/deployment/deploy/task/?ref=/login/"))).toBe(false);
  });

  it("没有 location 不算", () => {
    expect(isLoginRedirect(r(302, null))).toBe(false);
  });
});

describe("isSuccessRedirect", () => {
  it("业务 302 是成功", () => {
    expect(isSuccessRedirect(r(302, "/deployment/deploy/task/"))).toBe(true);
  });

  it("会话过期的 302 不是成功", () => {
    expect(isSuccessRedirect(r(302, "/login/?next=/x"))).toBe(false);
  });

  it("200 不是 302 成功", () => {
    expect(isSuccessRedirect(r(200, null))).toBe(false);
  });
});
