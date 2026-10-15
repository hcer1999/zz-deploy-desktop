import { acceptHMRUpdate, defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/api/batchFavorites";
import type { BatchFavorite } from "@/api/batchFavorites";

export type { BatchFavorite };

export const useBatchFavoritesStore = defineStore("batchFavorites", () => {
  const items = ref<BatchFavorite[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    const list = await api.listBatchFavorites();
    // 兜底：`items` 缺字段（例如读到旧形状的残留）也不该让页面崩掉。
    // Rust 侧已经把旧记录迁移过了，这里是第二道防线。
    items.value = list.map((f) => ({ ...f, items: f.items ?? [] }));
    loaded.value = true;
  }

  /** 新增或修改（Rust 侧按 id / 同名同环境同类型去重，这里只按 id 合并） */
  async function save(fav: BatchFavorite): Promise<BatchFavorite> {
    const saved = await api.saveBatchFavorite(fav);
    const idx = items.value.findIndex((f) => f.id === saved.id);
    if (idx >= 0) items.value[idx] = saved;
    else items.value.push(saved);
    return saved;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteBatchFavorite(id);
    items.value = items.value.filter((f) => f.id !== id);
  }

  /** 环境名字是硬编码的（spec §5.4），收藏里存的旧名字要跟着刷新（逐项刷） */
  function refreshEnvNames(envs: { id: number; name: string }[]): void {
    for (const f of items.value) {
      for (const it of f.items ?? []) {
        const hit = envs.find((e) => e.id === it.envId);
        if (hit) it.envName = hit.name;
      }
    }
  }

  return { items, loaded, load, save, remove, refreshEnvNames };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useBatchFavoritesStore, import.meta.hot));
}
