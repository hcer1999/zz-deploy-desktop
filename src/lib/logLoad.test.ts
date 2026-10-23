import { describe, expect, it } from "vitest";
import { createLogBuffer, ingest } from "./ansi";
import {
  INGEST_SLICE,
  ingestLarge,
  normalizeToLinesAsync,
  normalizeToTextAsync,
  safeCutIndex,
  yieldToMain,
} from "./logLoad";

describe("safeCutIndex", () => {
  it("优先切在换行之后（ANSI/进度行不会跨行）", () => {
    const s = "line1\nline2\nline3";
    // 上限落在第一行内 → 应该切在第一个 \n 之后
    expect(safeCutIndex(s, 0, 3)).toBe(6);
  });

  it("没有换行时按长度切，且不切断 UTF-16 代理对", () => {
    const s = "a".repeat(5) + "😀" + "b".repeat(10);
    const cut = safeCutIndex(s, 0, 6); // 正好落在 emoji 的高位代理之后
    expect(s.slice(0, cut) + s.slice(cut)).toBe(s);
    expect(s.charCodeAt(cut - 1) >= 0xd800 && s.charCodeAt(cut - 1) <= 0xdbff).toBe(false);
  });

  it("字符串比上限短时直接返回长度", () => {
    expect(safeCutIndex("abc", 0, 100)).toBe(3);
  });
});

describe("ingestLarge", () => {
  it("分片结果与一次性 ingest 完全一致（跨切片的半行也不丢）", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 3000; i++) {
      lines.push(`line ${i} \u001b[32mok\u001b[0m`);
    }
    // 混入进度重画与超长单行，覆盖 pending / rewrite 分支
    const raw =
      "aaaa: Pushing 10%\r" +
      "aaaa: Pushing 90%\n" +
      lines.join("\n") +
      "\n" +
      "partial tail without newline";

    const sync = createLogBuffer();
    ingest(sync, raw);

    const asyncBuf = createLogBuffer();
    const progress: number[] = [];
    await ingestLarge(asyncBuf, raw, { onProgress: (done) => progress.push(done) });

    expect(asyncBuf.lines.map((l) => l.text)).toEqual(sync.lines.map((l) => l.text));
    expect(asyncBuf.pending).toBe(sync.pending);
    expect(progress[progress.length - 1]).toBe(raw.length);
  });

  it("超长单行即使被切片，内容也不丢（可能落成多行，但拼起来一致）", async () => {
    const buf = createLogBuffer();
    const big = "x".repeat(INGEST_SLICE * 3);
    await ingestLarge(buf, big);
    expect(buf.lines.map((l) => l.text).join("") + buf.pending).toBe(big);
  });

  it("取消后立即停止，不再继续处理剩余内容", async () => {
    const buf = createLogBuffer();
    let calls = 0;
    await ingestLarge(buf, "y\n".repeat(200_000), {
      onProgress: () => {
        calls += 1;
      },
      cancelled: () => calls >= 1,
    });
    expect(calls).toBe(1);
    expect(buf.lines.length).toBeLessThan(200_000);
  });
});

describe("normalizeToLinesAsync", () => {
  it("只保留最后 maxLines 行，并报告省略了多少行", async () => {
    const raw = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n";
    const r = await normalizeToLinesAsync(raw, { maxLines: 10 });
    expect(r.lines).toHaveLength(10);
    expect(r.lines[0]).toBe("line 90");
    expect(r.omitted).toBe(90);
  });

  it("与同步 normalizeToLines 的输出一致（历史回看与实时显示同一套规则）", async () => {
    const raw = "a\r\nb\rc\n\u001b[1A\u001b[1K$<3>\u001b[K$<3>\r123abc: Pushing 1%\n";
    const r = await normalizeToLinesAsync(raw);
    expect(r.lines).toEqual(["a", "c", "123abc: Pushing 1%"]);
    expect(r.omitted).toBe(0);
  });

  it("取消时返回空结果，避免把旧请求的解析结果写回界面", async () => {
    let cancelled = false;
    const p = normalizeToLinesAsync("z\n".repeat(100_000), {
      onProgress: () => {
        cancelled = true;
      },
      cancelled: () => cancelled,
    });
    const r = await p;
    expect(r.lines).toEqual([]);
  });
});

describe("normalizeToTextAsync", () => {
  it("导出保留全部行（不像预览那样截断）", async () => {
    const text = await normalizeToTextAsync("one\ntwo\nthree\n");
    expect(text).toBe("one\ntwo\nthree");
  });
});

describe("yieldToMain", () => {
  it("返回一个可 await 的 Promise", async () => {
    await expect(yieldToMain()).resolves.toBeUndefined();
  });
});
