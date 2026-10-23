import { beforeEach, describe, expect, it, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/api/update", () => ({
  checkUpdate: vi.fn(async () => ({
    currentVersion: "0.1.1",
    latestVersion: "0.2.0",
    available: true,
    notes: "## 更新内容\n修复大日志卡死",
    publishedAt: null,
  })),
  installUpdate: vi.fn(async (onProgress: (p: unknown) => void) => {
    onProgress({ phase: "downloading", downloaded: 100, total: 100 });
    onProgress({ phase: "installing", downloaded: 100, total: 100 });
  }),
  restartApp: vi.fn(async () => {}),
  discardUpdate: vi.fn(async () => {}),
}));

import * as api from "@/api/update";
import { useUpdateStore } from "@/stores/update";
import UpdateBanner from "./UpdateBanner.vue";

describe("UpdateBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("有新版本时显示版本号与更新说明", async () => {
    const update = useUpdateStore();
    await update.check();
    const w = mount(UpdateBanner);

    const banner = w.find('[data-test="update-banner"]');
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("v0.2.0");
    // 只预览第一行，不把整段 Markdown 塞进提示条
    expect(banner.text()).toContain("## 更新内容");
    expect(banner.text()).not.toContain("修复大日志卡死");
  });

  it("忽略后提示条消失", async () => {
    const update = useUpdateStore();
    await update.check();
    const w = mount(UpdateBanner);

    await w.find('[data-test="update-dismiss"]').trigger("click");
    await flushPromises();
    expect(w.find('[data-test="update-banner"]').exists()).toBe(false);
  });

  it("点「立即更新」在客户端内下载安装，完成后提示重启", async () => {
    const update = useUpdateStore();
    await update.check();
    const w = mount(UpdateBanner);

    await w.find('[data-test="update-install"]').trigger("click");
    await flushPromises();

    expect(api.installUpdate).toHaveBeenCalled();
    expect(w.find('[data-test="update-banner"]').text()).toContain("已安装");
    expect(w.find('[data-test="update-restart"]').exists()).toBe(true);
  });

  it("点「立即重启」调用 process.relaunch", async () => {
    const update = useUpdateStore();
    await update.check();
    await update.install();
    const w = mount(UpdateBanner);

    await w.find('[data-test="update-restart"]').trigger("click");
    await flushPromises();
    expect(api.restartApp).toHaveBeenCalled();
  });
});
