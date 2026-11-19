import { describe, it, expect, afterEach, beforeAll, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";
import type { LogLine } from "@/lib/ansi";

/**
 * jsdom 里不加载真实 monaco（体积 + worker 都不适合）：
 * 用假的 editor 记录 API 调用，验证同步规划被正确执行。
 * monaco 的语法/颜色由 logLanguage 的单测覆盖。
 */
const calls = {
  setValue: [] as string[],
  applyEdits: [] as unknown[][],
  revealLine: [] as number[],
  layout: 0,
  dispose: 0,
  decorations: [] as unknown[][],
};

class FakeModel {
  private lines: string[] = [""];
  getLineCount(): number {
    return this.lines.length;
  }
  getValue(): string {
    return this.lines.join("\n");
  }
  setValue(text: string): void {
    calls.setValue.push(text);
    this.lines = text === "" ? [""] : text.split("\n");
  }
  applyEdits(edits: { range: FakeRange; text: string }[]): void {
    calls.applyEdits.push(edits);
    // 从后往前应用，与我们生成的升序 edit 配套
    for (const e of [...edits].sort((a, b) => b.range.endLineNumber - a.range.endLineNumber)) {
      const next = e.text === "" ? [] : e.text.split("\n");
      this.lines.splice(e.range.startLineNumber - 1, e.range.endLineNumber - e.range.startLineNumber, ...next);
    }
  }
}

class FakeRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number,
  ) {}
}

const fakeEditor = {
  getModel: () => model,
  layout: () => {
    calls.layout += 1;
  },
  revealLine: (n: number) => calls.revealLine.push(n),
  createDecorationsCollection: (d: unknown[]) => {
    calls.decorations.push(d);
    return { set: (next: unknown[]) => calls.decorations.push(next), clear: () => {} };
  },
  dispose: () => {
    calls.dispose += 1;
  },
};

let model = new FakeModel();

vi.mock("monaco-editor/editor/editor.api", () => ({
  editor: {
    create: () => fakeEditor,
    defineTheme: vi.fn(),
    // 与真实 monaco 的 ScrollType.Immediate 对齐
    ScrollType: { Smooth: 0, Immediate: 1 },
  },
  languages: {
    register: vi.fn(),
    setMonarchTokensProvider: vi.fn(),
  },
  Range: FakeRange,
}));

vi.mock("@/lib/monacoWorker", () => ({ installMonacoWorker: vi.fn() }));

import LogEditor from "./LogEditor.vue";

function line(id: number, text: string, updates = 1): LogLine {
  return { id, text, updates };
}

function resetCalls(): void {
  calls.setValue.length = 0;
  calls.applyEdits.length = 0;
  calls.revealLine.length = 0;
  calls.layout = 0;
  calls.dispose = 0;
  calls.decorations.length = 0;
  model = new FakeModel();
}

beforeAll(() => {
  // 假 model 在模块加载后再绑定，避免 vi.mock 提升顺序问题
});

let mounted: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  await flushPromises();
  mounted?.unmount();
  mounted = null;
  resetCalls();
});

async function mountEditor(props: {
  lines: LogLine[];
  dropped?: number;
  pending?: string;
  autoScroll?: boolean;
}): Promise<ReturnType<typeof mount>> {
  resetCalls();
  mounted = mount(LogEditor, {
    props: {
      lines: props.lines,
      dropped: props.dropped ?? 0,
      pending: props.pending ?? "",
      autoScroll: props.autoScroll ?? false,
      rev: 0,
    },
    attachTo: document.body,
  });
  await flushPromises();
  return mounted;
}

describe("LogEditor", () => {
  it("首次挂载整篇写入", async () => {
    await mountEditor({ lines: [line(1, "a"), line(2, "b")] });
    expect(calls.setValue).toEqual(["a\nb"]);
  });

  it("追加行用 applyEdits，不再整篇 setValue", async () => {
    const w = await mountEditor({ lines: [line(1, "a")] });
    await w.setProps({ lines: [line(1, "a"), line(2, "b")] });
    await flushPromises();

    expect(calls.setValue).toHaveLength(1);
    expect(calls.applyEdits).toHaveLength(1);
    expect(calls.applyEdits[0]).toHaveLength(1);
    expect(fakeEditor.getModel().getValue()).toBe("a\nb");
  });

  it("自动滚动开启时每次同步后 revealLine；关闭时不滚", async () => {
    const w = await mountEditor({ lines: [line(1, "a")], autoScroll: true });
    expect(calls.revealLine.length).toBeGreaterThan(0);

    const before = calls.revealLine.length;
    await w.setProps({ lines: [line(1, "a"), line(2, "b")], autoScroll: false });
    await flushPromises();
    expect(calls.revealLine.length).toBe(before);
  });

  it("expose 的 layout/scrollToBottom 可用（切回隐藏标签时要用）", async () => {
    const w = await mountEditor({ lines: [line(1, "a")] });
    (w.vm as unknown as { layout: () => void }).layout();
    (w.vm as unknown as { scrollToBottom: () => void }).scrollToBottom();
    expect(calls.layout).toBe(1);
    expect(calls.revealLine.length).toBeGreaterThan(0);
  });

  it("卸载时释放 editor", async () => {
    const w = await mountEditor({ lines: [line(1, "a")] });
    w.unmount();
    mounted = null;
    expect(calls.dispose).toBe(1);
  });

  it("缓冲区原地追加（同一个数组引用）也要同步 —— 日志是 push 进去的，不是换数组", async () => {
    const live = reactive<LogLine[]>([line(1, "a")]);
    const w = await mountEditor({ lines: live });
    expect(calls.setValue).toEqual(["a"]);

    live.push(line(2, "b"));
    await flushPromises();

    expect(calls.applyEdits.length).toBeGreaterThan(0);
    expect(fakeEditor.getModel().getValue()).toBe("a\nb");
    w.unmount();
    mounted = null;
  });

  it("进度行原地改写（同一下标改文本）也要同步", async () => {
    const live = reactive<LogLine[]>([line(1, "a"), line(2, "pulling 10%")]);
    const w = await mountEditor({ lines: live });

    live[1].text = "pulling 90%";
    live[1].updates = 2;
    await flushPromises();

    expect(fakeEditor.getModel().getValue()).toBe("a\npulling 90%");
    w.unmount();
    mounted = null;
  });

  it("清空缓冲区后模型也清空", async () => {
    const live = reactive<LogLine[]>([line(1, "a"), line(2, "b")]);
    const w = await mountEditor({ lines: live });

    live.splice(0, live.length);
    await flushPromises();

    expect(fakeEditor.getModel().getValue()).toBe("");
    w.unmount();
    mounted = null;
  });

  it("进度行（updates > 1）加整行装饰，用于压暗", async () => {
    const w = await mountEditor({ lines: [line(1, "a"), line(2, "pulling 10%", 2)] });
    await flushPromises();
    const last = calls.decorations[calls.decorations.length - 1] as {
      options: { className: string };
    }[];
    expect(last).toHaveLength(1);
    expect(last[0].options.className).toContain("log-progress-dim");
    w.unmount();
    mounted = null;
  });
});
