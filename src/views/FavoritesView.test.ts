import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/favorites", async () => {
  const favs = [
    {
      id: "1",
      type: "project",
      deployType: "auto",
      envId: 1,
      envName: "测试环境",
      projectId: 1,
      projectName: "proj-AAA",
      note: "先找产品确认",
      tags: ["线上"],
    },
    {
      id: "2",
      type: "config",
      deployType: "auto",
      envId: 2,
      envName: "正式环境",
      projectId: 2,
      projectName: "proj-BBB",
      branch: "main",
      tags: ["线上", "紧急"],
    },
  ];
  return {
    // 每次返回副本：store 会原地替换 items 里的元素，直接给同一个数组会跨用例污染
    listFavorites: vi.fn(async () => favs.map((f) => ({ ...f }))),
    saveFavorite: vi.fn(),
    deleteFavorite: vi.fn(),
    reorderFavorites: vi.fn(),
    favoritesMetaSet: vi.fn(async (id: string, note: string, tags: string[]) => ({
      ...favs.find((f) => f.id === id)!,
      note,
      tags,
    })),
  };
});

vi.mock("@/api/tags", () => ({
  listTags: vi.fn(async () => [
    { name: "线上", color: "#f87171" },
    { name: "紧急", color: "#fbbf24" },
  ]),
  upsertTag: vi.fn(async () => []),
  deleteTag: vi.fn(async () => []),
}));
vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchBranches: vi.fn(async () => ["main", "dev", "feature/x"]),
  fetchCommits: vi.fn(async (_p: string, branch: string) => [
    {
      hash: branch === "main" ? "a1b2c3d4" : "bbbbbbbb",
      message: branch === "main" ? "主干提交" : "分支提交",
      fullString: branch === "main" ? "a1b2c3d4#-----#主干提交" : "bbbbbbbb#-----#分支提交",
    },
  ]),
  submitDeploy: vi.fn(async () => true),
  fetchTaskList: vi.fn(async () => ({
    tasks: [{ taskId: 900 }],
    pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    currentUser: "zhangsan",
    envs: [],
  })),
}));

import * as deployApi from "@/api/deploy";
import * as favApi from "@/api/favorites";
import FavoritesView from "./FavoritesView.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";
import { VueDraggable } from "vue-draggable-plus";
import { useFavoritesStore } from "@/stores/favorites";
import { useBatchStore } from "@/stores/batch";

let pinia: Pinia;
let mounted: ReturnType<typeof mount>[] = [];

async function mountView(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  await useFavoritesStore().load();
  const w = mount(FavoritesView, { global: { plugins: [pinia] }, attachTo: document.body });
  mounted.push(w);
  await flushPromises();
  return w;
}

/** 展开第 index 个收藏项 */
async function expand(w: ReturnType<typeof mount>, index: number): Promise<void> {
  const rows = w.findAll("button");
  const toggleBtn = rows.find((b) => b.text().includes("快速部署"));
  const allToggles = w
    .findAll("button")
    .filter((b) => b.text().includes("快速部署") || b.text().includes("收起"));
  await (index === 0 ? toggleBtn! : allToggles[1]).trigger("click");
  await flushPromises();
}

function branchSelect(w: ReturnType<typeof mount>): ReturnType<typeof mount> {
  // 展开区里的第 1 个 SearchSelect 是分支，第 2 个是 commit
  return w.findAllComponents(SearchSelect)[0];
}
function commitSelect(w: ReturnType<typeof mount>): ReturnType<typeof mount> {
  return w.findAllComponents(SearchSelect)[1];
}
/** 下拉当前显示的值（未聚焦时就是选中项的 label） */
function shownValue(sel: ReturnType<typeof mount>): string {
  return (sel.find("input").element as HTMLInputElement).value;
}
function isDisabled(sel: ReturnType<typeof mount>): boolean {
  return (sel.find("input").element as HTMLInputElement).disabled;
}

async function submit(w: ReturnType<typeof mount>): Promise<void> {
  const btn = w.findAll("button").find((b) => b.text().includes("提交部署"));
  await btn!.trigger("click");
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
}

