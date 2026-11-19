import { call } from "./ipc";

/** 全局标签表里的一条：名字 + 颜色（#rrggbb） */
export interface TagDef {
  name: string;
  color: string;
}

export function listTags(): Promise<TagDef[]> {
  return call<TagDef[]>("tags_list");
}

/**
 * 新增 / 改色 / 改名。
 * 带 `oldName` 即改名：Rust 侧会同时把两条收藏（单条 + 批量）里的旧名换掉。
 */
export function upsertTag(input: {
  oldName?: string;
  name: string;
  color: string;
}): Promise<TagDef[]> {
  return call<TagDef[]>("tags_upsert", input);
}

/** 删除标签定义，并从所有收藏里级联摘掉。返回新的标签表 */
export function deleteTag(name: string): Promise<TagDef[]> {
  return call<TagDef[]>("tags_delete", { name });
}
