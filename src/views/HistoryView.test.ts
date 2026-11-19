import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/history", () => ({
  listHistory: vi.fn(async () => ({
    entries: [
      {
        deployType: "auto",
        taskId: 42,
        projectName: "proj-AAA",
        envName: "测试环境",
        size: 2048,
        startedAt: Date.parse("2026-11-19T10:00:00Z"),
      },
    ],
    totalSize: 2048,
  })),
  readHistoryTail: vi.fn(async () => ({ text: "第一行\n第二行\n第三行", truncated: false })),
  readHistory: vi.fn(async () => "第一行\n第二行\n第三行"),
  deleteHistory: vi.fn(async () => {}),
  clearHistory: vi.fn(async () => {}),
  applyHistoryRetention: vi.fn(async () => 0),
  exportHistory: vi.fn(async () => "/tmp/log.txt"),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(async () => "/tmp/log.txt") }));

// 真实 monaco 在 jsdom 里跑不了：只断言 HistoryView 传了什么进去
vi.mock("@/components/log/LogEditor.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return {
    default: defineComponent({
      props: {
        lines: { type: Array, default: () => [] },
        dropped: { type: Number, default: 0 },
        pending: { type: String, default: "" },
        autoScroll: { type: Boolean, default: true },
      },
      setup(props) {
        return () =>
          h("div", {
            "data-test": "log-editor",
            "data-lines": JSON.stringify((props.lines as { text: string }[]).map((l) => l.text)),
            "data-auto": String(props.autoScroll),
            "data-pending": String(props.pending),
          });
      },
    }),
  };
});

import HistoryView from "./HistoryView.vue";

let pinia: Pinia;

async function mountView(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(HistoryView, { global: { plugins: [pinia] }, attachTo: document.body });
  await flushPromises();
  return w;
}

async function expandFirst(w: ReturnType<typeof mount>): Promise<void> {
  // 行首那个按钮（项目名那一段）就是展开/收起入口
  const btn = w.find("li button");
  await btn.trigger("click");
  await flushPromises();
}

describe("HistoryView 预览", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("展开后用 LogEditor 渲染解析后的行（只读、不自动滚动）", async () => {
    const w = await mountView();
    await expandFirst(w);

    const editor = w.find('[data-test="log-editor"]');
    expect(editor.exists()).toBe(true);
    expect(JSON.parse(editor.attributes("data-lines") ?? "[]")).toEqual(["第一行", "第二行", "第三行"]);
    expect(editor.attributes("data-auto")).toBe("false");
    expect(editor.attributes("data-pending")).toBe("");
  });

  it("大日志的提示文案保留", async () => {
    const historyApi = await import("@/api/history");
    vi.mocked(historyApi.readHistoryTail).mockResolvedValueOnce({
      text: Array.from({ length: 6000 }, (_, i) => `line-${i}`).join("\n"),
      truncated: true,
    });
    const w = await mountView();
    await expandFirst(w);
    expect(w.text()).toContain("仅显示最后");
  });
});
