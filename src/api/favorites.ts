import { call } from "./ipc";

/*
 * 注意：视图与组件**不要**直接调用本文件的写操作
 * （saveFavorite / deleteFavorite / reorderFavorites）。
 *
 * 收藏页读的是 stores/favorites.ts 的 items，绕过 store 直接写 API
 * 会让它停留在旧列表——实测踩过：向导里保存成功但收藏页看不到。
 * 写操作一律走 store（save / remove / persistOrder）。
 */

export interface Favorite {
  id: string;
  /** "project" 只记项目 | "config" 记项目 + 环境 + 分支 */
  type: "project" | "config";
  deployType: "auto" | "docker";
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  branch?: string;
  /** 备注（收藏页编辑） */
  note?: string;
  /** 标签名；颜色在全局标签表里（api/tags.ts） */
  tags?: string[];
}

export function listFavorites(): Promise<Favorite[]> {
  return call<Favorite[]>("favorites_list");
}

export function saveFavorite(fav: Favorite): Promise<Favorite> {
  return call<Favorite>("favorites_save", { fav });
}

/** 按给定 id 顺序重排。返回服务端权威结果（顺序已落盘） */
export function reorderFavorites(ids: string[]): Promise<Favorite[]> {
  return call<Favorite[]>("favorites_reorder", { ids });
}

/** 只改备注与标签：与 saveFavorite 分开，避免互相覆盖 */
export function favoritesMetaSet(
  id: string,
  note: string,
  tags: string[],
): Promise<Favorite> {
  return call<Favorite>("favorites_meta_set", { id, note, tags });
}

export function deleteFavorite(id: string): Promise<void> {
  return call<void>("favorites_delete", { id });
}
