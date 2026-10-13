import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import type { DeployTask } from "@/api/parser";

const sendNotification = vi.fn();
const isFocused = vi.fn(async () => false);

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: (opts: unknown) => sendNotification(opts),
  onAction: vi.fn(async () => ({ unlisten: () => {} })),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: () => isFocused(),
    show: async () => {},
    unminimize: async () => {},
    setFocus: async () => {},
  }),
}));

import { useBuildNotifications } from "./useBuildNotifications";
import { useTasksStore } from "@/stores/tasks";

function task(id: number, buildStatus: string): DeployTask {
  return {
    taskId: id,
    title: `部署 #${id}`,
    projectName: "zz-cy-iptv",
    envName: "测试环境",
    cluster: "",
    deployType: "auto",
    branch: "main",
    version: "abc12345",
    onlineStatus: "未上线",
    buildStatus,
    submitTime: "2026-10-13 10:00:00",
    submitter: "zhangsan",
    canUp: false,
    canRoll: false,
    canDelete: false,
  };
}

/** 通知是发在微任务里的，等一轮宏任务让 permission/焦点查询走完 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe("useBuildNotifications", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendNotification.mockClear();
    isFocused.mockResolvedValue(false);
  });

  it("窗口失焦时，日志流结束会弹一条通知", async () => {
    const tasks = useTasksStore();
    tasks.tasks = [task(1001, "构建成功")];
    const notify = useBuildNotifications();

    notify.onLogFinished(1001);
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ id: 1001, title: "构建成功" });
  });

  it("窗口聚焦时不打扰用户", async () => {
    isFocused.mockResolvedValue(true);
    const tasks = useTasksStore();
    tasks.tasks = [task(1002, "构建成功")];
    const notify = useBuildNotifications();

    notify.onLogFinished(1002);
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("两个触发点命中同一任务时只弹一条", async () => {
    const tasks = useTasksStore();
    // 先让 diff 记下"构建中"
    tasks.tasks = [task(1003, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();
    await nextTick();

    // 触发点 1：日志流结束
    tasks.tasks = [task(1003, "构建成功")];
    notify.onLogFinished(1003);
    // 触发点 2：刷新后 diff 出状态跃迁
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("轮询发现「构建中 → 构建成功」时通知", async () => {
    const tasks = useTasksStore();
    tasks.tasks = [task(1004, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1004, "构建成功")];
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ id: 1004 });
  });

  it("启动时看到的历史终态任务不弹通知", async () => {
    const tasks = useTasksStore();
    // 第一次 diff 就已是终态：lastSeen 里没有"之前的状态"，不应通知
    tasks.tasks = [task(1005, "构建成功")];
    const notify = useBuildNotifications();

    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("失败态也会通知", async () => {
    const tasks = useTasksStore();
    tasks.tasks = [task(1006, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1006, "构建失败")];
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ title: "构建失败" });
  });
});
