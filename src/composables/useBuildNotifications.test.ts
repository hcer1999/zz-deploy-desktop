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
import { useSettingsStore } from "@/stores/settings";
import { useTasksStore } from "@/stores/tasks";
import { useBatchStore } from "@/stores/batch";

function task(id: number, buildStatus: string, submitter = "zhangsan"): DeployTask {
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
    submitter,
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
    // 服务端页面里学到的当前登录人显示名（与任务的 submitter 同一套名字）
    useTasksStore().currentUser = "zhangsan";
  });

  it("窗口失焦时，日志流结束会弹一条通知", async () => {
    const tasks = useTasksStore();
    // 轮询先看到"构建中"，才认得出这次日志结束是真正的构建完成
    tasks.tasks = [task(1001, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1001, "构建成功")];
    notify.onLogFinished(1001);
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ id: 1001, title: "构建成功" });
  });

  it("回看历史日志（服务端重放旧日志）不弹通知", async () => {
    const tasks = useTasksStore();
    // 从未看到它处于构建中，只有一条已完成的记录
    tasks.tasks = [task(1007, "构建成功")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    notify.onLogFinished(1007);
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("默认（不显式设置）就是「始终通知」：窗口聚焦也弹", async () => {
    isFocused.mockResolvedValue(true);
    const tasks = useTasksStore();
    tasks.tasks = [task(1009, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1009, "构建成功")];
    notify.onLogFinished(1009);
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("设为「仅窗口失焦时」后，窗口聚焦就不打扰用户", async () => {
    isFocused.mockResolvedValue(true);
    useSettingsStore().notifyMode = "unfocused";
    const tasks = useTasksStore();
    tasks.tasks = [task(1002, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1002, "构建成功")];
    notify.onLogFinished(1002);
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("设为「始终通知」时窗口聚焦也弹", async () => {
    isFocused.mockResolvedValue(true);
    useSettingsStore().notifyMode = "always";

    const tasks = useTasksStore();
    tasks.tasks = [task(1008, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(1008, "构建成功")];
    notify.onLogFinished(1008);
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
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

  it("别人提交的构建不通知（无论日志流还是轮询）", async () => {
    const tasks = useTasksStore();
    tasks.tasks = [task(2001, "构建中", "lisi")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(2001, "构建成功", "lisi")];
    notify.onLogFinished(2001);
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("同一批里只有自己那条弹通知", async () => {
    const tasks = useTasksStore();
    tasks.tasks = [task(2002, "构建中"), task(2003, "构建中", "lisi")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(2002, "构建成功"), task(2003, "构建成功", "lisi")];
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ id: 2002 });
  });

  it("还不知道当前登录人是谁时一律不通知（宁可漏报也不退回全弹）", async () => {
    const tasks = useTasksStore();
    tasks.currentUser = "";
    tasks.tasks = [task(2004, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(2004, "构建成功")];
    notify.onLogFinished(2004);
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe("批量部署期间的单条通知抑制", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sendNotification.mockClear();
    isFocused.mockResolvedValue(false);
    useTasksStore().currentUser = "zhangsan";
  });

  /** 造一个已认领任务 1001 的批次 */
  function claimedBatch(): void {
    const batches = useBatchStore();
    const run = batches.start({
      autoOnline: false,
      baselines: { auto: 1000 },
      items: [
        {
          deployType: "auto",
          envId: 1,
          envName: "测试环境",
          projectId: 1,
          projectName: "zz-cy-iptv",
          branch: "main",
          version: "abc12345#-----#修复",
        },
      ],
    });
    run.items[0].taskId = 3001; // 直接当成已认领（认领逻辑由 batch.test.ts 覆盖）
  }

  it("批次内的任务不弹单条（交给批次汇总）", async () => {
    claimedBatch();
    const tasks = useTasksStore();
    tasks.tasks = [task(3001, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(3001, "构建成功")];
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("批次外的任务照常弹", async () => {
    claimedBatch();
    const tasks = useTasksStore();
    // 用没在别的用例里出现过的 id：去重集合是模块级的（见 useBuildNotifications 顶部注释）
    tasks.tasks = [task(3002, "构建中")];
    const notify = useBuildNotifications();
    notify.diffAfterRefresh();

    tasks.tasks = [task(3002, "构建成功")];
    notify.diffAfterRefresh();
    await settle();

    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][0]).toMatchObject({ id: 3002 });
  });
});
