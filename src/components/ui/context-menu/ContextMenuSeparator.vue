<script setup lang="ts">
import type { ContextMenuSeparatorProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { ContextMenuSeparator } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<ContextMenuSeparatorProps & { class?: HTMLAttributes["class"] }>()
</script>

<template>
  <ContextMenuSeparator
    data-slot="context-menu-separator"
    v-bind="props"
    :class="cn('my-1 h-px bg-border', props.class)"
  />
</template>
