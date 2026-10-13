import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/favorites", () => ({
  listFavorites: vi.fn(),
  saveFavorite: vi.fn(),
  deleteFavorite: vi.fn(),
  reorderFavorites: vi.fn(),
}));

import * as api from "@/api/favorites";
import { useFavoritesStore, type Favorite } from "./favorites";

function fav(over: Partial<Favorite> = {}): Favorite {
  return {
    id: "1",
    type: "project",
    deployType: "auto",
    envId: 1,
    envName: "测试环境",
    projectId: 10,
    projectName: "zz-cy-iptv",
    ...over,
  };
}

describe("favorites store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("load 拉取列表", async () => {
    vi.mocked(api.listFavorites).mockResolvedValue([fav()]);
    const s = useFavoritesStore();
    await s.load();
    expect(s.items).toHaveLength(1);
    expect(s.loaded).toBe(true);
  });

  it("save 走 API 并把返回值并入列表", async () => {
    vi.mocked(api.saveFavorite).mockResolvedValue(fav({ id: "9" }));
    const s = useFavoritesStore();
    await s.save({ ...fav(), id: "" });
    expect(s.items.find((f) => f.id === "9")).toBeTruthy();
  });

  it("save 同一条（同 id）时替换而不是追加", async () => {
    vi.mocked(api.saveFavorite).mockResolvedValue(fav({ id: "1", branch: "main" }));
    const s = useFavoritesStore();
    s.items = [fav({ id: "1" })];
    await s.save(fav({ id: "1", branch: "main" }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0].branch).toBe("main");
  });

  it("remove 从列表里删掉", async () => {
    vi.mocked(api.deleteFavorite).mockResolvedValue(undefined);
    const s = useFavoritesStore();
    s.items = [fav({ id: "1" }), fav({ id: "2" })];
    await s.remove("1");
    expect(s.items.map((f) => f.id)).toEqual(["2"]);
  });

  it("isFavorited 按 项目+环境+类型 判断，忽略分支", () => {
    const s = useFavoritesStore();
    s.items = [fav({ projectId: 10, envId: 1, deployType: "auto" })];
    expect(s.isFavorited(10, 1, "auto")).toBe(true);
    expect(s.isFavorited(10, 1, "docker")).toBe(false);
    expect(s.isFavorited(10, 2, "auto")).toBe(false);
    expect(s.isFavorited(99, 1, "auto")).toBe(false);
  });

  it("findByProject 返回匹配的那条，供星标取消收藏时取 id", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "7", projectId: 10, envId: 1, deployType: "auto" })];
    expect(s.findByProject(10, 1, "auto")?.id).toBe("7");
    expect(s.findByProject(10, 1, "docker")).toBeUndefined();
  });

  it("按环境与环境名回填，避免收藏里存了过期的环境名", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "1", envName: "旧名字" })];
    s.refreshEnvNames([{ id: 1, name: "测试环境" }]);
    expect(s.items[0].envName).toBe("测试环境");
  });

  it("环境列表里没有该 envId 时保持原样，不清空", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "1", envId: 99, envName: "已下线的环境" })];
    s.refreshEnvNames([{ id: 1, name: "测试环境" }]);
    expect(s.items[0].envName).toBe("已下线的环境");
  });

  it("名字没变化时不产生新对象（避免无谓重渲染）", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "1", envName: "测试环境" })];
    // 注意：Pinia 的 ref 会把元素包成响应式 proxy，所以不能拿它跟传入的
    // 原始对象比 toBe；要比的是刷新前后同一个 proxy 的身份。
    const before = s.items[0];
    s.refreshEnvNames([{ id: 1, name: "测试环境" }]);
    expect(s.items[0]).toBe(before);
  });

  describe("拖动排序", () => {
    it("persistOrder 提交当前 id 顺序，并用服务端结果替换本地", async () => {
      const first = fav({ id: "1" });
      const second = fav({ id: "2" });
      const s = useFavoritesStore();
      // 本地被拖成 2,1
      s.items = [second, first];

      // 服务端归一化后返回 1,2
      vi.mocked(api.reorderFavorites).mockResolvedValue([first, second]);
      await s.persistOrder();

      expect(api.reorderFavorites).toHaveBeenCalledWith(["2", "1"]);
      expect(s.items.map((f) => f.id)).toEqual(["1", "2"]);
    });

    it("persistOrder 提交的是**当前**数组顺序，而不是最初加载的顺序", async () => {
      const s = useFavoritesStore();
      s.items = [fav({ id: "c" }), fav({ id: "a" }), fav({ id: "b" })];
      vi.mocked(api.reorderFavorites).mockResolvedValue(s.items);
      await s.persistOrder();
      expect(api.reorderFavorites).toHaveBeenCalledWith(["c", "a", "b"]);
    });

    it("persistOrder 失败时向调用方抛出，便于界面提示并回滚", async () => {
      const s = useFavoritesStore();
      s.items = [fav({ id: "1" })];
      vi.mocked(api.reorderFavorites).mockRejectedValue({ kind: "network", message: "x" });
      await expect(s.persistOrder()).rejects.toBeTruthy();
    });
  });

  it("名字变了则产生新对象", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "1", envName: "旧名字" })];
    const before = s.items[0];
    s.refreshEnvNames([{ id: 1, name: "测试环境" }]);
    expect(s.items[0]).not.toBe(before);
    expect(s.items[0].envName).toBe("测试环境");
  });
});
