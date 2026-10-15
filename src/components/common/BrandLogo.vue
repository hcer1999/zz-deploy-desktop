<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
// reframe 导出的「draw-on」标（11.6KB）：青底 rect + 白线 path，两个元素各带
// `animation: … rf-draw` —— 先把描边画出来（dashoffset L→0），再交叉淡入填充。
// 注意导出是 **paused 且只播 1 次**（静态预览是空白），播放要由宿主来做，见下面的改写。
// `?raw` 构建期内联：静态自有资产、不是用户输入，v-html 无注入风险。
import markSvg from "@/assets/reframe-draw-on.svg?raw";

/*
 * 品牌标。
 *
 * - 正常：把 `paused` 改成 `running`，**播一次**（与导出里的 iteration=1 + fill-mode=both 一致）
 *   → 约 2s 画完，之后是稳定的青底白线标
 * - `animated=false` 或系统开了「减弱动态效果」：同样 un-pause，但把时长压到 1ms
 *   → 借资产自己的 100% 关键帧瞬间落到终态（青底 + 白线填充），而不是删动画
 *
 * 青色底由**资产自带的 rect** 提供（`fill="#00ADC3"`，与 token `--deploy-brand` 同值），
 * 容器不再上底色，否则会把 rect 的"画出来"效果盖掉。容器只负责尺寸与 12.5% 圆角
 * （与 App 图标实测圆角一致）。
 */
const props = withDefaults(defineProps<{ size?: number; animated?: boolean }>(), {
  size: 40,
  animated: true,
});

/** 系统是否要求减弱动态效果（随系统设置变化） */
const reduceMotion = ref(false);
let media: MediaQueryList | null = null;
const onMediaChange = (e: MediaQueryListEvent): void => {
  reduceMotion.value = e.matches;
};

onMounted(() => {
  if (typeof window.matchMedia !== "function") return;
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduceMotion.value = media.matches;
  media.addEventListener("change", onMediaChange);
});
onBeforeUnmount(() => media?.removeEventListener("change", onMediaChange));

const svgMarkup = computed(() => {
  // 导出里两个元素都是 paused（等宿主播放），必须改写内联 style —— 内联样式优先级高于样式表，
  // 没法用 :deep(...) 的 CSS 规则覆盖它。
  const running = markSvg.replace(/paused/g, "running");
  if (props.animated && !reduceMotion.value) return running;
  // 终态：把时长压到 1ms，1ms 后就是 100% 关键帧（填充完成、描边退场）
  return running.replace(/1\.867s/g, "0.001s");
});
</script>

<template>
  <div
    class="brand-mark overflow-hidden rounded-[12.5%]"
    :style="{ width: `${size}px`, height: `${size}px` }"
    data-test="brand-mark"
    role="img"
    aria-label="至真部署"
    v-html="svgMarkup"
  />
</template>

<style scoped>
/* v-html 进来的 svg 不在 scoped 作用域内，用 :deep 把尺寸铺满（资产自身也带了 width:100%） */
.brand-mark :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