describe("FavoritesView 部署（分支可改）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("行内标签区分两种粒度", async () => {
    const w = await mountView();
    expect(w.text()).toContain("仅项目");
    expect(w.text()).toContain("项目+分支");
  });

  it("项目级收藏：展开就拉分支列表，但还不会拉 commit", async () => {
    const w = await mountView();
    await expand(w, 0);
    expect(deployApi.fetchBranches).toHaveBeenCalledWith("auto", 1);
    expect(deployApi.fetchCommits).not.toHaveBeenCalled();
  });

  it("项目级收藏：选完分支才拉 commit，并默认选中最新一条", async () => {
    const w = await mountView();
    await expand(w, 0);
    branchSelect(w).vm.$emit("update:modelValue", "dev");
    await flushPromises();

    expect(deployApi.fetchCommits).toHaveBeenCalledWith("proj-AAA", "dev");
    expect(shownValue(commitSelect(w))).toContain("分支提交");
  });

  it("分支级收藏：预选记忆的分支并直接拉 commit，但仍可改成别的分支", async () => {
    const w = await mountView();
    await expand(w, 1);

    expect(shownValue(branchSelect(w))).toBe("main");
    expect(deployApi.fetchCommits).toHaveBeenLastCalledWith("proj-BBB", "main");

    // 改分支 → 重拉 commit，且旧的 commit 被清掉后换成新分支的最新一条
    branchSelect(w).vm.$emit("update:modelValue", "feature/x");
    await flushPromises();

    expect(deployApi.fetchCommits).toHaveBeenLastCalledWith("proj-BBB", "feature/x");
    expect(deployApi.fetchCommits).toHaveBeenCalledTimes(2);
    expect(shownValue(commitSelect(w))).toContain("分支提交");
  });

  it("提交用当前选中的分支与 commit，且不改动收藏本身", async () => {
    const w = await mountView();
    await expand(w, 1);
    branchSelect(w).vm.$emit("update:modelValue", "dev");
    await flushPromises();
    await submit(w);

    expect(deployApi.submitDeploy).toHaveBeenCalledWith("auto", 2, {
      title: "",
      branchtag: "dev",
      version: "bbbbbbbb#-----#分支提交",
    });
    // 只是本次覆盖，不应悄悄改掉收藏记录
    expect(favApi.saveFavorite).not.toHaveBeenCalled();
  });

  it("commit 用可搜索下拉，不再是原生 select", async () => {
    const w = await mountView();
    await expand(w, 1);
    expect(w.find("select").exists()).toBe(false);
    expect(commitSelect(w).exists()).toBe(true);
    expect(shownValue(commitSelect(w))).toContain("主干提交");
  });

  it("没选分支时 commit 下拉禁用", async () => {
    const w = await mountView();
    await expand(w, 0);
    expect(isDisabled(commitSelect(w))).toBe(true);
  });

  it("拖动排序仍启用 force-fallback（回归）", async () => {
    const w = await mountView();
    expect(w.findComponent(VueDraggable).props("forceFallback")).toBe(true);
  });
});

describe("FavoritesView 筛选", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  function filterBox(w: ReturnType<typeof mount>) {
    return w.find('[data-test="fav-filter"]');
  }

  it("不筛选时不显示计数", async () => {
    const w = await mountView();
    expect(w.text()).not.toContain("匹配");
    expect(w.text()).toContain("proj-AAA");
    expect(w.text()).toContain("proj-BBB");
  });

  it("按项目名筛选，并显示匹配计数", async () => {
    const w = await mountView();
    await filterBox(w).setValue("BBB");

    expect(w.text()).toContain("匹配 1 / 共 2");
    expect(w.text()).toContain("proj-BBB");
    expect(w.text()).not.toContain("proj-AAA");
  });

  it("也能按环境与分支筛", async () => {
    const w = await mountView();
    await filterBox(w).setValue("正式");
    expect(w.text()).toContain("proj-BBB");
    expect(w.text()).not.toContain("proj-AAA");

    await filterBox(w).setValue("main");
    expect(w.text()).toContain("proj-BBB");
    expect(w.text()).not.toContain("proj-AAA");
  });

  it("有收藏但无匹配时给空态提示", async () => {
    const w = await mountView();
    await filterBox(w).setValue("不存在的项目");
    expect(w.text()).toContain("没有匹配的收藏");
    expect(w.findComponent(VueDraggable).exists()).toBe(false);
  });

  it("筛选状态下禁用拖动排序，清空后恢复", async () => {
    const w = await mountView();
    expect(w.findComponent(VueDraggable).props("disabled")).toBe(false);

    await filterBox(w).setValue("AAA");
    expect(w.findComponent(VueDraggable).props("disabled")).toBe(true);

    await filterBox(w).setValue("");
    expect(w.findComponent(VueDraggable).props("disabled")).toBe(false);
    expect(w.text()).toContain("proj-BBB");
  });

  // 拖动组件靠 emit('update:modelValue') 写回顺序。本轮 v-model 从 store 数组换成了
  // computed（为了支持筛选），这两条盯住新写回通道：不筛选时写进 store，筛选时挡住。
  it("不筛选时拖动写回会落到 store（v-model 改 computed 后仍生效）", async () => {
    const w = await mountView();
    const store = useFavoritesStore();

    w.findComponent(VueDraggable).vm.$emit("update:modelValue", [store.items[1], store.items[0]]);
    await flushPromises();

    expect(store.items.map((f) => f.id)).toEqual(["2", "1"]);
  });

  it("筛选时即使收到拖动写回也不改 store（setter 里的双保险）", async () => {
    const w = await mountView();
    await filterBox(w).setValue("AAA");
    const store = useFavoritesStore();

    w.findComponent(VueDraggable).vm.$emit("update:modelValue", []);
    await flushPromises();

    expect(store.items.map((f) => f.id)).toEqual(["1", "2"]);
  });
});

