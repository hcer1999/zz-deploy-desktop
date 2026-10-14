import { describe, it, expect, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SearchSelect from "./SearchSelect.vue";

const OPTIONS = [
  { value: "a1b2c3d4#-----#修复播放页黑屏", label: "a1b2c3d4 修复播放页黑屏" },
  { value: "e5f6a7b8#-----#新增榜单入口", label: "e5f6a7b8 新增榜单入口" },
];

// 下拉内容通过 portal 渲染到 document.body，用例间必须清干净，
// 否则后一个用例会读到前一个用例残留的选项（实测踩过）
let mounted: ReturnType<typeof mount>[] = [];

function mountSelect(props: {
  modelValue: string;
  options: { value: string; label: string }[];
  emptyText?: string;
  disabled?: boolean;
}): ReturnType<typeof mount> {
  const w = mount(SearchSelect, { props, attachTo: document.body });
  mounted.push(w);
  return w;
}

afterEach(() => {
  mounted.forEach((w) => w.unmount());
  mounted = [];
  document.body.innerHTML = "";
});

/** 打开下拉并等待内容渲染 */
async function openList(w: ReturnType<typeof mount>): Promise<void> {
  await w.find("input").trigger("click");
  await flushPromises();
}

function optionNodes(): NodeListOf<HTMLElement> {
  return document.querySelectorAll('[role="option"]');
}

describe("SearchSelect", () => {
  it("点击后展开并列出全部选项", async () => {
    mountSelect({ modelValue: "", options: OPTIONS });
    await openList(mounted[0]);
    expect(optionNodes().length).toBe(2);
  });

  it("输入关键字后只保留匹配项", async () => {
    const w = mountSelect({ modelValue: "", options: OPTIONS });
    await openList(w);
    await w.find("input").setValue("榜单");
    await flushPromises();

    expect(optionNodes().length).toBe(1);
    expect(document.body.textContent).toContain("新增榜单入口");
  });

  it("没有匹配项时显示空态文案", async () => {
    const w = mountSelect({ modelValue: "", options: OPTIONS, emptyText: "没有匹配的 commit" });
    await openList(w);
    await w.find("input").setValue("zzzz-nothing");
    await flushPromises();
    expect(optionNodes().length).toBe(0);
    expect(document.body.textContent).toContain("没有匹配的 commit");
  });

  it("点选后向父组件抛出选项的 value", async () => {
    const w = mountSelect({ modelValue: "", options: OPTIONS });
    await openList(w);
    const items = optionNodes();
    expect(items.length).toBe(2);
    items[1].click();
    await flushPromises();
    expect(w.emitted("update:modelValue")?.[0]).toEqual([OPTIONS[1].value]);
  });

  it("已选中时输入框显示该项的 label", async () => {
    const w = mountSelect({ modelValue: OPTIONS[0].value, options: OPTIONS });
    await flushPromises();
    expect((w.find("input").element as HTMLInputElement).value).toContain("修复播放页黑屏");
  });

  it("disabled 时输入框禁用", () => {
    const w = mountSelect({ modelValue: "", options: OPTIONS, disabled: true });
    expect((w.find("input").element as HTMLInputElement).disabled).toBe(true);
  });
});
