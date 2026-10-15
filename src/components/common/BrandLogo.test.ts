import { describe, it, expect, vi, beforeEach } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import BrandLogo from "./BrandLogo.vue";

/** 假装系统开了"减弱动态效果" */
function mockReducedMotion(reduce: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (q: string) => ({
      matches: q.includes("reduced-motion") ? reduce : false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

describe("BrandLogo（reframe draw-on 标）", () => {
  beforeEach(() => mockReducedMotion(false));

  it("内联了资产：1254×1254，青底 rect + 白线 path", () => {
    const w = mount(BrandLogo);
    expect(w.find("svg").attributes("viewBox")).toBe("0 0 1254 1254");
    expect(w.findAll("rect")).toHaveLength(1);
    expect(w.findAll("path")).toHaveLength(1);
    expect(w.html()).toContain("#00ADC3"); // 青底在资产里
  });

  it("把导出的 paused 改成播放（导出是 paused，等宿主播）", () => {
    const w = mount(BrandLogo);
    const html = w.html();
    expect(html).toContain("running rf-draw");
    expect(html).not.toContain("paused");
  });

  it("默认只播一次（iteration=1 + fill-mode=both，画完停在终态）", () => {
    const w = mount(BrandLogo);
    expect(w.html()).toMatch(/1\.867s ease-in-out[^;"]*1 normal both running rf-draw/);
  });

  it("减弱动态效果时：不播动画而是把时长压到 1ms —— 借资产的 100% 关键帧瞬间落到终态", async () => {
    mockReducedMotion(true);
    const w = mount(BrandLogo);
    await flushPromises(); // reduceMotion 在 onMounted 里读，等一帧生效
    const html = w.html();
    expect(html).not.toContain("paused");
    expect(html).toContain("0.001s");
    expect(html).not.toContain("1.867s");
    // 元素仍在（静态标完整）
    expect(w.findAll("path")).toHaveLength(1);
  });

  it("animated=false 同样落到终态", () => {
    const w = mount(BrandLogo, { props: { animated: false } });
    expect(w.html()).toContain("0.001s");
  });

  it("容器只负责尺寸与圆角（青底由资产给，容器不上底色）", () => {
    const w = mount(BrandLogo, { props: { size: 96 } });
    const box = w.find('[data-test="brand-mark"]');
    expect(box.classes()).toContain("rounded-[12.5%]");
    expect(box.classes()).not.toContain("bg-brand");
    expect(box.attributes("style")).toContain("96px");
    expect(box.attributes("aria-label")).toBe("至真部署");
  });
});
