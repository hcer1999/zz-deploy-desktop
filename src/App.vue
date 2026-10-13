<script setup lang="ts">
import { ref } from "vue";

// Task 2 的验证用临时页面：确认设计 token 能生成工具类并随 .dark 切换。
// Task 4 会把它替换为标题栏版本。
const dark = ref(false);
function toggle(): void {
  dark.value = !dark.value;
  document.documentElement.classList.toggle("dark", dark.value);
}
</script>

<template>
  <div class="h-full flex flex-col items-center justify-center gap-6 bg-bg text-text">
    <div class="p-8 rounded-lg border border-border bg-surface">
      <h1 class="text-lg font-semibold mb-4">设计 token 验证</h1>
      <div class="flex gap-3">
        <span class="px-2 py-1 rounded text-xs bg-primary text-primary-foreground">primary</span>
        <span class="px-2 py-1 rounded text-xs bg-success text-primary-foreground">success</span>
        <span class="px-2 py-1 rounded text-xs bg-warning text-primary-foreground">warning</span>
        <span class="px-2 py-1 rounded text-xs bg-danger text-primary-foreground">danger</span>
      </div>
      <p class="mt-4 text-xs text-text-muted">text-muted 令牌</p>
      <div class="mt-4 p-3 rounded bg-surface-2 border border-border">surface-2</div>
    </div>
    <button class="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm" @click="toggle">
      切换到{{ dark ? "浅色" : "深色" }}模式
    </button>
  </div>
</template>
