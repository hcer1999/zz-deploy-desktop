<script setup lang="ts">
import type { ContextMenuTriggerProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ContextMenuTrigger } from "reka-ui"
import { cn } from "@/lib/utils"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ContextMenuTriggerProps & { class?: HTMLAttributes["class"] }>()

// class 单独摘出来再 cn：reka-ui 会把 class 直接落到触发元素上，
// 不摘的话和外部传入的 class 打架
const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <ContextMenuTrigger
    data-slot="context-menu-trigger"
    v-bind="{ ...$attrs, ...delegatedProps }"
    :class="cn(props.class)"
  >
    <slot />
  </ContextMenuTrigger>
</template>
