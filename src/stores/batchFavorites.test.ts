import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/batchFavorites", () => ({
  listBatchFavorites: vi.fn(),
  saveBatchFavorite: vi.fn(),
  deleteBatchFavorite: vi.fn(),
  batchFavoritesMetaSet: vi.fn(),
}));

import * as api from "@/api/batchFavorites";
import { useBatchFavoritesStore, type BatchFavorite } from "./batchFavorites";

function fav(over: Partial<BatchFavorite> = {}): BatchFavorite {
  return { id: "1", name: "发版", items: [], ...over };
}

describe("batchFavorites store 元数据", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("setMeta 把命令返回的记录写回本地", async () => {
    vi.mocked(api.listBatchFavorites).mockResolvedValue([fav()]);
    const s = useBatchFavoritesStore();
    await s.load();

    vi.mocked(api.batchFavoritesMetaSet).mockResolvedValue(
      fav({ note: "周五发", tags: ["线上"] }),
    );
    await s.setMeta("1", { note: "周五发", tags: ["线上"] });

    expect(api.batchFavoritesMetaSet).toHaveBeenCalledWith("1", "周五发", ["线上"]);
    expect(s.items[0].note).toBe("周五发");
    expect(s.items[0].tags).toEqual(["线上"]);
  });
});
