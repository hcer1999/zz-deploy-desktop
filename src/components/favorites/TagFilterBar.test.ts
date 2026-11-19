import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
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
import TagFilterBar from "./TagFilterBar.vue";

async function mountBar(props: { modelValue: string[]; available: string[] }) {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useTagsStore().load();
  return mount(TagFilterBar, { props, global: { plugins: [pinia] } });
}

describe("TagFilterBar", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("为可用的标签渲染 chip，点未选项追加，点已选项移除", async () => {
    const w = await mountBar({ modelValue: [], available: ["线上", "紧急"] });
    const chips = w.findAll('[data-test="tag-chip"]');
    expect(chips.map((c) => c.text())).toEqual(["线上", "紧急"]);

    await chips[0].trigger("click");
    expect(w.emitted("update:modelValue")?.[0]).toEqual([["线上"]]);

    const w2 = await mountBar({ modelValue: ["线上"], available: ["线上", "紧急"] });
    await w2.findAll('[data-test="tag-chip"]')[0].trigger("click");
    expect(w2.emitted("update:modelValue")?.[0]).toEqual([[]]);
  });

  it("有选中项时显示清除入口", async () => {
    const w = await mountBar({ modelValue: ["线上"], available: ["线上"] });
    const clear = w.find('[data-test="clear-tag-filter"]');
    expect(clear.exists()).toBe(true);
    await clear.trigger("click");
    expect(w.emitted("update:modelValue")?.[0]).toEqual([[]]);
  });

  it("没有可用的标签时不渲染", async () => {
    const w = await mountBar({ modelValue: [], available: [] });
    expect(w.text()).toBe("");
  });
});
