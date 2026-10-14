<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";
import WindowControls from "./WindowControls.vue";

const isMac = platform() === "macos";
// macOS 的 Overlay 模式下红绿灯占据左上角，需留出空间避免内容被压住
const leftPad = isMac ? "pl-[76px]" : "pl-3";

const version = ref("");

/**
 * 标题 = 名称 + 运行时版本。
 *
 * 版本取自 `getVersion()`（真值在 tauri.conf.json），而不是写死在模板或
 * tauri.conf.json 的 window.title 里：否则升版本时三处（标题、包名、关于页）
 * 迟早会漂移。原生窗口标题（Dock / 任务栏 / 窗口菜单）用同一份拼出来。
 */
function titleText(v: string): string {
  return v ? `至真部署-桌面版 Ver${v}` : "至真部署-桌面版";
}

onMounted(async () => {
  version.value = await getVersion();
  try {
    await getCurrentWindow().setTitle(titleText(version.value));
  } catch {
    // 权限缺失或非 Tauri 环境（如单测/浏览器预览）时忽略：标题栏本身照常显示
  }
});
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
      <span data-tauri-drag-region>{{ titleText(version) }}</span>
    </div>
    <WindowControls />
  </div>
</template>
