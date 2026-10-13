import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";

const OVERLAY = '[data-slot="dialog-overlay"]';

describe("ConfirmDialog", () => {
  it("打开时应有遮罩", async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: "t" }, attachTo: document.body });
    await nextTick();
    expect(document.querySelectorAll(OVERLAY).length).toBeGreaterThan(0);
    w.unmount();
  });

  it("对话框仍打开时卸载组件，不应残留全屏遮罩", async () => {
    // 这正是 submitDeploy 后的场景：确认框还开着，向导标签就被关掉了。
    // 若 portal 未清理，会留下一层看不见的遮罩挡住整个界面。
    const w = mount(ConfirmDialog, { props: { open: true, title: "t" }, attachTo: document.body });
    await nextTick();
    w.unmount();
    await nextTick();
    expect(document.querySelectorAll(OVERLAY).length).toBe(0);
  });

  it("先关闭再卸载，也不应残留", async () => {
    const w = mount(ConfirmDialog, { props: { open: true, title: "t" }, attachTo: document.body });
    await nextTick();
    await w.setProps({ open: false });
    await nextTick();
    w.unmount();
    await nextTick();
    expect(document.querySelectorAll(OVERLAY).length).toBe(0);
  });
});
