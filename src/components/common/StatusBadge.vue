<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ text: string; kind?: "auto" | "build" }>();

/** 服务端只给文案不给结构化状态，只能按关键字判断语气 */
const tone = computed(() => {
  const t = props.text ?? "";
  if (t.includes("成功")) return "success";
  if (t.includes("失败")) return "danger";
  if (t.includes("中") || t.includes("进行")) return "warning";
  return "neutral";
});

const classes = computed(() => {
  switch (tone.value) {
    case "success":
      return "bg-success/15 text-success border-success/30";
    case "danger":
      return "bg-danger/15 text-danger border-danger/30";
    case "warning":
      return "bg-warning/15 text-warning border-warning/30";
    default:
      return "bg-surface-2 text-text-muted border-border";
  }
});
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] whitespace-nowrap',
      classes,
    ]"
  >
    <span v-if="tone === 'warning'" class="size-1.5 rounded-full bg-current animate-pulse" />
    {{ text || "—" }}
  </span>
</template>
