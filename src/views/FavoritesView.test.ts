import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { VueDraggable } from "vue-draggable-plus";

vi.mock("@/api/favorites", () => ({
  listFavorites: vi.fn(async () => [
    {
      id: "1",
      type: "config",
      deployType: "auto",
      envId: 1,
      envName: "测试环境",
      projectId: 1,
      projectName: "proj-AAA",
      branch: "main",
    },
    {
      id: "2",
      type: "config",
      deployType: "auto",
      envId: 2,
      envName: "正式环境",
      projectId: 2,
      projectName: "proj-BBB",
      branch: "release",
    },
  ]),
  saveFavorite: vi.fn(),
  deleteFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));
vi.mock("@/api/deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/deploy")>()),
  fetchBranches: vi.fn(async () => []),
  fetchCommits: vi.fn(async () => []),
  submitDeploy: vi.fn(async () => true),
}));

import FavoritesView from "./FavoritesView.vue";
import { useFavoritesStore } from "@/stores/favorites";

describe("FavoritesView 拖动排序", () => {
  let pinia: Pinia;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
  });

  it("启用 force-fallback（不能用原生 HTML5 拖放）", async () => {
    // 回归防线：SortableJS 默认优先用浏览器原生 HTML5 拖放，
    // 而各 webview 对它支持差异很大——实测在 Tauri 的 WKWebView 里拖不动，
    // 表现为"拖动排序不生效"。这个开关一旦被去掉，功能就会退回不可用状态。
    await useFavoritesStore().load();
    const w = mount(FavoritesView, { global: { plugins: [pinia] } });
    await w.vm.$nextTick();

    const draggable = w.findComponent(VueDraggable);
    expect(draggable.exists()).toBe(true);
    expect(draggable.props("forceFallback")).toBe(true);
    // 幽灵元素挂在 body 上，否则会被每一项的 overflow-hidden 裁掉
    expect(draggable.props("fallbackOnBody")).toBe(true);
    expect(draggable.props("handle")).toBe(".drag-handle");
  });
});
