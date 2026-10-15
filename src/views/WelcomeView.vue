<script setup lang="ts">
import { onMounted, ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";
import BrandLogo from "@/components/common/BrandLogo.vue";

/*
 * 欢迎页（启动遮罩）。
 *
 * 存在的理由有两个，主次分明：
 * 1. **遮挡登录页闪屏**：Rust 静默续登期间前端还不知道"到底登录没有"，
 *    直接渲染登录页会让已登录的人每次开软件都看到登录表单闪一下。
 * 2. 顺便当品牌页：logo 线条动画 + 「至真部署」用主题色显示（跟随浅/深主题与强调色）。
 *
 * 视觉刻意与主界面同一套 token（bg / text / primary），不引入新颜色；
 * 也刻意**不覆盖标题栏**，欢迎阶段窗口仍可拖动。
 */
const version = ref("");
onMounted(async () => {
  try {
    version.value = await getVersion();
  } catch {
    // 浏览器里预览（没有 Tauri 运行时）时拿不到版本，留空即可
  }
});
</script>

<template>
  <div class="relative flex-1 min-h-0 flex flex-col items-center justify-center overflow-hidden">
    <!-- 主题色柔光背景：给中间的 logo 一点纵深 -->
    <div
      class="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 size-[300px] rounded-full bg-primary/[0.08] blur-3xl"
      aria-hidden="true"
    />

    <div class="relative flex flex-col items-center">
      <!-- 品牌标：青底白线，一笔画完并闭合（prefers-reduced-motion 下直接显示完成态） -->
      <BrandLogo :size="96" class="shadow-sm" />

      <!-- 品牌名用品牌色（--deploy-brand，不随主题变） -->
      <h1 class="mt-6 text-2xl font-semibold tracking-[0.2em] text-brand">至真部署</h1>
      <p class="mt-1.5 text-xs text-text-muted">ITSM 部署桌面客户端</p>

      <!-- 不定进度条：一条来回滑动的主题色光条 -->
      <div class="mt-9 h-0.5 w-40 overflow-hidden rounded-full bg-surface-2">
        <div class="h-full w-1/3 rounded-full bg-primary animate-indeterminate" />
      </div>
      <p class="mt-3 text-[11px] text-text-muted">正在检查登录状态…</p>
    </div>

    <span v-if="version" class="absolute bottom-4 right-5 text-[10px] text-text-muted/70">
      v{{ version }}
    </span>
  </div>
</template>
