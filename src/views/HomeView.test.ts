import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "0.1.1") }));

import HomeView from "./HomeView.vue";
import { useTabsStore } from "@/stores/tabs";

let pinia: Pinia;

async function mountHome(): Promise<ReturnType<typeof mount>> {
  pinia = createPinia();
  setActivePinia(pinia);
  const w = mount(HomeView, { global: { plugins: [pinia] } });
  await flushPromises();
  return w;
}

describe("HomeView（没打开标签时的首页/启动器）", () => {
  beforeEach(() => vi.clearAllMocks());

  it("品牌头：品牌标 + 品牌名 + 版本号", async () => {
    const w = await mountHome();
    expect(w.find("h1").text()).toBe("至真部署");
    expect(w.find("h1").classes()).toContain("text-brand");
    expect(w.find("svg").exists()).toBe(true); // BrandLogo
    expect(w.text()).toContain("v0.1.1");
  });

  it("六个常用入口都在，且各有说明", async () => {
    const w = await mountHome();
    for (const kind of ["wizard", "batch", "favorites", "list", "history", "settings"]) {
      const card = w.find(`[data-test="home-${kind}"]`);
      expect(card.exists(), kind).toBe(true);
      expect(card.text().length).toBeGreaterThan(8);
    }
  });

  it("点卡片就打开对应标签（与侧栏/快捷键同一套 tabs.open）", async () => {
    const w = await mountHome();
    const tabs = useTabsStore();

    await w.find('[data-test="home-batch"]').trigger("click");
    expect(tabs.activeTab?.kind).toBe("batch");

    await w.find('[data-test="home-history"]').trigger("click");
    expect(tabs.activeTab?.kind).toBe("history");
    expect(tabs.tabs).toHaveLength(2);
  });

  it("右下角有次级入口通往关于页", async () => {
    const w = await mountHome();
    await w.find('[data-test="home-about"]').trigger("click");
    expect(useTabsStore().activeTab?.kind).toBe("about");
  });

  it("底部给出快捷键提示", async () => {
    const w = await mountHome();
    expect(w.text()).toContain("⌘/Ctrl + N 新建部署");
    expect(w.text()).toContain("⌘/Ctrl + 1…7 切换页面");
  });
});
