<script setup lang="ts">
import { ENVS } from "@/api/deploy";

defineProps<{ modelValue: number | null }>();
const emit = defineEmits<{ "update:modelValue": [number] }>();
</script>

<template>
  <div class="grid grid-cols-3 gap-2 max-w-[520px]">
    <button
      v-for="e in ENVS"
      :key="e.id"
      type="button"
      :class="[
        'px-3 py-2 rounded-md border text-xs text-left transition-colors',
        modelValue === e.id
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-border bg-surface hover:bg-surface-2',
      ]"
      @click="emit('update:modelValue', e.id)"
    >
      {{ e.name }}
    </button>
  </div>
</template>
