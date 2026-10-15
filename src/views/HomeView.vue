<script setup lang="ts">
import type { Component } from "vue";
import {
  History,
  Info,
  Layers,
  List,
  Plus,
  Settings,
  Star,
} from "@lucide/vue";
import { useTabsStore, type TabKind } from "@/stores/tabs";
import { useAppVersion } from "@/composables/useAppVersion";
import BrandLogo from "@/components/common/BrandLogo.vue";

/*
 * 首页（启动屏）：没有打开任何标签时占满内容区。
 *
 * 它不是"空状态提示"，而是**启动器**——常用入口摆在这里，一眼能看到从哪开始，
 * 也不用先去侧栏找。点击即打开对应标签（与侧栏、快捷键同一套 tabs.open）。
 *
 * 与启动遮罩（WelcomeView）的分工：那个只在应用启动、登录状态未定型时挡一下；
 * 这个是你关掉所有标签后的落脚点，所以内容更实用，logo 动画也只在挂载时跑一遍。
 */
const tabs = useTabsStore();
const version = useAppVersion();

interface Card {
  kind: TabKind;
  icon: Component;
  title: string;
  desc: string;
}

/** 顺序与侧栏一致；「关于」不占卡片位，放右下角当次级入口 */
const CARDS: Card[] = [
  {
    kind: "wizard",
    icon: Plus,
    title: "新建部署",
    desc: "选环境 → 项目 → 分支 → Commit，提交即构建",
  },
  {
    kind: "batch",
    icon: Layers,
    title: "批量部署",
    desc: "跨环境/项目/分支攒一批，整批只汇总一条通知",
  },
  {
    kind: "favorites",
    icon: Star,
    title: "收藏",
    desc: "常用的项目与分支一键复用，可筛选与拖动排序",
  },
  {
    kind: "list",
    icon: List,
    title: "任务列表",
    desc: "上线 / 回滚 / 失败重建 / 删除，自动轮询",
  },
  {
    kind: "history",
    icon: History,
    title: "历史日志",
    desc: "本地留存的构建日志：搜索、展开、导出",
  },
  {
    kind: "settings",
    icon: Settings,
    title: "设置",
    desc: "地址、主题、通知、轮询间隔与日志保留",
  },
];

const SHORTCUTS = [
  "⌘/Ctrl + N 新建部署",
  "⌘/Ctrl + 1…7 切换页面",
  "⌘/Ctrl + R 刷新",
  "⌘/Ctrl + , 设置",
];
</script>

<template>
  <div class="relative h-full overflow-auto">
    <!-- 主题色柔光：与欢迎页/登录页同一手法，三处视觉连续 -->
    <div
      class="pointer-events-none absolute left-1/2 top-[86px] -translate-x-1/2 size-[360px] rounded-full bg-primary/[0.07] blur-3xl"
      aria-hidden="true"
    />

    <div class="relative mx-auto flex min-h-full w-full max-w-[880px] flex-col justify-center px-8 py-10">
      <!-- 品牌头：logo 入场动画 + 品牌色名称 + 版本 -->
      <header class="flex items-center gap-4">
        <BrandLogo :size="64" class="shadow-sm" />
        <div>
          <h1 class="text-xl font-semibold tracking-[0.14em] text-brand">至真部署</h1>
          <p class="mt-1 text-xs text-text-muted">
            ITSM 部署桌面客户端<span v-if="version"> · v{{ version }}</span>
          </p>
        </div>
      </header>

      <!-- 快捷入口 -->
      <div class="mt-9 grid grid-cols-2 lg:grid-cols-3 gap-3">
        <button
          v-for="c in CARDS"
          :key="c.kind"
          :data-test="`home-${c.kind}`"
          class="group text-left rounded-lg border border-border bg-surface p-4 transition-colors hover:border-primary/40 hover:bg-surface-2"
          @click="tabs.open({ kind: c.kind })"
        >
          <div class="flex items-center gap-2">
            <span
              class="size-8 shrink-0 rounded-md bg-primary/10 text-primary flex items-center justify-center"
            >
              <component :is="c.icon" :size="16" :stroke-width="1.8" />
            </span>
            <span class="text-sm font-medium">{{ c.title }}</span>
          </div>
          <p class="mt-2.5 text-[11px] leading-relaxed text-text-muted">{{ c.desc }}</p>
        </button>
      </div>

      <!-- 快捷键提示 + 次级入口 -->
      <footer class="mt-9 flex flex-wrap items-end justify-between gap-4">
        <ul class="flex flex-wrap gap-x-5 gap-y-1.5">
          <li v-for="s in SHORTCUTS" :key="s" class="text-[11px] text-text-muted font-mono">
            {{ s }}
          </li>
        </ul>
        <button
          data-test="home-about"
          class="flex items-center gap-1.5 text-[11px] text-text-muted hover:text-text"
          @click="tabs.open({ kind: 'about' })"
        >
          <Info :size="13" />
          关于与更新日志
        </button>
      </footer>
    </div>
  </div>
</template>
