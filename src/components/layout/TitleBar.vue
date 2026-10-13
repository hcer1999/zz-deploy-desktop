<script setup lang="ts">
import { platform } from "@tauri-apps/plugin-os";
import WindowControls from "./WindowControls.vue";

const isMac = platform() === "macos";
// macOS 的 Overlay 模式下红绿灯占据左上角，需留出空间避免内容被压住
const leftPad = isMac ? "pl-[76px]" : "pl-3";
</script>

<template>
  <div
    data-tauri-drag-region
    :class="[
      'h-10 shrink-0 flex items-stretch justify-between border-b border-border bg-surface select-none',
      leftPad,
    ]"
  >
    <!-- data-tauri-drag-region 需覆盖内部文本节点，否则拖拽区域会被文字切断 -->
    <div data-tauri-drag-region class="flex items-center gap-2 text-xs text-text-muted">
      <span data-tauri-drag-region>至真部署</span>
    </div>
    <WindowControls />
  </div>
</template>
