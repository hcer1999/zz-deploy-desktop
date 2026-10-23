<script setup lang="ts">
import { computed } from "vue";
import { RefreshCw, X } from "@lucide/vue";
import { useUpdateStore } from "@/stores/update";

/**
 * 发现新版本时的顶部提示条。
 *
 * 更新在客户端内完成：点「立即更新」后下载并安装（Tauri 签名校验），
 * 完成后提示重启；不需要用户再去浏览器下载安装包。
 */
const update = useUpdateStore();

const notesPreview = computed(() => {
  const notes = update.info?.notes.trim();
  if (!notes) return "";
  // 只取第一行：完整更新说明在发布页里看
  return notes.split("\n")[0].slice(0, 120);
});

const progressText = computed(() => {
  if (update.phase === "installing") return "正在安装…";
  if (update.total > 0) return `正在下载 ${update.progress}%`;
  return "正在下载…";
});
</script>

<template>
  <div
    v-if="update.showBanner"
    data-test="update-banner"
    class="flex shrink-0 items-center gap-2 border-b border-brand/30 bg-brand/10 px-3 py-1.5 text-[11px]"
  >
    <RefreshCw
      :size="13"
      :class="['shrink-0 text-brand', update.installing ? 'animate-spin' : '']"
    />

    <template v-if="update.installed">
      <span class="shrink-0 text-text">
        新版本 <span class="font-semibold">v{{ update.info?.latestVersion }}</span> 已安装
      </span>
      <span class="min-w-0 flex-1 truncate text-text-muted">重启应用后生效</span>
      <button
        data-test="update-restart"
        class="shrink-0 rounded px-2 py-0.5 text-brand hover:bg-brand/10"
        @click="update.restart()"
      >
        立即重启
      </button>
    </template>

    <template v-else-if="update.installing">
      <span class="shrink-0 text-text">正在更新到 v{{ update.info?.latestVersion }}</span>
      <span class="min-w-0 flex-1 truncate text-text-muted">{{ progressText }}</span>
      <span class="w-24 shrink-0 overflow-hidden rounded-full bg-surface-2">
        <span
          class="block h-1 rounded-full bg-brand transition-[width]"
          :style="{ width: update.total > 0 ? `${update.progress}%` : '30%' }"
        />
      </span>
    </template>

    <template v-else>
      <span class="shrink-0 text-text">
        发现新版本 <span class="font-semibold">v{{ update.info?.latestVersion }}</span>
      </span>
      <span v-if="notesPreview" class="min-w-0 flex-1 truncate text-text-muted">
        {{ notesPreview }}
      </span>
      <span v-else class="flex-1" />
      <button
        data-test="update-install"
        class="shrink-0 rounded px-2 py-0.5 text-brand hover:bg-brand/10"
        @click="update.install()"
      >
        立即更新
      </button>
      <button
        data-test="update-dismiss"
        class="shrink-0 rounded px-2 py-0.5 text-text-muted hover:bg-surface-2"
        title="忽略这个版本"
        @click="update.dismiss()"
      >
        忽略
      </button>
      <button
        class="shrink-0 rounded p-0.5 text-text-muted hover:bg-surface-2"
        title="关闭"
        @click="update.dismiss()"
      >
        <X :size="12" />
      </button>
    </template>

    <span v-if="update.error" class="shrink-0 text-danger">{{ update.error }}</span>
  </div>
</template>
