import { call } from "./ipc";

/*
 * 与 `api/favorites.ts` 同一约定：视图不要直接调用这里的写操作，
 * 一律走 `stores/batchFavorites.ts`，否则同一份数据会出现两个真相来源。
 */

/**
 * 批量计划里的一项：**自带环境、项目、分支**，所以一份计划可以跨环境、跨分支、跨部署类型。
 *
 * 刻意**不记** commit（发版基本都取最新，存下来容易"以为发新版、其实发旧提交"）
 * 与「自动上线」开关（那是必须每次都重新有意识打开的危险开关）。
 */
export interface BatchFavoriteItem {
  deployType: "auto" | "docker";
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  /** 空串 = 载入后还要自己选 */
  branch: string;
}

/** 一份具名的批量计划 */
export interface BatchFavorite {
  id: string;
  name: string;
  items: BatchFavoriteItem[];
}

export function listBatchFavorites(): Promise<BatchFavorite[]> {
  return call<BatchFavorite[]>("batch_favorites_list");
}

export function saveBatchFavorite(fav: BatchFavorite): Promise<BatchFavorite> {
  return call<BatchFavorite>("batch_favorites_save", { fav });
}

export function deleteBatchFavorite(id: string): Promise<void> {
  return call<void>("batch_favorites_delete", { id });
}
