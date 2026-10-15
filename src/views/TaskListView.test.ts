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
