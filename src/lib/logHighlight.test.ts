import { describe, it, expect, beforeEach } from "vitest";
import {
  highlightLine,
  highlightLineCached,
  clearHighlightCache,
  markMatches,
  SEARCH_HIT_CLS,
} from "./logHighlight";

/** 取整行的类名（整行一个片段时） */
function clsOf(line: string): string {
  return highlightLine(line)[0].cls;
}

describe("highlightLine - 整行语气", () => {
  it("失败最优先：同时含「失败」与「成功」时按失败显示", () => {
    expect(clsOf("构建失败！！")).toContain("red");
    expect(clsOf("构建失败！！没有成功产出")).toContain("red");
  });

  it("识别常见失败关键词", () => {
    for (const line of [
      "npm ERR! code ELIFECYCLE",
      "Module not found: Cannot find module 'x'",
      "Traceback (most recent call last):",
      "ERROR: failed to solve",
      "构建失败！！",
    ]) {
      expect(clsOf(line), line).toContain("red");
    }
  });

  it("警告与成功各自成色", () => {
    expect(clsOf("warning package-lock.json found")).toContain("amber");
    expect(clsOf("构建成功")).toContain("emerald");
    expect(clsOf("Finished: SUCCESS")).toContain("emerald");
  });

  it("结构行（Step / npm 脚本 / shell 回显）用另一种颜色", () => {
    expect(clsOf("Step 3/7 : ADD ./*.tar.gz /data/apps/")).toContain("sky");
    expect(clsOf("> DramaFinds.com@2.0.4 build")).toContain("sky");
    expect(clsOf("+ mv a.tar.gz /data/download/")).toContain("sky");
  });

  it("docker 进度行压暗（它们会被原地覆盖）", () => {
    expect(clsOf("127bb7ebb685: Preparing")).toContain("white/45");
    expect(clsOf("10be6ec9e9aa: Pushing  1.883GB")).toContain("white/45");
  });

  it("普通行不套语气", () => {
    expect(clsOf("change workspace to /data/itsm-build/workspace/x")).toBe("");
    expect(clsOf("ops")).toBe("");
  });
});

describe("highlightLine - 词法高亮", () => {
  it("点亮 7 位以上的十六进制 id（层 id / 提交 hash）", () => {
    const segs = highlightLine("Checkout to 1cac670127624be32adfdef0cbb94ce8a39a927a");
    expect(segs.map((s) => s.text).join("")).toBe(
      "Checkout to 1cac670127624be32adfdef0cbb94ce8a39a927a",
    );
    const hash = segs.find((s) => s.text.startsWith("1cac670"));
    expect(hash?.cls).toContain("amber");
  });

  it("点亮 sha256 digest", () => {
    const segs = highlightLine("digest: sha256:c1db5e16de46f57ebc4a6fcb11ed3dadc722792b9785bf6ef03dc9c55e4629b3");
    expect(segs.find((s) => s.text.startsWith("sha256:"))?.cls).toContain("amber");
  });

  it("不把普通英文词当成 hash（含大写与短词）", () => {
    // "Decade" 含非十六进制字符；"beef" 太短 —— 都不该被点亮
    for (const line of ["Decade of code", "beef stew", "added 12 packages"]) {
      expect(highlightLine(line).every((s) => !s.cls), line).toBe(true);
    }
  });

  it("有整行语气时不再逐 token 上色（避免两套颜色打架）", () => {
    const segs = highlightLine("构建失败 at 1cac670127624be32adfdef0cbb94ce8a39a927a");
    expect(segs).toHaveLength(1);
    expect(segs[0].cls).toContain("red");
  });

  it("片段拼回来等于原文（渲染不能丢字符）", () => {
    const line = "1cac670..abc1234  release/dramafinds.com -> origin/release/dramafinds.com";
    expect(
      highlightLine(line)
        .map((s) => s.text)
        .join(""),
    ).toBe(line);
  });
});

describe("highlightLineCached", () => {
  beforeEach(() => clearHighlightCache());

  it("同一行只算一次，且结果与直接调用一致", () => {
    const a = highlightLineCached("Step 1/7 : FROM node");
    const b = highlightLineCached("Step 1/7 : FROM node");
    expect(b).toBe(a); // 命中缓存：同一引用
    expect(a).toEqual(highlightLine("Step 1/7 : FROM node"));
  });
});

describe("markMatches", () => {
  it("把命中的片段标出来，其余保持原类名", () => {
    const segs = markMatches("构建成功：dramafinds-com 构建成功", "构建成功", "text-white/45");
    expect(segs.map((s) => s.text).join("")).toBe("构建成功：dramafinds-com 构建成功");
    const hits = segs.filter((s) => s.cls.includes(SEARCH_HIT_CLS));
    expect(hits).toHaveLength(2);
    expect(hits[0].text).toBe("构建成功");
  });

  it("大小写不敏感（搜 error 能命中 ERROR）", () => {
    const segs = markMatches("ERROR: failed", "error", "");
    expect(segs.some((s) => s.text === "ERROR")).toBe(true);
  });

  it("没有 query 时原样返回", () => {
    expect(markMatches("abc", "", "x")).toEqual([{ text: "abc", cls: "x" }]);
  });
});
