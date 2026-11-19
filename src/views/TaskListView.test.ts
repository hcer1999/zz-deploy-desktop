import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import type { DeployTask } from "@/api/parser";

vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchTaskList: vi.fn(async () => ({
    tasks: [],
    pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    currentUser: "",
    envs: [],
  })),
  submitRebuild: vi.fn(async () => true),
  submitOnline: vi.fn(async () => true),
  submitRollback: vi.fn(async () => true),
  deleteTask: vi.fn(async () => true),
}));

vi.mock("@/api/log", () => ({
  logOpen: vi.fn(async () => "s1"),
  logClose: vi.fn(async () => {}),
}));

import * as api from "@/api/deploy";
import TaskListView from "./TaskListView.vue";
import { useTasksStore } from "@/stores/tasks";

let pinia: Pinia;

function task(id: number, buildStatus: string, over: Partial<DeployTask> = {}): DeployTask {
  return {
    taskId: id,
    title: `任务${id}`,
    projectName: "zz-x",
    envName: "测试环境",
    cluster: "",
    deployType: "",
    branch: "main",
    version: "abcdef1234",
    onlineStatus: "未上线",
    buildStatus,
    submitTime: "2026-10-15 10:00:00",
    submitter: "zhangsan",
    canUp: false,
    canRoll: false,
    canDelete: false,
    ...over,
  };
}

async function mountList(rows: DeployTask[]): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(TaskListView, { global: { plugins: [pinia] }, attachTo: document.body });
  await flushPromises();
  // 挂载时 refresh() 会被 mock 覆盖成空列表，这里再放测试数据
  useTasksStore().tasks = rows;
  await flushPromises();
  return w;
}

/** 确认框的确认按钮：它渲染在 body 末尾，取最后一个同名按钮 */
async function confirmDialog(text: string): Promise<void> {
  const buttons = Array.from(document.querySelectorAll("button")).filter(
    (b) => b.textContent?.trim() === text,
  );
  buttons[buttons.length - 1]!.click();
  await flushPromises();
}

describe("TaskListView 重新构建入口", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("只有构建失败的任务才显示「重新构建」", async () => {
    const w = await mountList([
      task(1, "构建失败"),
      task(2, "构建成功"),
      task(3, "构建中"),
    ]);

    const rows = w.findAll("tbody tr");
    const hasRebuild = rows.map((r) => r.find('[data-test="rebuild"]').exists());
    expect(hasRebuild).toEqual([true, false, false]);
  });

  it("点击后确认，调用 /rebuild/ 对应的接口并刷新列表", async () => {
    const w = await mountList([task(9, "构建失败")]);
    const refreshesBefore = vi.mocked(api.fetchTaskList).mock.calls.length;

    await w.find('[data-test="rebuild"]').trigger("click");
    await flushPromises();
    await confirmDialog("重新构建");

    expect(vi.mocked(api.submitRebuild)).toHaveBeenCalledWith("auto", 9);
    // 触发后要刷新，否则列表上还显示着旧的失败状态
    expect(vi.mocked(api.fetchTaskList).mock.calls.length).toBe(refreshesBefore + 1);
    expect(w.text()).toContain("已触发重新构建");
  });

  it("失败时提示而不是假装成功", async () => {
    vi.mocked(api.submitRebuild).mockResolvedValueOnce(false);
    const w = await mountList([task(9, "构建失败")]);

    await w.find('[data-test="rebuild"]').trigger("click");
    await flushPromises();
    await confirmDialog("重新构建");

    expect(w.text()).toContain("操作失败，请重试");
  });
});

describe("TaskListView 环境筛选", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  const ENVS = [
    { id: 1, name: "测试环境" },
    { id: 2, name: "正式环境" },
  ];

  async function mountWithEnvs(rows: DeployTask[] = []): Promise<ReturnType<typeof mount>> {
    const w = await mountList(rows);
    const s = useTasksStore();
    s.envsByType.auto = ENVS;
    await flushPromises();
    return w;
  }

  it("下拉列出「全部环境」+ 服务端返回的环境目录", async () => {
    const w = await mountWithEnvs();
    const options = w.findAll('[data-test="env-filter"] option').map((o) => o.text());
    expect(options).toEqual(["全部环境", "测试环境", "正式环境"]);
  });

  it("选择环境后回到第 1 页并带上 envId", async () => {
    const w = await mountWithEnvs();
    await w.find('[data-test="env-filter"]').setValue("2");
    await flushPromises();
    expect(useTasksStore().envId).toBe(2);
    expect(api.fetchTaskList).toHaveBeenLastCalledWith("auto", 1, {
      search: "",
      envId: 2,
    });
  });

  it("有筛选条件时显示小结与清除按钮", async () => {
    const w = await mountWithEnvs();
    const s = useTasksStore();
    s.search = "zz-pay";
    s.envId = 2;
    await flushPromises();

    const summary = w.find('[data-test="filter-summary"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("正式环境");
    expect(summary.text()).toContain("zz-pay");

    await summary.find('[data-test="clear-filters"]').trigger("click");
    await flushPromises();
    expect(s.envId).toBe(0);
    expect(s.search).toBe("");
  });

  it("空结果按「有没有筛选」给不同文案", async () => {
    const w = await mountWithEnvs();
    const s = useTasksStore();
    await flushPromises();
    expect(w.text()).toContain("暂无数据");

    s.search = "zz-pay";
    await flushPromises();
    expect(w.text()).toContain("没有符合条件的任务");
  });
});
