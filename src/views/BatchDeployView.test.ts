import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchProjects: vi.fn(async (_type: string, env: number) =>
    env === 1
      ? [
          { id: 7, name: "proj-AAA" },
          { id: 8, name: "proj-BBB" },
        ]
      : [{ id: 70, name: "proj-PROD" }],
  ),
  // AAA 只有 origin/master；BBB 只有 origin/dev（用来验证"各项分支互不影响"）
  fetchBranches: vi.fn(async (_type: string, projectId: number) =>
    projectId === 7 ? ["origin/master"] : ["origin/dev"],
  ),
  fetchCommits: vi.fn(async (projectName: string, branch: string) => [
    {
      hash: `${projectName}-${branch}-aaaa`,
      message: "第一个提交",
      fullString: `${projectName}-${branch}-aaaa#-----#第一个提交`,
    },
    {
      hash: `${projectName}-${branch}-bbbb`,
      message: "第二个提交",
      fullString: `${projectName}-${branch}-bbbb#-----#第二个提交`,
    },
  ]),
  fetchTaskList: vi.fn(async () => ({
    tasks: [{ taskId: 500 }],
    pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    currentUser: "zhangsan",
  })),
  submitDeploy: vi.fn(async () => true),
  submitOnline: vi.fn(async () => true),
}));

vi.mock("@/api/batchFavorites", () => {
  // 服务端行为：同名覆盖、否则按 id 覆盖、再否则新增
  const items: {
    id: string;
    name: string;
    items: {
      deployType: string;
      envId: number;
      envName: string;
      projectId: number;
      projectName: string;
      branch: string;
    }[];
  }[] = [];
  return {
    listBatchFavorites: vi.fn(async () => items.map((i) => ({ ...i }))),
    saveBatchFavorite: vi.fn(async (fav: (typeof items)[number]) => {
      const byId = fav.id ? items.findIndex((i) => i.id === fav.id) : -1;
      const byName = items.findIndex((i) => i.name === fav.name);
      const idx = byId >= 0 ? byId : byName;
      if (idx >= 0) {
        items[idx] = { ...fav, id: items[idx].id };
        return { ...items[idx] };
      }
      const saved = { ...fav, id: `fav-${items.length + 1}` };
      items.push(saved);
      return { ...saved };
    }),
    deleteBatchFavorite: vi.fn(async (id: string) => {
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
    }),
    __items: items,
  };
});

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn(),
  onAction: vi.fn(async () => ({ unlisten: () => {} })),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ isFocused: async () => false }),
}));
vi.mock("@/api/config", () => ({
  getConfig: vi.fn(async () => ({
    baseUrl: "https://itsm.zhizhengroup.com",
    theme: "system",
    username: "zhangsan",
    closeBehavior: "tray",
    pollIntervalSecs: 60,
    logRetentionDays: 30,
    logRetentionEntries: 500,
    notifyMode: "always",
    sidebarExpanded: false,
    lastDeployType: "auto",
    lastEnvId: null,
  })),
  setConfig: vi.fn(async (p: unknown) => p),
}));

import * as api from "@/api/deploy";
import * as favApi from "@/api/batchFavorites";
import BatchDeployView from "./BatchDeployView.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";
import { useBatchStore } from "@/stores/batch";
import { useBatchFavoritesStore } from "@/stores/batchFavorites";
import { useTabsStore } from "@/stores/tabs";

let pinia: Pinia;

async function mountView(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(BatchDeployView, { global: { plugins: [pinia] }, attachTo: document.body });
  await flushPromises();
  return w;
}

async function pickEnv(w: ReturnType<typeof mount>, name: string): Promise<void> {
  const btn = w.findAll("button").find((b) => b.text() === name);
  await btn!.trigger("click");
  await flushPromises();
}

async function pickProject(w: ReturnType<typeof mount>, id: number): Promise<void> {
  await w.find(`[data-test="pick-${id}"]`).trigger("click");
  await flushPromises();
}

async function addToPlan(w: ReturnType<typeof mount>): Promise<void> {
  await w.find('[data-test="add-to-plan"]').trigger("click");
  await flushPromises();
}

/** 弹窗内容 portal 到 body，w.find 看不到；直接查 document 并派发 input */
async function setDialogInput(selector: string, value: string): Promise<void> {
  const el = document.querySelector(selector) as HTMLInputElement | null;
  if (!el) throw new Error(`找不到弹窗输入框：${selector}`);
  el.value = value;
  el.dispatchEvent(new Event("input"));
  await flushPromises();
}

async function clickDialogButton(text: string): Promise<void> {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === text,
  );
  if (!buttons.length) throw new Error(`弹窗里没有按钮：${text}`);
  buttons[buttons.length - 1]!.click();
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
}

