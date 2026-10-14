<script setup lang="ts">
import { computed, ref } from "vue";
import {
  ComboboxAnchor,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxPortal,
  ComboboxRoot,
  ComboboxTrigger,
  ComboboxViewport,
  ComboboxContent,
} from "reka-ui";
import { Check, ChevronDown } from "@lucide/vue";
import { cn } from "@/lib/utils";

/**
 * 可搜索下拉。
 *
 * 为什么不用原生 `<select>`：commit message 很长、选项可能几十上百条，
 * 原生下拉既不好看也不能搜索（spec §5.4 原本就写着「可搜索下拉」）。
 * 为什么不用 `ui/select`：那是 reka-ui 的 Select，只有键入定位、没有过滤，
 * 且塞不进一个真正的搜索输入框；Combobox 才是为这个场景设计的。
 *
 * 交互：输入框本身既是搜索框也显示已选项（失焦时显示 label，聚焦时显示搜索词）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: { value: string; label: string }[];
    placeholder?: string;
    emptyText?: string;
    disabled?: boolean;
    class?: string;
  }>(),
  {
    placeholder: "请选择",
    emptyText: "没有匹配项",
    disabled: false,
  },
);

const emit = defineEmits<{ "update:modelValue": [string] }>();

const open = ref(false);
const searchTerm = ref("");

const selectedLabel = computed(
  () => props.options.find((o) => o.value === props.modelValue)?.label ?? "",
);

/** 失焦时输入框显示选中项的完整文本；聚焦时显示搜索词（reka-ui 的 displayValue 约定） */
function displayValue(): string {
  return selectedLabel.value;
}

function onSelect(value: unknown): void {
  emit("update:modelValue", value === undefined || value === null ? "" : String(value));
  open.value = false;
}

defineExpose({ open, searchTerm });
</script>

<template>
  <ComboboxRoot
    v-model:open="open"
    v-model:search-term="searchTerm"
    :model-value="modelValue"
    :disabled="disabled"
    :reset-search-term-on-select="true"
    class="w-full"
    @update:model-value="onSelect"
  >
    <ComboboxAnchor as-child>
      <div
        :class="
          cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 text-xs',
            'focus-within:ring-2 focus-within:ring-primary/40',
            disabled ? 'opacity-50 cursor-not-allowed' : '',
            props.class,
          )
        "
      >
        <ComboboxInput
          :display-value="displayValue"
          :placeholder="placeholder"
          :disabled="disabled"
          class="min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-muted"
          @click="open = true"
          @focus="open = true"
        />
        <ComboboxTrigger :disabled="disabled" aria-label="展开选项">
          <ChevronDown :size="14" class="shrink-0 text-text-muted" />
        </ComboboxTrigger>
      </div>
    </ComboboxAnchor>

    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        class="z-50 max-h-[280px] min-w-[var(--reka-combobox-trigger-width)] overflow-hidden rounded-md border border-border bg-popover text-text shadow-md"
      >
        <ComboboxViewport class="max-h-[280px] overflow-y-auto p-1">
          <ComboboxEmpty class="px-2 py-3 text-center text-[11px] text-text-muted">
            {{ emptyText }}
          </ComboboxEmpty>

          <ComboboxItem
            v-for="o in options"
            :key="o.value"
            :value="o.value"
            :text-value="o.label"
            class="relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pl-6 pr-2 text-xs outline-hidden select-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-text"
          >
            <span class="absolute left-1.5 flex size-3.5 items-center justify-center">
              <ComboboxItemIndicator>
                <Check :size="12" />
              </ComboboxItemIndicator>
            </span>
            <span class="truncate font-mono text-[11px]" :title="o.label">{{ o.label }}</span>
          </ComboboxItem>
        </ComboboxViewport>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
