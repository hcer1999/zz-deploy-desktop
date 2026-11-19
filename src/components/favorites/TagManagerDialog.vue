<script setup lang="ts">
import { ref } from "vue";
import { TAG_PALETTE, useTagsStore } from "@/stores/tags";
import type { TagDef } from "@/api/tags";
import { toUserMessage } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 标签管理：改色 / 改名 / 删除。
 *
 * 改名与删除在 Rust 侧是级联的（会同时改两条收藏里的引用），所以这里只调命令、
 * 用返回的新表替换本地状态，不在前端自己拼。
 */
const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [boolean]; changed: [] }>();

const tags = useTagsStore();
const error = ref("");
const pendingDelete = ref<TagDef | null>(null);

/** 每行的改名草稿：只在提交时用，避免输入过程中就触发命令 */
const drafts = ref<Record<string, string>>({});

function draftOf(t: TagDef): string {
  return drafts.value[t.name] ?? t.name;
}

async function recolor(t: TagDef, color: string): Promise<void> {
  if (color === t.color) return;
  error.value = "";
  try {
    await tags.upsert({ name: t.name, color });
    emit("changed");
  } catch (e) {
    error.value = toUserMessage(e);
  }
}

async function rename(t: TagDef): Promise<void> {
  const next = (drafts.value[t.name] ?? "").trim();
  if (!next || next === t.name) return;
  error.value = "";
  try {
    await tags.upsert({ oldName: t.name, name: next, color: t.color });
    delete drafts.value[t.name];
    // 改名/改色都改了所有收藏里的引用（Rust 侧级联），页面必须重新读，否则行里还是旧标签
    emit("changed");
  } catch (e) {
    error.value = toUserMessage(e);
  }
}

async function confirmDelete(): Promise<void> {
  const t = pendingDelete.value;
  if (!t) return;
  error.value = "";
  try {
    await tags.remove(t.name);
    emit("changed");
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    pendingDelete.value = null;
  }
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent data-test="tag-manager" class="max-w-[440px]">
      <DialogHeader>
        <DialogTitle>管理标签</DialogTitle>
        <DialogDescription>
          改名或删除会同步更新所有收藏（单条收藏与批量收藏）。
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-2 max-h-[320px] overflow-auto">
        <div
          v-for="t in tags.items"
          :key="t.name"
          data-test="tag-row"
          class="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
        >
          <Input
            class="h-7 w-28 text-xs"
            :model-value="draftOf(t)"
            @update:model-value="(v: string | number) => (drafts[t.name] = String(v))"
            @keyup.enter="rename(t)"
            @blur="rename(t)"
          />
          <div class="flex items-center gap-1 flex-1">
            <button
              v-for="c in TAG_PALETTE"
              :key="c"
              :data-test="`color-${c}`"
              class="w-4 h-4 rounded-full border"
              :class="c === t.color ? 'ring-2 ring-text/40' : ''"
              :style="{ backgroundColor: c, borderColor: c }"
              :title="c"
              @click="recolor(t, c)"
            />
          </div>
          <button
            data-test="delete-tag"
            class="text-[11px] text-text-muted hover:text-danger shrink-0"
            @click="pendingDelete = t"
          >
            删除
          </button>
        </div>
        <div v-if="tags.items.length === 0" class="text-[11px] text-text-muted py-3 text-center">
          还没有标签。在收藏的「编辑备注/标签」里新建。
        </div>
      </div>

      <p v-if="error" class="text-[11px] text-danger">{{ error }}</p>

      <div class="flex justify-end">
        <Button variant="outline" @click="emit('update:open', false)">关闭</Button>
      </div>
    </DialogContent>
  </Dialog>

  <ConfirmDialog
    :open="pendingDelete !== null"
    title="删除这个标签？"
    :description="
      pendingDelete
        ? `「${pendingDelete.name}」会从所有收藏里移除，不可恢复`
        : ''
    "
    confirm-text="删除"
    danger
    @update:open="(v: boolean) => { if (!v) pendingDelete = null; }"
    @confirm="confirmDelete"
  />
</template>