describe("收藏快速部署的自动上线", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("勾选后提交：以 single 批次跟踪，每次展开默认都是关的", async () => {
    const w = await mountView();
    // 第 2 条（正式环境 / main）才有分支与 commit，可以直接提交
    await expand(w, 1);
    const checkbox = w.find('[data-test="auto-online-single"]');
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
    await checkbox.setValue(true);
    expect(w.find('[data-test="auto-online-warning"]').exists()).toBe(true);

    await w.findAll("button").find((b) => b.text().includes("提交部署"))!.trigger("click");
    await flushPromises();

    const batches = useBatchStore();
    expect(batches.runs).toHaveLength(1);
    expect(batches.runs[0].kind).toBe("single");
    expect(batches.runs[0].baselines.auto).toBe(900);
    expect(batches.runs[0].items[0]).toMatchObject({
      projectId: 2,
      projectName: "proj-BBB",
      branch: "main",
      envName: "正式环境",
    });
    batches.reset();

    // 提交成功后展开项会收起；再次展开时勾选必须回到关闭状态
    await expand(w, 1);
    expect(
      (w.find('[data-test="auto-online-single"]').element as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("不勾选时不创建批次", async () => {
    const w = await mountView();
    await expand(w, 1);
    await w.findAll("button").find((b) => b.text().includes("提交部署"))!.trigger("click");
    await flushPromises();
    expect(useBatchStore().runs).toHaveLength(0);
  });
});

describe("收藏的备注与彩色标签", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("行内展示标签与备注", async () => {
    const w = await mountView();
    expect(w.findAll('[data-test="fav-tag"]').map((x) => x.text())).toEqual([
      "线上",
      "线上",
      "紧急",
    ]);
    expect(w.text()).toContain("先找产品确认");
  });

  it("编辑弹窗带出原值，保存写回 store 与服务端", async () => {
    const w = await mountView();
    await w.findAll('[data-test="edit-meta"]')[0].trigger("click");
    await flushPromises();

    const area = document.querySelector("textarea") as HTMLTextAreaElement;
    expect(area.value).toBe("先找产品确认");
    area.value = "改成周五发";
    area.dispatchEvent(new Event("input"));
    await flushPromises();

    const save = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "保存",
    )!;
    save.click();
    await flushPromises();

    expect(favApi.favoritesMetaSet).toHaveBeenCalledWith("1", "改成周五发", ["线上"]);
    expect(useFavoritesStore().items[0].note).toBe("改成周五发");
  });

  it("标签筛选按 AND 收窄", async () => {
    const w = await mountView();
    const chips = w.findAll('[data-test="tag-chip"]');
    expect(chips.map((c) => c.text())).toEqual(["线上", "紧急"]);

    await chips[0].trigger("click");
    await flushPromises();
    expect(w.findAll('[data-test="fav-tag"]').length).toBe(3);

    await w.findAll('[data-test="tag-chip"]')[1].trigger("click");
    await flushPromises();
    // 只有同时带「线上」「紧急」的那条留下
    expect(w.text()).toContain("proj-BBB");
    expect(w.text()).not.toContain("proj-AAA");
  });

  it("关键词也匹配备注与标签名", async () => {
    const w = await mountView();
    await w.find('[data-test="fav-filter"]').setValue("先找产品");
    await flushPromises();
    expect(w.text()).toContain("proj-AAA");
    expect(w.text()).not.toContain("proj-BBB");
  });
});