function planRows(w: ReturnType<typeof mount>) {
  return w.findAll('[data-test="plan-item"]');
}

describe("BatchDeployView 批量计划", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("选中项目加入计划：默认带上该项目的分支与最新 commit", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);

    expect(planRows(w)).toHaveLength(1);
    console.log("SELECTS:", w.findAllComponents(SearchSelect).map((c) => String(c.props("modelValue"))));
    expect(planRows(w)).toHaveLength(1);
    expect(w.text()).toContain("proj-AAA");
    expect(w.text()).toContain("测试环境");
    // 分支/commit 都补好了（commit 默认最新一条）
    expect(vi.mocked(api.fetchBranches)).toHaveBeenCalledWith("auto", 7);
    expect(vi.mocked(api.fetchCommits)).toHaveBeenCalledWith("proj-AAA", "origin/master");
    const commits = w.findAllComponents(SearchSelect);
    expect(commits.some((c) => String(c.props("modelValue")).includes("aaaa"))).toBe(true);
  });

  it("同一项目重复加入 = 更新那一项（不产生第二项）", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    await pickProject(w, 7);
    await addToPlan(w);

    expect(planRows(w)).toHaveLength(1);
    expect(w.text()).toContain("已更新计划里的");
  });

  it("可以跨环境、跨项目、跨分支地攒计划", async () => {
    const w = await mountView();
    // 测试环境的 AAA
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    // 测试环境的 BBB（分支不同：origin/dev）
    await pickProject(w, 8);
    await addToPlan(w);
    // 正式环境的另一个项目
    await pickEnv(w, "正式环境");
    await pickProject(w, 70);
    await addToPlan(w);

    expect(planRows(w)).toHaveLength(3);
    expect(w.text()).toContain("跨 2 个环境");
    expect(vi.mocked(api.fetchBranches)).toHaveBeenCalledWith("auto", 8);
    expect(vi.mocked(api.fetchBranches)).toHaveBeenCalledWith("auto", 70);
  });

  it("可以从计划里移除某一项", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    await pickProject(w, 8);
    await addToPlan(w);
    expect(planRows(w)).toHaveLength(2);

    await w.findAll('[data-test="remove-item"]')[0].trigger("click");
    await flushPromises();

    expect(planRows(w)).toHaveLength(1);
    // 注意：左边项目选择器里当然还有 proj-AAA，所以只断言"计划清单里"
    expect(planRows(w)[0].text()).toContain("proj-BBB");
    expect(planRows(w)[0].text()).not.toContain("proj-AAA");
  });

  it("提交时逐项按自己的类型/环境提交，并把计划交给批次跟踪", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    await pickEnv(w, "正式环境");
    await pickProject(w, 70);
    await addToPlan(w);

    await w.find('[data-test="batch-submit"]').trigger("click");
    await flushPromises();
    await clickDialogButton("提交 2 个");

    expect(vi.mocked(api.submitDeploy)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.submitDeploy)).toHaveBeenNthCalledWith(1, "auto", 7, {
      title: "",
      branchtag: "origin/master",
      version: "proj-AAA-origin/master-aaaa#-----#第一个提交",
    });
    expect(vi.mocked(api.submitDeploy)).toHaveBeenNthCalledWith(2, "auto", 70, {
      title: "",
      branchtag: "origin/dev",
      version: "proj-PROD-origin/dev-aaaa#-----#第一个提交",
    });

    const run = useBatchStore().active()[0];
    expect(run.items.map((i) => i.projectId)).toEqual([7, 70]);
    expect(run.baselines.auto).toBe(500);
    // 提交成功的项从计划里摘掉
    expect(planRows(w)).toHaveLength(0);
    expect(useTabsStore().activeTab?.kind).toBe("list");
    useBatchStore().stopWatching();
  });

  it("部分项提交失败时留在计划里，方便重试", async () => {
    vi.mocked(api.submitDeploy).mockImplementation(async (_t, projectId) => projectId !== 8);
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    await pickProject(w, 8);
    await addToPlan(w);

    await w.find('[data-test="batch-submit"]').trigger("click");
    await flushPromises();
    await clickDialogButton("提交 2 个");

    expect(planRows(w)).toHaveLength(1);
    expect(w.text()).toContain("提交失败，请重试");
    expect(useBatchStore().active()[0].items.map((i) => i.projectId)).toEqual([7]);
    useBatchStore().stopWatching();
  });

  it("自动上线开关默认关，开启后给出醒目警告并写进批次", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);

    expect(w.find('[data-test="auto-online-warning"]').exists()).toBe(false);
    await w.find('[data-test="auto-online"]').setValue(true);
    expect(w.find('[data-test="auto-online-warning"]').text()).toContain("一旦构建成功就会立刻上线");

    await w.find('[data-test="batch-submit"]').trigger("click");
    await flushPromises();
    await clickDialogButton("提交 1 个");
    expect(useBatchStore().active()[0].autoOnline).toBe(true);
    useBatchStore().stopWatching();
  });
});

