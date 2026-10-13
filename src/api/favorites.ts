import { call } from "./ipc";

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
}

export function listFavorites(): Promise<Favorite[]> {
  return call<Favorite[]>("favorites_list");
}

export function saveFavorite(fav: Favorite): Promise<Favorite> {
  return call<Favorite>("favorites_save", { fav });
}

export function deleteFavorite(id: string): Promise<void> {
  return call<void>("favorites_delete", { id });
}
