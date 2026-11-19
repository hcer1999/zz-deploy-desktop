<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Project } from "@/api/parser";
import { Button } from "@/components/ui/button";

/**
 * 项目选择网格。
 *
 * 为什么不做成下拉：项目数量少、名字短，网格能"一眼扫全"，比逐字搜索快。
 * 代价是溢出时看不出来还能滚（macOS 覆盖式滚动条不滚动就不显示），
 * 所以这里补三件事：计数、底部渐隐、滚动提示胶囊。
 */
const props = withDefaults(
  defineProps<{
    projects: Project[];
    selectedId: number | null;
    maxHeightClass?: string;
  }>(),
  { maxHeightClass: "max-h-[240px]" },
);

const emit = defineEmits<{ pick: [project: Project] }>();

const scroller = ref<HTMLElement | null>(null);
const hasMore = ref(false);
let observer: ResizeObserver | undefined;

/** 底部还剩多少像素没露出来；留 4px 容差，避免亚像素误差让提示一直闪 */
function recompute(): void {
  const el = scroller.value;
  if (!el) return;
  hasMore.value = el.scrollHeight - el.scrollTop - el.clientHeight > 4;
}

const onScroll = (): void => recompute();

onMounted(() => {
  scroller.value?.addEventListener("scroll", onScroll, { passive: true });
  // 尺寸变化的来源有两个：容器自身（窗口缩放）与内容（筛选/重新加载）。
  // jsdom 里没有 ResizeObserver，测试环境直接跳过。
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(onScroll);
    if (scroller.value) observer.observe(scroller.value);
  }
  void nextTick(recompute);
});

onBeforeUnmount(() => {
  scroller.value?.removeEventListener("scroll", onScroll);
  observer?.disconnect();
  observer = undefined;
});

watch(
  () => props.projects,
  () => void nextTick(recompute),
  { flush: "post" },
);

/** 选中项可能被筛选挤到视口外，选完顺手带回来 */
watch(
  () => props.selectedId,
  () =>
    void nextTick(() => {
      scroller.value
        ?.querySelector<HTMLElement>('[data-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }),
);
</script>

<template>
  <div class="relative">
    <div
      ref="scroller"
      data-test="project-scroll"
      :class="['flex flex-wrap gap-2 overflow-auto p-1', maxHeightClass]"
    >
      <Button
        v-for="p in projects"
        :key="p.id"
        :data-test="`pick-${p.id}`"
        :data-selected="selectedId === p.id"
        :variant="selectedId === p.id ? 'default' : 'secondary'"
        size="sm"
        class="text-xs"
        @click="emit('pick', p)"
      >
        {{ p.name }}
      </Button>
    </div>

    <!-- 渐隐只做视觉提示，必须让点击穿透，否则最后一行按钮点不到 -->
    <div
      v-if="hasMore"
      data-test="grid-fade"
      class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-bg to-transparent"
    />
    <div
      v-if="hasMore"
      data-test="grid-more"
      class="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-muted shadow"
    >
      共 {{ projects.length }} 个项目 · 继续向下滚动
    </div>
  </div>
</template>
