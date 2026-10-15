import { describe, it, expect } from "vitest";
import {
  stripAnsi,
  ingest,
  createLogBuffer,
  reset,
  flush,
  normalizeLogText,
  normalizeToLines,
} from "./ansi";

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

  it("换行与「回行首重画」的区别：\r\n 是换行、单独的 \r 覆盖当前行", () => {
    const b = createLogBuffer();
    // 末尾必须带换行：没有终止符的尾巴按设计留在 pending 里等下一个 chunk 拼接
    ingest(b, "a\r\nb\rc\n");
    // b 被 c 原地覆盖 —— 这正是终端里的效果（进度条就是这么刷的）
    expect(b.lines.map((l) => l.text)).toEqual(["a", "c"]);
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

  it("长时间不出换行的输出不会让 pending 无限增长", () => {
    const b = createLogBuffer();
    // 超过 64KB 上限的一大块：应被当作一整行收下，而不是继续堆积
    const huge = "x".repeat(70 * 1024);
    ingest(b, huge);
    expect(b.pending.length).toBeLessThan(huge.length);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].text.length).toBe(huge.length);
  });
});

describe("reset - 服务端换窗口时清空", () => {
  it("清掉行、残留片段与进度行索引", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "半行没有换行");
    reset(b);

    expect(b.lines).toHaveLength(0);
    expect(b.pending).toBe("");
    expect(b.progressIndex.size).toBe(0);

    // 清空后同名进度行应该重新作为新行出现，而不是覆盖到旧下标
    ingest(b, "aaaa: Pushing 90%\n");
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].text).toContain("90%");
  });
});

describe("normalizeLogText - ITSM 的 $<3> 行内刷新标记", () => {
  it("把 $<3> 还原成换行，于是进度行不再被它打散", () => {
    // 真实字节：ESC[1A ESC[1K $<3> ESC[K $<3> \r 127bb7ebb685: Preparing ESC[1B
    const raw = "\u001b[1A\u001b[1K$<3>\u001b[K$<3>\r127bb7ebb685: Preparing \u001b[1B";
    const b = createLogBuffer();
    ingest(b, raw);
    flush(b); // 该 chunk 以 \r 结尾，最后一段按约定留在 pending，流结束（或下个 chunk）才落地
    // 只剩真正的内容行；$<3> 与空行都被吃掉（旧行为下这里会多出一行 "$<3>$<3>"）
    expect(b.lines.map((l) => l.text)).toEqual(["127bb7ebb685: Preparing"]);
  });

  it("连续的进度刷新会合并成一行（原地覆盖），不再刷屏", () => {
    const b = createLogBuffer();
    const tick = (pct: number): string =>
      `\u001b[1A\u001b[1K$<3>\u001b[K$<3>\r80d34305d6ca: Pushing  ${pct}.0kB\u001b[1B`;
    ingest(b, tick(1));
    ingest(b, tick(2));
    ingest(b, tick(3));
    flush(b);
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].text).toBe("80d34305d6ca: Pushing  3.0kB");
    expect(b.lines[0].updates).toBeGreaterThanOrEqual(3);
  });

  it("正常日志（没有 $<3>）不受影响", () => {
    const b = createLogBuffer();
    ingest(b, "Step 1/7 : FROM node:20\nDone\n");
    expect(b.lines.map((l) => l.text)).toEqual(["Step 1/7 : FROM node:20", "Done"]);
  });

  it("normalizeLogText 同时剥 ANSI 并还原换行", () => {
    expect(normalizeLogText("\u001b[31m红\u001b[0m$<3>下一行")).toBe("红\n下一行");
  });
});

describe("ingest - 进度条重画（yarn / next.js）", () => {
  it("ESC[2K ESC[1G 反复重画同一行 → 只剩最后一帧", () => {
    const b = createLogBuffer();
    // 真实字节形态：帧之间只有「擦行 + 光标回行首」，没有 \r 也没有 \n
    const frame = (n: number): string =>
      `Generating static pages (${n}/536)  \u001b[36m[==  ]\u001b[39m\u001b[2K\u001b[1G`;
    ingest(b, frame(0) + frame(74) + frame(242) + `✓ Generating static pages (536/536)\n`);

    expect(b.lines.map((l) => l.text)).toEqual(["✓ Generating static pages (536/536)"]);
  });

  it("yarn 的进度条同理：几百帧只留最后落地的那条，不刷屏", () => {
    const b = createLogBuffer();
    const bar = (done: number, total: number): string =>
      `[${"#".repeat(6)}] ${done}/${total}\u001b[2K\u001b[1G`;
    ingest(b, bar(0, 55102) + bar(510, 55102) + bar(55102, 55102) + "[4/4] Building fresh packages...\n");

    // 进度帧被后一帧覆盖，最终这一行是后面那句；期间最新一帧由视图显示 buffer.pending
    expect(b.lines.map((l) => l.text)).toEqual(["[4/4] Building fresh packages..."]);
  });

  it("重画只替换当前行，不丢弃：最后一帧仍在 pending 里（视图实时显示它）", () => {
    const b = createLogBuffer();
    ingest(b, "[#] 10/100\u001b[2K\u001b[1G[##] 50/100\u001b[2K\u001b[1G[####] 100/100");
    // 还没换行 → 落在 pending，供视图显示"当前行"
    expect(b.pending).toBe("[####] 100/100");
    expect(b.lines).toHaveLength(0);
  });

  it("normalizeToLines：整段文本按同一套规则过成干净的行（历史回看用）", () => {
    const raw = [
      "Generating static pages (0/536)  \u001b[36m[    ]\u001b[39m\u001b[2K\u001b[1G",
      "Generating static pages (242/536)  \u001b[36m[====]\u001b[39m\u001b[2K\u001b[1G",
      "✓ Generating static pages (536/536)\n",
      "\u001b[1A\u001b[1K$<3>\u001b[K$<3>\r80d34305d6ca: Pushing  1.883GB\u001b[1B",
    ].join("");
    expect(normalizeToLines(raw)).toEqual([
      "✓ Generating static pages (536/536)",
      "80d34305d6ca: Pushing  1.883GB",
    ]);
  });

  it("docker 的「光标上移 + 多行进度」不会被误吞：每层各留一行", () => {
    const b = createLogBuffer();
    // 一层一帧，帧之间是 ESC[1A（去上一行重画）+ $<3>
    const frame = (id: string, text: string): string =>
      `\u001b[1A\u001b[1K$<3>\u001b[K$<3>\r${id}: ${text} \u001b[1B`;
    ingest(b, frame("127bb7ebb685", "Preparing") + frame("80d34305d6ca", "Waiting"));
    flush(b);

    expect(b.lines.map((l) => l.text)).toEqual([
      "127bb7ebb685: Preparing",
      "80d34305d6ca: Waiting",
    ]);
  });
});
