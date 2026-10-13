<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import { Button } from "@/components/ui/button";

const appWindow = getCurrentWindow();
// macOS 用系统红绿灯，不渲染自绘按钮
const isMac = platform() === "macos";
</script>

<template>
  <div v-if="!isMac" class="flex items-stretch h-full">
    <Button
      variant="ghost"
      class="h-full w-11 rounded-none text-text-muted hover:bg-surface-2 hover:text-text"
      title="最小化"
      @click="appWindow.minimize()"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
      </svg>
    </Button>

    <Button
      variant="ghost"
      class="h-full w-11 rounded-none text-text-muted hover:bg-surface-2 hover:text-text"
      title="最大化"
      @click="appWindow.toggleMaximize()"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
    </Button>

    <Button
      variant="ghost"
      class="h-full w-11 rounded-none text-text-muted hover:bg-danger hover:text-white"
      title="关闭"
      @click="appWindow.close()"
    >
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
      </svg>
    </Button>
  </div>
</template>
