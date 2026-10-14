import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchProjects: vi.fn(async () => [
    { id: 7, name: "proj-AAA" },
    { id: 8, name: "proj-BBB" },
  ]),
  fetchBranches: vi.fn(async () => ["main", "dev"]),
  fetchCommits: vi.fn(async () => [
    { hash: "a1b2c3d4", message: "修复播放页黑屏", fullString: "a1b2c3d4#-----#修复播放页黑屏" },
    { hash: "e5f6a7b8", message: "新增榜单入口", fullString: "e5f6a7b8#-----#新增榜单入口" },
  ]),
  submitDeploy: vi.fn(async () => true),
}));
vi.mock("@/api/favorites", () => ({
  listFavorites: vi.fn(async () => []),
  saveFavorite: vi.fn(async (f: unknown) => f),
  deleteFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));

import * as api from "@/api/deploy";
import * as favApi from "@/api/favorites";
import DeployWizard from "./DeployWizard.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";

let pinia: Pinia;

async function mountWizard(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(DeployWizard, { global: { plugins: [pinia] }, attachTo: document.body });
  // 选环境（1 = 测试环境）→ 拉项目
  const envButton = w
    .findAll("button")
    .find((b) => b.text().includes("测试环境") && !b.text().includes("2"));
  await envButton!.trigger("click");
  await flushPromises();
  return w;
}

async function pickProject(w: ReturnType<typeof mount>, name: string): Promise<void> {
  const btn = w.findAll("button").find((b) => b.text() === name);
  await btn!.trigger("click");
  await flushPromises();
}

async function pickBranch(w: ReturnType<typeof mount>, name: string): Promise<void> {
  const btn = w.findAll("button").find((b) => b.text() === name);
  await btn!.trigger("click");
  await flushPromises();
}

/** 点确认框里的「收藏」按钮 */
async function confirmFavorite(): Promise<void> {
  const buttons = Array.from(document.querySelectorAll("button"));
  const ok = buttons.find((b) => b.textContent?.trim() === "收藏");
  ok!.click();
  await flushPromises();
  await new Promise((r) => setTimeout(r, 0));
}

describe("DeployWizard 收藏粒度", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("没选项目时没有收藏入口", async () => {
    const w = await mountWizard();
    expect(w.find('[data-test="fav-project"]').exists()).toBe(false);
    expect(w.find('[data-test="fav-branch"]').exists()).toBe(false);
  });

  it("选中项目后即可收藏「项目级」：type=project，不带分支", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");

    expect(w.find('[data-test="fav-project"]').exists()).toBe(true);
    await w.find('[data-test="fav-project"]').trigger("click");
    await flushPromises();
    await confirmFavorite();

    const payload = vi.mocked(favApi.saveFavorite).mock.calls[0][0];
    expect(payload).toMatchObject({ type: "project", projectId: 7, projectName: "proj-AAA" });
    expect(payload.branch).toBeUndefined();
  });

  it("选中分支后可收藏「分支级」：type=config + branch，不必选 commit", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    await pickBranch(w, "dev");

    await w.find('[data-test="fav-branch"]').trigger("click");
    await flushPromises();
    await confirmFavorite();

    const payload = vi.mocked(favApi.saveFavorite).mock.calls[0][0];
    expect(payload).toMatchObject({ type: "config", branch: "dev", projectId: 7 });
  });

  it("未选 commit 也能收藏（旧实现必须选到 commit）", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    await pickBranch(w, "main");
    // 故意不选 commit
    expect(w.find('[data-test="fav-branch"]').exists()).toBe(true);
    await w.find('[data-test="fav-branch"]').trigger("click");
    await flushPromises();
    await confirmFavorite();
    expect(vi.mocked(favApi.saveFavorite)).toHaveBeenCalledTimes(1);
  });

  it("commit 用可搜索下拉渲染，不再是原生 select", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    await pickBranch(w, "main");

    expect(w.find("select").exists()).toBe(false);
    const select = w.findComponent(SearchSelect);
    expect(select.exists()).toBe(true);
    expect(select.props("options")).toHaveLength(2);
    expect(select.props("options")[0]).toMatchObject({ label: "a1b2c3d4 修复播放页黑屏" });
  });

  it("选了 commit 才能提交部署", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    await pickBranch(w, "main");
    const commitSelect = w.findComponent(SearchSelect);
    await commitSelect.vm.$emit("update:modelValue", "e5f6a7b8#-----#新增榜单入口");
    await flushPromises();

    const submit = w.findAll("button").find((b) => b.text().includes("确认提交部署"));
    expect(submit).toBeTruthy();
    await submit!.trigger("click");
    await flushPromises();
    const confirm = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "提交",
    );
    confirm!.click();
    await flushPromises();
    await new Promise((r) => setTimeout(r, 0));

    expect(vi.mocked(api.submitDeploy)).toHaveBeenCalledWith("auto", 7, {
      title: "",
      branchtag: "main",
      version: "e5f6a7b8#-----#新增榜单入口",
    });
  });
});
