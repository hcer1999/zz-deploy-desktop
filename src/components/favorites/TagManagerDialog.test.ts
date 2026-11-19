import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/api/tags", () => ({
  listTags: vi.fn(async () => [
    { name: "线上", color: "#f87171" },
    { name: "紧急", color: "#fbbf24" },
  ]),
  upsertTag: vi.fn(async () => [{ name: "线上", color: "#34d399" }]),
  deleteTag: vi.fn(async () => []),
}));

import * as api from "@/api/tags";
import { useTagsStore } from "@/stores/tags";
import TagManagerDialog from "./TagManagerDialog.vue";

function qa(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}

let current: ReturnType<typeof mount> | null = null;

afterEach(async () => {
  await flushPromises();
  current?.unmount();
  current = null;
});

async function mountDialog() {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useTagsStore().load();
  const w = mount(TagManagerDialog, {
    props: { open: true },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  current = w;
  return w;
}

describe("TagManagerDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("列出全部标签", async () => {
    await mountDialog();
    expect(qa('[data-test="tag-row"]')).toHaveLength(2);
  });

  it("点色板给该标签改色", async () => {
    await mountDialog();
    qa('[data-test="tag-row"]')[0]
      .querySelector<HTMLElement>('[data-test="color-#34d399"]')!
      .click();
    await flushPromises();
    expect(api.upsertTag).toHaveBeenCalledWith({
      name: "线上",
      color: "#34d399",
    });
  });

  it("改名字后按 oldName 提交", async () => {
    await mountDialog();
    const input = qa('[data-test="tag-row"]')[0].querySelector("input") as HTMLInputElement;
    input.value = "生产";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(api.upsertTag).toHaveBeenCalledWith({
      oldName: "线上",
      name: "生产",
      color: "#f87171",
    });
  });

  it("删除需要二次确认，确认后调 deleteTag", async () => {
    await mountDialog();
    qa('[data-test="tag-row"]')[0].querySelector<HTMLElement>('[data-test="delete-tag"]')!.click();
    await flushPromises();
    // 行内也有一个「删除」入口，确认按钮是后渲染的那个
    const confirm = qa("button").filter((b) => b.textContent?.trim() === "删除");
    expect(confirm.length).toBeGreaterThan(1);
    confirm[confirm.length - 1].click();
    await flushPromises();
    expect(api.deleteTag).toHaveBeenCalledWith("线上");
  });
});
