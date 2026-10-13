import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/api/favorites";
import type { Favorite } from "@/api/favorites";

export type { Favorite };

export const useFavoritesStore = defineStore("favorites", () => {
  const items = ref<Favorite[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    items.value = await api.listFavorites();
    loaded.value = true;
  }

  /** 新增或更新。Rust 侧已做去重，这里只需按 id 合并 */
  async function save(fav: Favorite): Promise<Favorite> {
    const saved = await api.saveFavorite(fav);
    const idx = items.value.findIndex((f) => f.id === saved.id);
    if (idx >= 0) items.value[idx] = saved;
    else items.value.push(saved);
    return saved;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteFavorite(id);
    items.value = items.value.filter((f) => f.id !== id);
  }

  /** 与 Rust 侧 dedupe_key 同口径：忽略分支 */
  function findByProject(
    projectId: number,
    envId: number,
    deployType: "auto" | "docker",
  ): Favorite | undefined {
    return items.value.find(
      (f) => f.projectId === projectId && f.envId === envId && f.deployType === deployType,
    );
  }

  function isFavorited(projectId: number, envId: number, deployType: "auto" | "docker"): boolean {
    return findByProject(projectId, envId, deployType) !== undefined;
  }

  /**
   * 用最新的环境列表刷新收藏里存的环境名。
   * 环境列表是硬编码的，改过名字之后老收藏会显示成旧名。
   * 找不到对应 envId 时保持原值，不清空——环境可能只是临时不在列表里。
   */
  function refreshEnvNames(envs: { id: number; name: string }[]): void {
    const byId = new Map(envs.map((e) => [e.id, e.name]));
    items.value = items.value.map((f) => {
      const name = byId.get(f.envId);
      // 名字没变时返回原对象，避免无谓的引用变化触发重渲染
      return name && name !== f.envName ? { ...f, envName: name } : f;
    });
  }

  return { items, loaded, load, save, remove, findByProject, isFavorited, refreshEnvNames };
});
