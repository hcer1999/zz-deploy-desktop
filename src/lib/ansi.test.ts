import { describe, it, expect } from "vitest";
import { stripAnsi, ingest, createLogBuffer } from "./ansi";

describe("stripAnsi", () => {
  it("去掉 SGR 颜色码", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("去掉光标移动与清屏码", () => {
    expect(stripAnsi("\u001b[2K\u001b[1Ahello")).toBe("hello");
  });

  it("去掉 OSC 序列（如设置终端标题）", () => {
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
  });

  it("没有转义码时原样返回", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("ingest - 基本追加", () => {
  it("按行切分并追加", () => {
    const b = createLogBuffer();
    ingest(b, "line1\nline2\n");
    expect(b.lines.map((l) => l.text)).toEqual(["line1", "line2"]);
  });

  it("跨 chunk 的不完整行会拼接", () => {
    const b = createLogBuffer();
    ingest(b, "par");
    ingest(b, "tial\n");
    expect(b.lines.map((l) => l.text)).toEqual(["partial"]);
  });

  it("\\r\\n 与单独的 \\r 都算换行", () => {
    const b = createLogBuffer();
    // 末尾必须带换行：没有终止符的尾巴按设计留在 pending 里等下一个 chunk 拼接
    ingest(b, "a\r\nb\rc\n");
    expect(b.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("忽略空行", () => {
    const b = createLogBuffer();
    ingest(b, "a\n\n\nb\n");
    expect(b.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });
});

describe("ingest - 进度行原地更新", () => {
  it("同一层的进度行覆盖而不是新增", () => {
    // docker build 的典型输出：同一层反复推进度百分比
    const b = createLogBuffer();
    ingest(b, "a1b2c3d4: Pushing   [==>   ] 10%\n");
    ingest(b, "a1b2c3d4: Pushing   [====> ] 50%\n");
    ingest(b, "a1b2c3d4: Pushing   [======] 100%\n");
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].text).toContain("100%");
  });

  it("不同层的进度行各自独立", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "bbbb: Pushing 20%\n");
    ingest(b, "aaaa: Pushing 90%\n");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[0].text).toContain("90%");
    expect(b.lines[1].text).toContain("20%");
  });

  it("进度行结束后再出现的普通行正常追加", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 100%\n");
    ingest(b, "Successfully built abc123\n");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[1].text).toBe("Successfully built abc123");
  });

  it("Pulling / Downloading / Extracting 等也按进度行处理", () => {
    for (const verb of ["Pulling", "Downloading", "Extracting", "Waiting", "Preparing"]) {
      const b = createLogBuffer();
      ingest(b, `ffff: ${verb} 10%\n`);
      ingest(b, `ffff: ${verb} 80%\n`);
      expect(b.lines).toHaveLength(1);
      expect(b.lines[0].text).toContain("80%");
    }
  });

  it("被覆盖的行记录更新次数，便于 UI 做高亮", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "aaaa: Pushing 20%\n");
    ingest(b, "aaaa: Pushing 30%\n");
    expect(b.lines[0].updates).toBe(3);
  });
});

describe("ingest - 上限保护", () => {
  it("超过上限时丢弃最旧的行，避免长时间构建把内存吃满", () => {
    const b = createLogBuffer({ maxLines: 10 });
    for (let i = 0; i < 25; i++) ingest(b, `line ${i}\n`);
    expect(b.lines).toHaveLength(10);
    expect(b.lines[0].text).toBe("line 15");
    expect(b.lines[9].text).toBe("line 24");
  });

  it("超限时保留进度行索引的正确性（被丢弃的进度行要重新追加）", () => {
    const b = createLogBuffer({ maxLines: 3 });
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "x\n");
    ingest(b, "y\n");
    ingest(b, "z\n");
    // aaaa 那行已被挤出窗口，此时再来一条 aaaa 进度应作为新行追加
    ingest(b, "aaaa: Pushing 90%\n");
    expect(b.lines.filter((l) => l.text.includes("aaaa")).length).toBe(1);
    expect(b.lines[b.lines.length - 1].text).toContain("90%");
  });
});
