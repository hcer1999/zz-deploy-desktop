import { acceptHMRUpdate, defineStore } from "pinia";
import { computed, ref } from "vue";
import * as api from "@/api/tags";
import type { TagDef } from "@/api/tags";

export type { TagDef };

/**
 * 与 Rust 侧 `commands/tags.rs` 的 PALETTE 同值（10 色）。
 * 这份只在"收藏里出现了没登记的标签名"时用于兜底着色，
 * 已登记的标签一律以服务端返回的颜色为准。
 */
export const TAG_PALETTE: readonly string[] = [
  "#94a3b8",
  "#f87171",
  "#fb923c",
  "#fbbf24",
  "#34d399",
  "#2dd4bf",
  "#38bdf8",
  "#818cf8",
  "#a78bfa",
  "#f472b6",
];

/** 空标签名的兜底色（中性灰），不参与哈希 */
export const DEFAULT_TAG_COLOR = "#94a3b8";

export const useTagsStore = defineStore("tags", () => {
  const items = ref<TagDef[]>([]);
  const loaded = ref(false);

  const byName = computed(() => new Map(items.value.map((t) => [t.name, t])));

  /** 未登记的名字按字节和取模取色，保证同一个名字到处同色 */
  function fallbackColor(name: string): string {
    if (!name) return DEFAULT_TAG_COLOR;
    let sum = 0;
    for (const ch of name) sum += ch.codePointAt(0) ?? 0;
    return TAG_PALETTE[sum % TAG_PALETTE.length];
  }

  function colorOf(name: string): string {
    return byName.value.get(name)?.color ?? fallbackColor(name);
  }

  async function load(): Promise<void> {
    items.value = await api.listTags();
    loaded.value = true;
  }

  async function upsert(input: { oldName?: string; name: string; color: string }): Promise<void> {
    items.value = await api.upsertTag(input);
    loaded.value = true;
  }

  async function remove(name: string): Promise<void> {
    items.value = await api.deleteTag(name);
    loaded.value = true;
  }

  return { items, loaded, byName, colorOf, load, upsert, remove };
});

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTagsStore, import.meta.hot));
}
