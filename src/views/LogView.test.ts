import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/log", () => ({
  logOpen: vi.fn(async () => "s1"),
  logClose: vi.fn(async () => {}),
}));

import { useLogsStore } from "@/stores/logs";
import { useTabsStore } from "@/stores/tabs";
import { clearTab, setOpenLog } from "@/stores/tabPayload";
import LogView from "./LogView.vue";

let pinia: Pinia;

const TAB = "log-1";

async function mountLog(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
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

/** 把滚动容器换成可观测的假实现（jsdom 没有布局，scrollHeight 恒为 0） */
function fakeScroller(w: ReturnType<typeof mount>): {
  top: () => number;
  writes: () => number;
  height: number;
} {
  const el = w.find(".overflow-auto").element as HTMLElement;
  const state = { top: 0, height: 640, writes: 0 };
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
      state.writes += 1;
    },
  });
  return {
    top: () => state.top,
    writes: () => state.writes,
    get height() {
      return state.height;
    },
    set height(v: number) {
      state.height = v;
    },
  };
}

describe("LogView 自动滚动", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTab(TAB);
  });

  it("新日志到达时滚到底部", async () => {
    const w = await mountLog();
    const scroller = fakeScroller(w);

    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "第一行\n第二行\n" });
    await flushPromises();

    expect(scroller.top()).toBe(scroller.height);
  });

  it("关掉「自动滚动」后不再跟随（保留用户位置）", async () => {
    const w = await mountLog();
    const scroller = fakeScroller(w);

    await w.find('input[type="checkbox"]').setValue(false);
    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "第一行\n" });
    await flushPromises();

    expect(scroller.top()).toBe(0);
  });

  // 真实 Chromium 实测的 bug：标签被 v-show 隐藏时 display:none 让 scrollHeight 为 0，
  // 后台收到的日志全部滚不动；切回来时若没有补偿就会一直停在最上面。
  it("隐藏期间不写滚动位置（scrollHeight 为 0 时写进去等于丢回顶部）", async () => {
    const w = await mountLog();
    const scroller = fakeScroller(w);
    scroller.height = 0; // 模拟 display:none

    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "后台日志\n" });
    await flushPromises();

    expect(scroller.writes()).toBe(0);
    expect(scroller.top()).toBe(0);
  });

  it("切回日志标签时补滚到底部", async () => {
    const w = await mountLog();
    const scroller = fakeScroller(w);
    const tabs = useTabsStore();

    // 标签在后台：日志持续流入，但位置停在顶部
    tabs.activeId = "other-tab";
    scroller.height = 0;
    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "后台第 1 行\n后台第 2 行\n" });
    await flushPromises();
    expect(scroller.top()).toBe(0);

    // 切回来：可见后立刻补一次滚到底
    scroller.height = 1200;
    tabs.activeId = TAB;
    await flushPromises();

    expect(scroller.top()).toBe(1200);
  });
});

describe("LogView 服务端快照语义", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTab(TAB);
  });

  it("reset 事件先清空再追加（服务端换窗口时不会拼出两份日志）", async () => {
    const w = await mountLog();
    fakeScroller(w);
    const logs = useLogsStore();

    logs.onData({ sessionId: "s1", reset: false, chunk: "旧日志 1\n旧日志 2\n" });
    await flushPromises();
    expect(w.text()).toContain("旧日志 1");

    logs.onData({ sessionId: "s1", reset: true, chunk: "新窗口 1\n" });
    await flushPromises();
    expect(w.text()).toContain("新窗口 1");
    expect(w.text()).not.toContain("旧日志 1");
  });

  it("服务端拒绝时把它的原话显示出来", async () => {
    const w = await mountLog();
    useLogsStore().onStatus({ sessionId: "s1", state: "error", detail: "数据格式错误" });
    await flushPromises();

    expect(w.text()).toContain("连接错误");
    expect(w.text()).toContain("服务端：数据格式错误");
  });
});

