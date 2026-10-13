<script setup lang="ts">
import TitleBar from "./components/layout/TitleBar.vue";
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />
    <div class="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted">
      <p class="text-sm">标题栏验证</p>
      <ul class="text-xs space-y-1 list-disc list-inside">
        <li>拖动标题栏空白处应能移动窗口</li>
        <li>macOS：左上角红绿灯可见且未被内容遮挡</li>
        <li>Windows / Linux：右上角三个按钮分别能最小化 / 最大化 / 关闭</li>
      </ul>
    </div>
  </div>
</template>
