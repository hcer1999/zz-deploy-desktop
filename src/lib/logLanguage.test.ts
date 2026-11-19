import { describe, it, expect } from "vitest";
import { lineTone, monarchTokens, tokenFor, LOG_LANGUAGE_ID } from "./logLanguage";

describe("lineTone - 整行语气", () => {
  it("失败最优先：同时含「失败」与「成功」时按失败显示", () => {
    expect(lineTone("构建失败！！")).toBe("danger");
    expect(lineTone("构建失败！！没有成功产出")).toBe("danger");
  });

  it("识别常见失败关键词", () => {
    for (const line of [
      "npm ERR! code ELIFECYCLE",
      "Module not found: Cannot find module 'x'",
      "Traceback (most recent call last):",
      "ERROR: failed to solve",
      "构建失败！！",
    ]) {
      expect(lineTone(line), line).toBe("danger");
    }
  });

  it("警告与成功各自成色", () => {
    expect(lineTone("warning package-lock.json found")).toBe("warning");
    expect(lineTone("构建成功")).toBe("success");
    expect(lineTone("Finished: SUCCESS")).toBe("success");
  });

  it("结构行（Step / npm 脚本 / shell 回显）", () => {
    expect(lineTone("Step 3/7 : ADD ./*.tar.gz /data/apps/")).toBe("step");
    expect(lineTone("> DramaFinds.com@2.0.4 build")).toBe("step");
    expect(lineTone("+ mv a.tar.gz /data/download/")).toBe("step");
  });

  it("docker 进度行压暗（它们会被原地覆盖）", () => {
    expect(lineTone("127bb7ebb685: Preparing")).toBe("dim");
    expect(lineTone("10be6ec9e9aa: Pushing  1.883GB")).toBe("dim");
  });

  it("普通行不套语气", () => {
    expect(lineTone("change workspace to /data/itsm-build/workspace/x")).toBe("");
    expect(lineTone("ops")).toBe("");
  });
});

describe("tokenFor - 词法", () => {
  it("点亮 sha256 digest 与 7 位以上十六进制 id", () => {
    expect(tokenFor("sha256:c1db5e16de46f57ebc4a6fcb11ed3dad")).toBe("hash");
    expect(tokenFor("Checkout to 1cac670127624be32adfdef0cbb94ce8a39a927a")).toBe("hash");
  });

  it("不把普通英文词当成 hash", () => {
    for (const line of ["Decade of code", "beef stew", "added 12 packages"]) {
      expect(tokenFor(line), line).toBe("");
    }
  });

  it("整行已有语气时不再逐 token 上色（避免两套颜色打架）", () => {
    expect(tokenFor("构建失败 at 1cac670127624be32adfdef0cbb94ce8a39a927a")).toBe("");
  });
});

describe("monarchTokens", () => {
  it("语法 id 固定，root 规则按「整行 → 词法」顺序排列", () => {
    expect(LOG_LANGUAGE_ID).toBe("zzlog");
    const { tokenizer, defaultToken } = monarchTokens();
    expect(defaultToken).toBe("source");
    expect(Array.isArray(tokenizer.root)).toBe(true);
    const first = (tokenizer.root as unknown[][])[0];
    // 第一条就是失败行规则：确保"失败优先于成功"的语义在 monaco 里同样成立
    expect(String(first[1])).toBe("danger");
  });
});