describe("LogView 语法高亮与查找", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTab(TAB);
  });

  /** 往会话里灌日志（会话由 mountLog 打开为 s1） */
  async function feed(
    w: ReturnType<typeof mount>,
    chunk: string,
  ): Promise<void> {
    useLogsStore().onData({ sessionId: "s1", reset: false, chunk });
    await flushPromises();
    void w;
  }

  it("按语法给关键行上色（失败红、成功绿、Step 蓝、进度压暗）", async () => {
    const w = await mountLog();
    await feed(
      w,
      [
        "Step 3/7 : ADD ./*.tar.gz /data/apps/",
        "10be6ec9e9aa: Pushing  1.883GB",
        "npm ERR! code ELIFECYCLE",
        "构建成功",
      ].join("\n") + "\n",
    );

    const html = w.html();
    expect(html).toContain("text-sky-300"); // Step 行
    expect(html).toContain("text-white/45"); // 进度行
    expect(html).toContain("text-red-400"); // npm ERR!
    expect(html).toContain("text-emerald-400"); // 构建成功
  });

  it("搜索：统计匹配行、高亮命中、Enter 与上/下一个跳转", async () => {
    const w = await mountLog();
    await feed(w, "warning one\n构建成功\nwarning two\nerror three\n");

    const input = w.find('[data-test="log-search"]');
    await input.setValue("warning");
    await flushPromises();

    // 计数显示 1/2（两行命中）
    expect(w.text()).toContain("1/2");
    expect(w.html()).toContain("bg-amber-400"); // 命中底色

    // 下一个 → 2/2
    await w.find('[data-test="search-next"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("2/2");

    // 再下一个回环到 1/2
    await w.find('[data-test="search-next"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("1/2");

    // 上一个从 1 回环到 2
    await w.find('[data-test="search-prev"]').trigger("click");
    await flushPromises();
    expect(w.text()).toContain("2/2");
  });

  it("搜索会关掉自动滚动，清除后计数消失", async () => {
    const w = await mountLog();
    fakeScroller(w);
    await feed(w, "line a\nline b\n");

    const autoScrollBox = w.find('input[type="checkbox"]');
    expect((autoScrollBox.element as HTMLInputElement).checked).toBe(true);

    await w.find('[data-test="log-search"]').setValue("line");
    await flushPromises();
    expect((autoScrollBox.element as HTMLInputElement).checked).toBe(false);

    await w.find('[data-test="search-clear"]').trigger("click");
    await flushPromises();
    expect((w.find('[data-test="log-search"]').element as HTMLInputElement).value).toBe("");
    expect(w.text()).not.toContain("1/1");
  });

  it("没有命中时显示 0/0 且跳转按钮禁用", async () => {
    const w = await mountLog();
    await feed(w, "hello\n");
    await w.find('[data-test="log-search"]').setValue("不存在的东西");
    await flushPromises();

    expect(w.text()).toContain("0/0");
    expect((w.find('[data-test="search-next"]').element as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("LogView 当前行（重画式进度条）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearTab(TAB);
  });

  it("还没换行的内容作为「当前行」实时显示（否则重画期间界面一片空白）", async () => {
    const w = await mountLog();
    fakeScroller(w);

    // 进度条：两帧就地重画，没有换行
    useLogsStore().onData({
      sessionId: "s1",
      reset: false,
      chunk: "[#] 10/100\u001b[2K\u001b[1G[####] 100/100",
    });
    await flushPromises();

    const live = w.find('[data-test="live-line"]');
    expect(live.exists()).toBe(true);
    expect(live.text()).toContain("[####] 100/100");
    // 还没落地成正式行
    expect(w.find('[data-line="0"]').exists()).toBe(false);
  });

  it("换行之后当前行变成正式行，当前行显示消失", async () => {
    const w = await mountLog();
    fakeScroller(w);

    // 半行（没有换行）→ 只作为"当前行"显示
    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "半个" });
    await flushPromises();
    expect(w.find('[data-test="live-line"]').text()).toContain("半个");
    expect(w.find('[data-line="0"]').exists()).toBe(false);

    // 补上后半行 + 换行 → 落地成正式行，当前行消失
    useLogsStore().onData({ sessionId: "s1", reset: false, chunk: "整行\n" });
    await flushPromises();

    expect(w.find('[data-line="0"]').text()).toContain("半个");
    expect(w.find('[data-line="0"]').text()).toContain("整行");
    expect(w.find('[data-test="live-line"]').exists()).toBe(false);
  });
});
