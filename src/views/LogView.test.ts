import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/log", () => ({
  logOpen: vi.fn(async () => "s1"),
  logClose: vi.fn(async () => {}),
}));

/**
 * 真实 monaco 在 jsdom 里跑不起来（体积 + worker），这里用桩替身：
 * 记录 LogView 调用了几次 scrollToBottom / layout，并把收到的行暴露到 DOM 上断言。
 * 同步算法本身由 lib/logModel 与 LogEditor 的单测覆盖。
 */
const calls = vi.hoisted(() => ({ scroll: 0, layout: 0 }));

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
      setup(props, { expose }) {
        expose({
          scrollToBottom: () => {
            calls.scroll += 1;
          },
          layout: () => {
            calls.layout += 1;
          },
          getText: () => "",
        });
        return () =>
          h("div", {
            "data-test": "log-editor",
            "data-lines": JSON.stringify(
              (props.lines as { text: string }[]).map((l) => l.text),
            ),
            "data-pending": props.pending,
            "data-dropped": String(props.dropped),
          });
      },
    }),
  };
});

import { useLogsStore } from "@/stores/logs";
import { useTabsStore } from "@/stores/tabs";
import { clearTab, setOpenLog } from "@/stores/tabPayload";
import LogView from "./LogView.vue";

let pinia: Pinia;

const TAB = "log-1";

async function mountLog(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  // 本标签是当前激活标签（否则"隐藏时不滚"的逻辑会把它当成后台标签）
  useTabsStore().activeId = TAB;
  setOpenLog(TAB, {
    taskId: 42,
    deployType: "auto",
    projectName: "proj-AAA",
    envName: "测试环境",
  });
  const w = mount(LogView, { props: { tabId: TAB }, global: { plugins: [pinia] } });
  await flushPromises();
  return w;
}

/** 桩组件收到的行（按渲染文本） */
function editorLines(w: ReturnType<typeof mount>): string[] {
  const el = w.find('[data-test="log-editor"]');
  return JSON.parse(el.attributes("data-lines") ?? "[]") as string[];
}
function editorPending(w: ReturnType<typeof mount>): string {
  return w.find('[data-test="log-editor"]').attributes("data-pending") ?? "";
}

describe("LogView 自动滚动", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.scroll = 0;
    calls.layout = 0;
    clearTab(TAB);
  });

  it("新日志到达时滚到底部", async () => {
    const w = await mountLog();
    calls.scroll = 0;

    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "第一行\n第二行\n" });
    await flushPromises();

    expect(calls.scroll).toBeGreaterThan(0);
    expect(editorLines(w)).toEqual(["第一行", "第二行"]);
  });

  it("关掉「自动滚动」后不再跟随（保留用户位置）", async () => {
    const w = await mountLog();
    await w.find('input[type="checkbox"]').setValue(false);
    calls.scroll = 0;

    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "第一行\n" });
    await flushPromises();

    expect(calls.scroll).toBe(0);
  });

  // 真实 Chromium 实测的 bug：标签被 v-show 隐藏时 display:none 让 Monaco 尺寸为 0，
  // 后台收到的日志全部滚不动；切回来时必须重排 + 补一次滚到底。
  it("隐藏期间不滚；切回标签时先 layout 再滚到底", async () => {
    const w = await mountLog();
    const tabs = useTabsStore();
    tabs.activeId = "other-tab";
    calls.scroll = 0;
    calls.layout = 0;

    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "后台日志\n" });
    await flushPromises();
    expect(calls.scroll).toBe(0);

    tabs.activeId = TAB;
    await flushPromises();
    expect(calls.layout).toBe(1);
    expect(calls.scroll).toBe(1);
    w.unmount();
  });
});

describe("LogView 服务端快照语义", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTab(TAB);
  });

  it("reset 事件先清空再追加（服务端换窗口时不会拼出两份日志）", async () => {
    const w = await mountLog();
    const logs = useLogsStore();

    logs.onData({ sessionId: "s1", reset: false, chunk: "旧日志 1\n旧日志 2\n" });
    await flushPromises();
    expect(editorLines(w)).toEqual(["旧日志 1", "旧日志 2"]);

    logs.onData({ sessionId: "s1", reset: true, chunk: "新窗口 1\n" });
    await flushPromises();
    expect(editorLines(w)).toEqual(["新窗口 1"]);
  });

  it("服务端拒绝时把它的原话显示出来", async () => {
    const w = await mountLog();
    useLogsStore().onStatus({ sessionId: "s1", state: "error", detail: "数据格式错误" });
    await flushPromises();

    expect(w.text()).toContain("连接错误");
    expect(w.text()).toContain("服务端：数据格式错误");
  });

  it("流结束时把最后一段没有换行的残留显示出来", async () => {
    const w = await mountLog();
    const logs = useLogsStore();

    logs.onData({ sessionId: "s1", reset: false, chunk: "完整行\n最后半行" });
    await flushPromises();
    expect(editorLines(w)).toEqual(["完整行"]);
    expect(editorPending(w)).toBe("最后半行");

    logs.onStatus({ sessionId: "s1", state: "finished" });
    await flushPromises();
    expect(editorLines(w)).toEqual(["完整行", "最后半行"]);
    expect(editorPending(w)).toBe("");
  });
});
