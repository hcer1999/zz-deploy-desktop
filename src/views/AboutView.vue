<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { arch, platform, version as osVersion } from "@tauri-apps/plugin-os";
import { useAppVersion } from "@/composables/useAppVersion";
import { CHANGELOG } from "@/data/changelog";
// 品牌 logo 的**原图**（assets/app-icon.png，1024×1024）：关于页要展示它本身，
// 而不是我们按它重绘的矢量标 —— 一个是品牌资产原件，一个是界面里用的标。
import appIconUrl from "../../assets/app-icon.png";

/*
 * 关于页：介绍 + 版本/构建时间/平台 + 更新日志。
 *
 * 版本号取运行时（tauri.conf.json 是唯一真值）；构建时间由 vite.config.ts 在构建时
 * 注入（`__BUILD_TIME__`），不能用运行时时间——那只是"你什么时候打开的应用"。
 */
const version = useAppVersion();
const platformLabel = ref("");
const buildTime = __BUILD_TIME__;

const buildTimeText = computed(() => {
  const d = new Date(buildTime);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
});

/** 只是介绍文案，不是功能清单的第二个真值来源（README 才是） */
const INTRO =
  "至真部署是内部运维平台 ITSM 的桌面客户端：接入原运维平台的部署功能，" +
  "并补上网页端做不到的桌面体验——实时构建日志、构建完成通知、日志本地留存与回看、批量部署。";

const HIGHLIGHTS = [
  "部署：自动化 / Docker，选环境 → 项目 → 分支 → Commit → 提交",
  "批量部署：跨环境/项目/分支攒一批再一次提交，整批只汇总一条通知",
  "构建日志：实时流式、语法高亮、查找定位，同时落盘留存",
  "任务列表：上线 / 回滚 / 失败重建 / 删除，自动轮询",
  "桌面能力：托盘、通知、快捷键、深浅主题",
];

onMounted(() => {
  try {
    const p = platform();
    platformLabel.value = `${p} ${arch()} · 系统 ${osVersion()}`;
  } catch {
    // 浏览器预览（没有 Tauri 运行时）时拿不到
  }
});
</script>

<template>
  <div class="p-6 overflow-auto">
    <div class="mx-auto w-full max-w-[720px] space-y-8">
      <!-- 品牌区：原图 logo + 名称 + 版本/构建时间/平台 -->
      <section class="flex items-start gap-5">
        <img
          :src="appIconUrl"
          alt="至真部署 图标原图"
          data-test="about-icon"
          class="size-[88px] shrink-0 rounded-[18px] shadow-sm"
        />
        <div class="min-w-0 pt-1">
          <h1 class="text-xl font-semibold tracking-[0.12em] text-brand">至真部署</h1>
          <p class="mt-1 text-xs text-text-muted">ITSM 部署桌面客户端</p>
          <dl class="mt-4 space-y-1 text-[11px]">
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-text-muted">版本</dt>
              <dd class="font-mono" data-test="about-version">v{{ version || "—" }}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-text-muted">构建时间</dt>
              <dd class="font-mono" data-test="about-build-time">{{ buildTimeText }}</dd>
            </div>
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-text-muted">运行环境</dt>
              <dd data-test="about-platform">{{ platformLabel || "—" }}</dd>
            </div>
          </dl>
        </div>
      </section>

      <!-- 介绍 -->
      <section class="space-y-3">
        <h2 class="text-sm font-semibold">介绍</h2>
        <p class="text-xs leading-relaxed text-text-muted">{{ INTRO }}</p>
        <ul class="space-y-1.5">
          <li v-for="h in HIGHLIGHTS" :key="h" class="flex items-start gap-2 text-xs">
            <span class="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand/70" />
            <span class="text-text-muted">{{ h }}</span>
          </li>
        </ul>
      </section>

      <!-- 更新日志 -->
      <section class="space-y-4">
        <h2 class="text-sm font-semibold">更新日志</h2>
        <article
          v-for="entry in CHANGELOG"
          :key="entry.version"
          data-test="changelog-entry"
          class="rounded-md border border-border bg-surface p-4"
        >
          <header class="flex items-baseline gap-3">
            <span class="text-sm font-semibold font-mono text-brand">v{{ entry.version }}</span>
            <span class="text-[11px] text-text-muted">{{ entry.date }}</span>
            <span class="text-[11px] text-text-muted truncate">· {{ entry.summary }}</span>
          </header>
          <ul class="mt-3 space-y-1.5">
            <li
              v-for="item in entry.items"
              :key="item"
              class="flex items-start gap-2 text-xs text-text-muted leading-relaxed"
            >
              <span class="mt-1.5 size-1 shrink-0 rounded-full bg-text-muted/50" />
              <span>{{ item }}</span>
            </li>
          </ul>
        </article>
      </section>
    </div>
  </div>
</template>