describe("BatchDeployView 批量收藏", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    const mod = (await import("@/api/batchFavorites")) as unknown as { __items: unknown[] };
    mod.__items.length = 0;
  });

  const FAV: favApi.BatchFavorite = {
    id: "fav-1",
    name: "发版",
    items: [
      {
        deployType: "auto",
        envId: 1,
        envName: "测试环境",
        projectId: 7,
        projectName: "proj-AAA",
        branch: "origin/master",
      },
      {
        deployType: "auto",
        envId: 2,
        envName: "正式环境",
        projectId: 70,
        projectName: "proj-PROD",
        branch: "origin/dev",
      },
    ],
  };

  async function mountWith(items: favApi.BatchFavorite[]): Promise<ReturnType<typeof mount>> {
    const mod = (await import("@/api/batchFavorites")) as unknown as { __items: unknown[] };
    mod.__items.length = 0;
    for (const it of items) mod.__items.push(JSON.parse(JSON.stringify(it)));
    return mountView();
  }

  it("保存：只记类型/环境/项目/分支，不记 commit 与自动上线开关", async () => {
    const w = await mountView();
    await pickEnv(w, "测试环境");
    await pickProject(w, 7);
    await addToPlan(w);
    await pickEnv(w, "正式环境");
    await pickProject(w, 70);
    await addToPlan(w);

    await w.find('[data-test="save-fav"]').trigger("click");
    await flushPromises();
    await setDialogInput('[data-test="fav-name"]', "发版");
    await clickDialogButton("保存");

    const calls = vi.mocked(favApi.saveBatchFavorite).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0].items).toEqual([
      {
        deployType: "auto",
        envId: 1,
        envName: "测试环境",
        projectId: 7,
        projectName: "proj-AAA",
        branch: "origin/master",
      },
      {
        deployType: "auto",
        envId: 2,
        envName: "正式环境",
        projectId: 70,
        projectName: "proj-PROD",
        branch: "origin/dev",
      },
    ]);
    expect(calls[0][0]).not.toHaveProperty("autoOnline");
    expect(JSON.stringify(calls[0][0])).not.toContain("#-----#");
  });

  it("载入：替换右侧清单，并逐项补上分支与 commit", async () => {
    const w = await mountWith([FAV]);
    await w.find('[data-test="load-fav"]').trigger("click");
    await flushPromises();

    expect(planRows(w)).toHaveLength(2);
    expect(w.text()).toContain("proj-AAA");
    expect(w.text()).toContain("proj-PROD");
    expect(w.text()).toContain("跨 2 个环境");
    expect(vi.mocked(api.fetchCommits)).toHaveBeenCalledWith("proj-AAA", "origin/master");
    expect(vi.mocked(api.fetchCommits)).toHaveBeenCalledWith("proj-PROD", "origin/dev");
  });

  it("修改：改名后「保存修改」覆盖同一条，不新增", async () => {
    const w = await mountWith([FAV]);
    await w.find('[data-test="load-fav"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="save-fav"]').trigger("click");
    await flushPromises();
    expect((document.querySelector('[data-test="fav-name"]') as HTMLInputElement).value).toBe("发版");
    await setDialogInput('[data-test="fav-name"]', "发版（改）");
    await clickDialogButton("保存修改");

    const store = useBatchFavoritesStore();
    expect(store.items).toHaveLength(1);
    expect(store.items[0].name).toBe("发版（改）");
    expect(store.items[0].id).toBe("fav-1");
  });

  it("「另存为新收藏」不覆盖原收藏", async () => {
    const w = await mountWith([FAV]);
    await w.find('[data-test="load-fav"]').trigger("click");
    await flushPromises();

    await w.find('[data-test="save-fav"]').trigger("click");
    await flushPromises();
    await setDialogInput('[data-test="fav-name"]', "发版（另一套）");
    await clickDialogButton("另存为新收藏");

    expect(useBatchFavoritesStore().items.map((f) => f.name)).toEqual(["发版", "发版（另一套）"]);
  });

  it("删除收藏要二次确认", async () => {
    const w = await mountWith([FAV]);
    await w.find('[data-test="delete-fav"]').trigger("click");
    await flushPromises();
    await clickDialogButton("删除");

    expect(vi.mocked(favApi.deleteBatchFavorite)).toHaveBeenCalledWith("fav-1");
    expect(useBatchFavoritesStore().items).toHaveLength(0);
  });
});
