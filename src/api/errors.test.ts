import { describe, it, expect } from "vitest";
import { toUserMessage, isAuthError, type AppError } from "./errors";

describe("toUserMessage", () => {
  it("网络错误提示检查内网连接", () => {
    const e: AppError = { kind: "network", message: "connection reset", retryable: true };
    expect(toUserMessage(e)).toContain("网络");
  });

  it("超时错误单独提示", () => {
    const e: AppError = { kind: "timeout", message: "timed out", retryable: true };
    expect(toUserMessage(e)).toContain("超时");
  });

  it("认证错误提示重新登录", () => {
    const e: AppError = { kind: "auth", message: "bad", retryable: false };
    expect(toUserMessage(e)).toContain("登录");
  });

  it("非 AppError 的异常也能出话术", () => {
    expect(toUserMessage(new Error("boom"))).toContain("boom");
    expect(toUserMessage("字符串错误")).toBeTruthy();
  });

  it("未知形状返回兜底话术", () => {
    expect(toUserMessage({})).toContain("未知");
  });

  it("isAuthError 只认 auth", () => {
    expect(isAuthError({ kind: "auth", message: "", retryable: false })).toBe(true);
    expect(isAuthError({ kind: "network", message: "", retryable: true })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });

  it("原始信息会附在话术里，便于排障", () => {
    const e: AppError = { kind: "parse", message: "table tbody tr 为空", retryable: false };
    const msg = toUserMessage(e);
    expect(msg).toContain("改版");
    expect(msg).toContain("table tbody tr 为空");
  });
});
