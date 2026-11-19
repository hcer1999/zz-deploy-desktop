import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

vi.mock("@/api/tags", () => ({
  listTags: vi.fn(async () => [
    { name: "线上", color: "#f87171" },
    { name: "紧急", color: "#fbbf24" },
  ]),
  upsertTag: vi.fn(),
  deleteTag: vi.fn(),
}));

import { useTagsStore } from "@/stores/tags";
import MetaDialog from "./MetaDialog.vue";

// 弹窗内容经 portal 渲染到 body，用例里统一用 document 查询（与 BatchDeployView.test 同一做法）
function q<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(selector);
}
function qa(selector: string): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector));
}
async function click(selector: string): Promise<void> {
  const el = q(selector);
  if (!el) throw new Error(`找不到：${selector}`);
  el.click();
  await flushPromises();
}
async function clickButton(text: string): Promise<void> {
  const btn = qa("button").find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`找不到按钮：${text}`);
  btn.click();
  await flushPromises();
}

async function mountDialog(
  props: Partial<{ note: string; tags: string[]; mode: "favorite" | "batch" }> = {},
) {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useTagsStore().load();
  const w = mount(MetaDialog, {
    props: {
      open: true,
      mode: "favorite",
      targetName: "zz-pay",
      note: "",
      tags: [],
      ...props,
    },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  await flushPromises();
  return w;
}

describe("MetaDialog", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    document.body.innerHTML = "";
  });

  it("带出已有备注与标签", async () => {
    await mountDialog({ note: "先找产品确认", tags: ["线上"] });
    expect((q("textarea") as HTMLTextAreaElement).value).toBe("先找产品确认");
    expect(qa('[data-test="selected-tag"]').map((t) => t.textContent?.trim())).toEqual([
      "线上 ×",
    ]);
  });

  it("保存时发出备注与选中标签", async () => {
    const w = await mountDialog({ note: "旧备注", tags: ["线上"] });
    const area = q("textarea") as HTMLTextAreaElement;
    area.value = "新备注";
    area.dispatchEvent(new Event("input"));
    await flushPromises();
    await clickButton("保存");
    expect(w.emitted("save")?.[0]?.[0]).toEqual({ note: "新备注", tags: ["线上"] });
  });

  it("移除已选标签后保存不含它", async () => {
    const w = await mountDialog({ tags: ["线上", "紧急"] });
    await click('[data-test="selected-tag"]');
    await clickButton("保存");
    expect(w.emitted("save")?.[0]?.[0]).toEqual({ note: "", tags: ["紧急"] });
  });

  it("点候选标签可加入", async () => {
    const w = await mountDialog();
    await click('[data-test="candidate-tag"]');
    await clickButton("保存");
    expect(w.emitted("save")?.[0]?.[0]).toEqual({ note: "", tags: ["线上"] });
  });

  it("输入新标签名 + 选色 + 添加后进入已选", async () => {
    const w = await mountDialog();
    const input = q('[data-test="new-tag-name"]') as HTMLInputElement;
    input.value = "灰度";
    input.dispatchEvent(new Event("input"));
    await flushPromises();
    await click('[data-test="color-#818cf8"]');
    await click('[data-test="add-tag"]');
    await clickButton("保存");
    expect(w.emitted("save")?.[0]?.[0]).toEqual({ note: "", tags: ["灰度"] });
  });

  it("「管理标签」打开标签管理弹窗", async () => {
    await mountDialog();
    await click('[data-test="open-tag-manager"]');
    expect(q('[data-test="tag-manager"]')).not.toBeNull();
  });
});
