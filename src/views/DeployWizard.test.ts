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
vi.mock("@/api/config", () => ({
  getConfig: vi.fn(async () => CONFIG),
  setConfig: vi.fn(async (p: unknown) => p),
}));
vi.mock("@/api/favorites", () => ({
  listFavorites: vi.fn(async () => []),
  saveFavorite: vi.fn(async (f: unknown) => f),
  deleteFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));

import * as api from "@/api/deploy";
import * as favApi from "@/api/favorites";
import * as configApi from "@/api/config";
import DeployWizard from "./DeployWizard.vue";
import SearchSelect from "@/components/common/SearchSelect.vue";
import { useSettingsStore } from "@/stores/settings";

/** 与 config.ts 的 AppConfig 同形；下面的用例只关心 lastDeployType / lastEnvId */
const CONFIG: configApi.AppConfig = {
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
};

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

/**
 * 分支与 commit 都是可搜索下拉，按渲染顺序取：第 1 个是分支，第 2 个是 commit。
 * （项目仍是按钮，所以直接用文本找按钮即可）
 */
function branchSelect(w: ReturnType<typeof mount>) {
  return w.findAllComponents(SearchSelect)[0];
}
function commitSelect(w: ReturnType<typeof mount>) {
  return w.findAllComponents(SearchSelect)[1];
}

async function pickBranch(w: ReturnType<typeof mount>, name: string): Promise<void> {
  branchSelect(w).vm.$emit("update:modelValue", name);
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
    const select = commitSelect(w);
    expect(select.exists()).toBe(true);
    expect(select.props("options")).toHaveLength(2);
    expect(select.props("options")[0]).toMatchObject({ label: "a1b2c3d4 修复播放页黑屏" });
  });

  it("分支用可搜索下拉（可输入筛选），项目仍保持按钮样式", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");

    const branch = branchSelect(w);
    expect(branch.exists()).toBe(true);
    expect(branch.props("options")).toEqual([
      { value: "main", label: "main" },
      { value: "dev", label: "dev" },
    ]);
    // 分支不再是按钮，项目仍是按钮
    expect(w.findAll("button").some((b) => b.text() === "dev")).toBe(false);
    expect(w.findAll("button").some((b) => b.text() === "proj-AAA")).toBe(true);
  });

  it("选了分支才拉 commit", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    expect(vi.mocked(api.fetchCommits)).not.toHaveBeenCalled();

    await pickBranch(w, "dev");
    expect(vi.mocked(api.fetchCommits)).toHaveBeenCalledWith("proj-AAA", "dev");
  });

  it("选了 commit 才能提交部署", async () => {
    const w = await mountWizard();
    await pickProject(w, "proj-AAA");
    await pickBranch(w, "main");
    await commitSelect(w).vm.$emit("update:modelValue", "e5f6a7b8#-----#新增榜单入口");
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

describe("DeployWizard 记住上次的选择", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("打开向导时预填上次用的部署类型与环境，并直接拉项目", async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    const settings = useSettingsStore();
    settings.loaded = true;
    settings.lastDeployType = "docker";
    settings.lastEnvId = 2; // 正式环境

    const w = mount(DeployWizard, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();

    // 环境按钮高亮（EnvPicker 用 border-primary 表示选中）
    const highlighted = w.findAll("button").filter((b) => b.classes().includes("border-primary"));
    expect(highlighted.some((b) => b.text() === "正式环境")).toBe(true);

    // 类型 + 环境都恢复了；而且**恢复出来的环境也要拉项目列表**
    // （旧实现只在用户点击时才拉，会出现"选中了环境但项目是空的"）
    expect(vi.mocked(api.fetchProjects)).toHaveBeenCalledWith("docker", 2);
  });

  it("用户改了选择就写回配置，供下次预填", async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    await useSettingsStore().load(); // 真实启动流程：App.vue 先 load() 再让用户操作

    const w = mount(DeployWizard, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    const envButton = w.findAll("button").find((b) => b.text() === "测试环境");
    await envButton!.trigger("click");
    await flushPromises();

    const calls = vi.mocked(configApi.setConfig).mock.calls;
    const sent = calls[calls.length - 1]?.[0];
    expect(sent).toMatchObject({ lastEnvId: 1, lastDeployType: "auto" });

    // 再换成 docker 也要写回
    const docker = w.findAll("button").find((b) => b.text() === "Docker 部署");
    await docker!.trigger("click");
    await flushPromises();
    const after = vi.mocked(configApi.setConfig).mock.calls;
    expect(after[after.length - 1]?.[0]).toMatchObject({
      lastDeployType: "docker",
      lastEnvId: 1,
    });
  });

  it("设置还没加载完就不写回（避免把其余字段写成默认值）", async () => {
    pinia = createPinia();
    setActivePinia(pinia);
    useSettingsStore().loaded = false; // load() 尚未完成

    const w = mount(DeployWizard, { global: { plugins: [pinia] }, attachTo: document.body });
    await flushPromises();
    const envButton = w.findAll("button").find((b) => b.text() === "测试环境");
    await envButton!.trigger("click");
    await flushPromises();

    expect(vi.mocked(configApi.setConfig)).not.toHaveBeenCalled();
  });
});
