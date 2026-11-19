<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { TAG_PALETTE, useTagsStore } from "@/stores/tags";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import TagManagerDialog from "./TagManagerDialog.vue";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * 备注 + 标签编辑器。单条收藏与批量收藏共用（mode 只影响文案）。
 *
 * 保存载荷只有 note/tags：部署字段由各自的 save 命令负责，
 * 两个入口分开写才不会互相覆盖。
 */
const props = defineProps<{
  open: boolean;
  mode: "favorite" | "batch";
  targetName: string;
  note: string;
  tags: string[];
}>();

const emit = defineEmits<{
  "update:open": [boolean];
  save: [{ note: string; tags: string[] }];
}>();

const tags = useTagsStore();
const note = ref("");
const selected = ref<string[]>([]);
const newTagName = ref("");
const newTagColor = ref(TAG_PALETTE[0]);
const managerOpen = ref(false);

/** 每次打开都从 props 重置：弹窗是"编辑一次"的，不该留着上次的残留 */
watch(
  () => props.open,
  (open) => {
    if (!open) return;
    note.value = props.note;
    selected.value = [...props.tags];
    newTagName.value = "";
    managerOpen.value = false;
  },
  { immediate: true },
);

/** 候选标签：已登记里没被选中的那批 */
const candidates = computed(() =>
  tags.items.map((t) => t.name).filter((n) => !selected.value.includes(n)),
);

function add(name: string): void {
  const n = name.trim();
  if (!n || selected.value.includes(n)) return;
  selected.value = [...selected.value, n];
}

function remove(name: string): void {
  selected.value = selected.value.filter((t) => t !== name);
}

async function addNew(): Promise<void> {
  const name = newTagName.value.trim();
  if (!name) return;
  // 新标签先登记（拿到颜色），再挂到这条收藏上
  await tags.upsert({ name, color: newTagColor.value });
  add(name);
  newTagName.value = "";
}

function save(): void {
  emit("save", { note: note.value.trim(), tags: [...selected.value] });
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ props.mode === "favorite" ? "编辑备注与标签" : "编辑备注与标签" }}</DialogTitle>
        <DialogDescription>{{ props.targetName }}</DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="space-y-1.5">
          <Label for="meta-note">备注</Label>
          <textarea
            id="meta-note"
            v-model="note"
            maxlength="500"
            rows="3"
            class="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-primary/40"
            placeholder="例如：发版前先找产品确认"
          />
        </div>

        <div class="space-y-1.5">
          <Label>标签</Label>
          <div class="flex flex-wrap gap-1.5 min-h-[24px]">
            <button
              v-for="name in selected"
              :key="name"
              data-test="selected-tag"
              class="text-[11px] px-2 py-0.5 rounded-full border"
              :style="{
                backgroundColor: tags.colorOf(name) + '33',
                color: tags.colorOf(name),
                borderColor: tags.colorOf(name) + 'aa',
              }"
              :title="`移除标签「${name}」`"
              @click="remove(name)"
            >
              {{ name }} ×
            </button>
            <span v-if="selected.length === 0" class="text-[11px] text-text-muted">还没有标签</span>
          </div>

          <div v-if="candidates.length > 0" class="flex flex-wrap gap-1.5 pt-1">
            <button
              v-for="name in candidates"
              :key="name"
              data-test="candidate-tag"
              class="text-[11px] px-2 py-0.5 rounded-full border border-border text-text-muted hover:text-text"
              @click="add(name)"
            >
              + {{ name }}
            </button>
          </div>
        </div>

        <div class="space-y-1.5 border-t border-border pt-3">
          <Label for="new-tag">新建标签</Label>
          <div class="flex items-center gap-2">
            <Input
              id="new-tag"
              v-model="newTagName"
              data-test="new-tag-name"
              class="h-8 w-32 text-xs"
              placeholder="标签名"
              maxlength="24"
            />
            <button
              v-for="c in TAG_PALETTE"
              :key="c"
              :data-test="`color-${c}`"
              class="w-4 h-4 rounded-full border"
              :class="c === newTagColor ? 'ring-2 ring-text/40' : ''"
              :style="{ backgroundColor: c, borderColor: c }"
              :title="c"
              @click="newTagColor = c"
            />
            <Button
              size="sm"
              data-test="add-tag"
              variant="outline"
              class="h-8"
              :disabled="!newTagName.trim()"
              @click="addNew"
            >
              添加
            </Button>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-between pt-2">
        <button
          data-test="open-tag-manager"
          class="text-[11px] text-text-muted hover:text-text underline underline-offset-2"
          @click="managerOpen = true"
        >
          管理标签（改名 / 改色 / 删除）
        </button>
        <div class="flex gap-2">
          <Button variant="outline" @click="emit('update:open', false)">取消</Button>
          <Button @click="save">保存</Button>
        </div>
      </div>
    </DialogContent>
  </Dialog>

  <TagManagerDialog :open="managerOpen" @update:open="(v: boolean) => (managerOpen = v)" />
</template>
