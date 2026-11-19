<script setup lang="ts">
import { computed } from "vue";
import { useTagsStore } from "@/stores/tags";

/**
 * 标签筛选条。
 *
 * 只负责"选了哪些标签"，不决定筛选语义：多个标签怎么组合（AND / OR）
 * 由父组件的过滤逻辑决定——收藏页与批量页都用 AND（收窄），但这不该写死在展示组件里。
 */
const props = defineProps<{ modelValue: string[]; available: string[] }>();
const emit = defineEmits<{ "update:modelValue": [string[]] }>();

const tags = useTagsStore();

const selected = computed(() => new Set(props.modelValue));

function toggle(name: string): void {
  const next = selected.value.has(name)
    ? props.modelValue.filter((t) => t !== name)
    : [...props.modelValue, name];
  emit("update:modelValue", next);
}
</script>

<template>
  <div v-if="available.length > 0" class="flex flex-wrap items-center gap-1.5">
    <button
      v-for="name in available"
      :key="name"
      data-test="tag-chip"
      :class="[
        'text-[11px] px-2 py-0.5 rounded-full border transition-colors',
        selected.has(name) ? 'font-medium' : 'opacity-70 hover:opacity-100',
      ]"
      :style="{
        backgroundColor: tags.colorOf(name) + (selected.has(name) ? '33' : '14'),
        color: tags.colorOf(name),
        borderColor: tags.colorOf(name) + (selected.has(name) ? 'aa' : '44'),
      }"
      @click="toggle(name)"
    >
      {{ name }}
    </button>
    <button
      v-if="modelValue.length > 0"
      data-test="clear-tag-filter"
      class="text-[11px] text-text-muted hover:text-text underline underline-offset-2"
      @click="emit('update:modelValue', [])"
    >
      清除标签筛选
    </button>
  </div>
</template>
