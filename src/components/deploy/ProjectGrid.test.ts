import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { Project } from "@/api/parser";
import ProjectGrid from "./ProjectGrid.vue";

const PROJECTS: Project[] = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  name: `zz-proj-${i + 1}`,
}));

let mounted: ReturnType<typeof mount> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/**
 * jsdom 没有布局：把滚动容器的尺寸与 scrollTop 换成可观测的假实现。
 * 与 LogView.test.ts 的做法一致。
 */
function fakeScroller(w: ReturnType<typeof mount>, opts: { height: number; content: number }) {
  const el = w.find('[data-test="project-scroll"]').element as HTMLElement;
  const state = { top: 0, height: opts.height, content: opts.content };
  Object.defineProperty(el, "clientHeight", { configurable: true, get: () => state.height });
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => state.content });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => state.top,
    set: (v: number) => {
      state.top = v;
    },
  });
  return { el, state };
}

async function mountGrid(projects = PROJECTS): Promise<ReturnType<typeof mount>> {
  mounted = mount(ProjectGrid, {
    props: { projects, selectedId: null },
    attachTo: document.body,
  });
  await flushPromises();
  return mounted;
}

function more(w: ReturnType<typeof mount>) {
  return w.find('[data-test="grid-more"]');
}
function fade(w: ReturnType<typeof mount>) {
  return w.find('[data-test="grid-fade"]');
}

describe("ProjectGrid 滚动提示", () => {
  it("内容溢出且未滚到底时显示提示与渐隐", async () => {
    const w = await mountGrid();
    fakeScroller(w, { height: 200, content: 600 });
    w.vm.$forceUpdate();
    await w.find('[data-test="project-scroll"]').trigger("scroll");
    expect(more(w).exists()).toBe(true);
    expect(more(w).text()).toContain("共 12 个项目");
    expect(more(w).text()).toContain("向下滚动");
    expect(fade(w).exists()).toBe(true);
  });

  it("滚到底后提示与渐隐消失", async () => {
    const w = await mountGrid();
    const { el, state } = fakeScroller(w, { height: 200, content: 600 });
    await el.dispatchEvent(new Event("scroll"));
    expect(more(w).exists()).toBe(true);

    state.top = 400;
    await el.dispatchEvent(new Event("scroll"));
    expect(more(w).exists()).toBe(false);
    expect(fade(w).exists()).toBe(false);
  });

  it("内容不溢出时不显示提示", async () => {
    const w = await mountGrid(PROJECTS.slice(0, 3));
    const { el } = fakeScroller(w, { height: 200, content: 200 });
    await el.dispatchEvent(new Event("scroll"));
    expect(more(w).exists()).toBe(false);
    expect(fade(w).exists()).toBe(false);
  });

  it("项目数量变化后重新计算", async () => {
    const w = await mountGrid(PROJECTS.slice(0, 3));
    const { el, state } = fakeScroller(w, { height: 200, content: 200 });
    await el.dispatchEvent(new Event("scroll"));
    expect(more(w).exists()).toBe(false);

    state.content = 600;
    await w.setProps({ projects: PROJECTS });
    await el.dispatchEvent(new Event("scroll"));
    expect(more(w).exists()).toBe(true);
  });

  it("点击项目发出 pick 事件", async () => {
    const w = await mountGrid(PROJECTS.slice(0, 3));
    await w.findAll('[data-test="project-scroll"] button')[1].trigger("click");
    expect(w.emitted("pick")?.[0]?.[0]).toMatchObject({ id: 2, name: "zz-proj-2" });
  });

  it("选中项滚动到可见区域（block: nearest）", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const w = await mountGrid(PROJECTS.slice(0, 3));
    await w.setProps({ selectedId: 3 });
    await flushPromises();
    expect(scrollSpy).toHaveBeenCalledWith({ block: "nearest" });
  });
});
