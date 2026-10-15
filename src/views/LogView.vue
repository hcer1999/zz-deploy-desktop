<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDown, ChevronUp, Search, X } from "@lucide/vue";
import { openLog } from "@/stores/tabPayload";
import { useLogsStore } from "@/stores/logs";
import { useTabsStore } from "@/stores/tabs";
import {
  highlightLineCached,
  markMatches,
  SEARCH_CURRENT_CLS,
  SEARCH_HIT_CLS,
  type LogSegment,
} from "@/lib/logHighlight";
import { Button } from "@/components/ui/button";

const props = defineProps<{ tabId: string }>();

const logs = useLogsStore();
const tabs = useTabsStore();
const outputRef = ref<HTMLElement | null>(null);
const searchRef = ref<HTMLInputElement | null>(null);
const autoScroll = ref(true);
const sessionId = ref("");
const error = ref("");

/** 搜索：按「匹配行」计数与跳转（终端里也是按行给反馈，比按字符数好数） */
const query = ref("");
const currentMatch = ref(0);

const session = computed(() => (sessionId.value ? logs.sessions[sessionId.value] : undefined));

/** 本标签当前是否可见（TabHost 用 v-show 隐藏非激活标签） */
const isActive = computed(() => tabs.activeId === props.tabId);

const lines = computed(() => session.value?.buffer.lines ?? []);
/**
 * 还在刷新中的"当前行"。
 *
 * 进度条是用「回行首重画」刷的（`\r` / `ESC[2K ESC[1G`），这类帧不会进 lines，
 * 只替换 buffer.pending。不把它显示出来，yarn/next 那种一刷几分钟的阶段
 * 界面会一片空白（看着像卡住）。
 */
const pendingText = computed(() => session.value?.buffer.pending ?? "");

/** 命中的行下标（用于计数与跳转） */
const matchLines = computed<number[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  lines.value.forEach((l, i) => {
    if (l.text.toLowerCase().includes(q)) out.push(i);
  });
  return out;
});
const currentLine = computed(() =>
  matchLines.value.length ? matchLines.value[Math.min(currentMatch.value, matchLines.value.length - 1)] : -1,
);

/** 每行的渲染片段：语法高亮 + 搜索命中（当前那行用更亮的底色） */
function segmentsOf(index: number, text: string): LogSegment[] {
  const segs = highlightLineCached(text);
  const q = query.value.trim();
  if (!q) return segs;
  return segs.flatMap((s) =>
    markMatches(s.text, q, s.cls).map((hit) =>
      // 当前行整体换底色：把命中色的类名换成更亮的那套
      index === currentLine.value && hit.cls.includes(SEARCH_HIT_CLS)
        ? { ...hit, cls: hit.cls.replace(SEARCH_HIT_CLS, SEARCH_CURRENT_CLS) }
        : hit,
    ),
  );
}

/** 跳到第 n 个匹配行（并按需关掉自动滚动，否则新日志会把视线拉回底部） */
async function gotoMatch(index: number): Promise<void> {
  if (!matchLines.value.length) return;
  const n = matchLines.value.length;
  currentMatch.value = ((index % n) + n) % n;
  autoScroll.value = false;
  await nextTick();
  const el = outputRef.value;
  const target = el?.querySelector<HTMLElement>(`[data-line="${currentLine.value}"]`);
  if (!el || !target) return;
  const top = target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  el.scrollTop = Math.max(0, top - el.clientHeight / 3);
}

function clearSearch(): void {
  query.value = "";
  currentMatch.value = 0;
}

/** 输入变化：回到第一个命中 */
watch(query, () => {
  currentMatch.value = 0;
  if (query.value.trim()) void gotoMatch(0);
});

/**
 * Cmd/Ctrl+F 聚焦搜索框（浏览器的"页内查找"在这里没用，日志在自己的滚动容器里）。
 * 只在标签可见时接管，且不 preventDefault 掉其它快捷键。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!isActive.value) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    searchRef.value?.focus();
    searchRef.value?.select();
  }
}

/** 标签在 log_open 返回前就被关掉时置位，拿到 sessionId 后立即释放连接 */
let disposed = false;

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  const payload = openLog(props.tabId);
  if (!payload) {
    error.value = "日志标签缺少任务信息";
    return;
  }
  try {
    const sid = await logs.open(payload);
    if (disposed) {
      // 关标签时 Rust 还没返回 sessionId（tabs.close 的 closeByTask 自然拿不到它），
      // 这里补一刀，不然会在 Rust 侧留下一个没人看的长连接
      void logs.close(sid);
      return;
    }
    sessionId.value = sid;
  } catch (e) {
    error.value = String(e);
  }
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener("keydown", onKeydown);
});

/**
 * 滚到底部（关闭自动滚动时保留用户位置）。
 *
 * `scrollHeight === 0` 时**不写**：标签被 v-show 隐藏（display:none）时它恒为 0，
 * 写进去等于把位置丢回顶部。
 */
async function scrollToBottom(): Promise<void> {
  if (!autoScroll.value) return;
  await nextTick();
  const el = outputRef.value;
  if (el && el.scrollHeight > 0) el.scrollTop = el.scrollHeight;
}

// 新行与"当前行"的刷新都要跟随（否则进度阶段停在原地，看不见最新一帧）
watch([() => session.value?.buffer.lines.length, pendingText], scrollToBottom);

/**
 * 切回本标签时补一次滚到底。
 *
 * 后台标签里收到的日志**滚不动**：隐藏时 display:none 让 scrollHeight 为 0，
 * 那些滚动写入全部无效（位置停在顶部），而日志一直在后台流入。
 * 没有这一刀，切回来就会定在最上面——真实 Chromium 实测复现：
 * 后台收满 300 行后切回，scrollTop=0 且不在底部；
 * 而先切回来再收日志（新建标签）是正常的（scrollTop 在底部）。
 */
watch(isActive, (active) => {
  if (active) void scrollToBottom();
});

const STATE_TEXT: Record<string, string> = {
  connecting: "连接中…",
  connected: "已连接",
  disconnected: "已断开",
  finished: "已完成",
  error: "连接错误",
};

const STATE_CLASS: Record<string, string> = {
  connecting: "bg-white/10 text-white/60",
  connected: "bg-emerald-500/15 text-emerald-400",
  finished: "bg-emerald-500/15 text-emerald-400",
  disconnected: "bg-amber-500/15 text-amber-400",
  error: "bg-red-500/15 text-red-400",
};

function clear(): void {
  const s = session.value;
  if (!s) return;
  s.buffer.lines.splice(0, s.buffer.lines.length);
  s.buffer.progressIndex.clear();
}

function copyAll(): void {
  const text = session.value?.buffer.lines.map((l) => l.text).join("\n") ?? "";
  void navigator.clipboard.writeText(text);
}
</script>

<template>
  <!--
    日志区固定用近黑 + 等宽的终端风格（spec §5：风格 C 只在日志标签局部使用），
    不跟随深浅主题——终端本来就是深的。
  -->
  <div class="h-full flex flex-col bg-[#0b0d12] text-[#d4d4d4]">
    <div class="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
      <span class="text-sm font-medium">
        构建日志 · {{ session?.projectName ?? "…" }}
      </span>
      <span v-if="session?.envName" class="text-[11px] text-white/50">{{ session.envName }}</span>
      <span class="flex-1" />
      <span
        :class="[
          'text-[11px] px-2 py-0.5 rounded-full',
          STATE_CLASS[session?.state ?? 'connecting'],
        ]"
      >
        {{ STATE_TEXT[session?.state ?? "connecting"] }}
      </span>
      <!-- 服务端拒绝时把它的原话显示出来（例：“数据格式错误”），不再静默失败 -->
      <span
        v-if="session?.detail"
        class="text-[11px] text-amber-400/90 max-w-[280px] truncate"
        :title="session?.detail"
      >
        服务端：{{ session?.detail }}
      </span>
      <!-- 搜索：只在本标签内查找，命中行高亮、Enter/Shift+Enter 上下跳 -->
      <div class="flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 h-6">
        <Search :size="12" class="text-white/50 shrink-0" />
        <input
          ref="searchRef"
          v-model="query"
          data-test="log-search"
          placeholder="查找（⌘F）"
          class="w-40 bg-transparent text-[11px] outline-none placeholder:text-white/35"
          @keydown.enter.exact.prevent="gotoMatch(currentMatch + 1)"
          @keydown.enter.shift.prevent="gotoMatch(currentMatch - 1)"
          @keydown.esc.prevent="clearSearch"
        />
        <span v-if="query" class="text-[10px] text-white/50 whitespace-nowrap tabular-nums">
          {{ matchLines.length ? currentMatch + 1 : 0 }}/{{ matchLines.length }}
        </span>
        <button
          v-if="query"
          data-test="search-prev"
          class="text-white/50 hover:text-white disabled:opacity-30"
          :disabled="matchLines.length === 0"
          title="上一个（Shift+Enter）"
          @click="gotoMatch(currentMatch - 1)"
        >
          <ChevronUp :size="12" />
        </button>
        <button
          v-if="query"
          data-test="search-next"
          class="text-white/50 hover:text-white disabled:opacity-30"
          :disabled="matchLines.length === 0"
          title="下一个（Enter）"
          @click="gotoMatch(currentMatch + 1)"
        >
          <ChevronDown :size="12" />
        </button>
        <button
          v-if="query"
          data-test="search-clear"
          class="text-white/50 hover:text-white"
          title="清除（Esc）"
          @click="clearSearch"
        >
          <X :size="12" />
        </button>
      </div>
      <label class="flex items-center gap-1.5 text-[11px] text-white/60">
        <input v-model="autoScroll" type="checkbox" />
        自动滚动
      </label>
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="clear">清空</Button>
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="copyAll">
        复制
      </Button>
    </div>

    <p v-if="error" class="px-4 py-2 text-xs text-red-400">{{ error }}</p>

    <div
      ref="outputRef"
      class="flex-1 min-h-0 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed"
    >
      <div
        v-for="(l, index) in lines"
        :key="l.id"
        :data-line="index"
        :class="[
          'whitespace-pre-wrap break-all rounded-sm',
          l.updates > 1 ? 'opacity-80' : '',
          index === currentLine ? 'bg-white/5' : '',
        ]"
      >
        <!-- 语法高亮 + 搜索命中；内容来自构建输出，一律走文本节点，不拼 HTML -->
        <span v-for="(seg, i) in segmentsOf(index, l.text)" :key="i" :class="seg.cls">{{
          seg.text
        }}</span>
      </div>
      <!-- 还在刷新的那一行：重画式进度条（yarn / next.js）就靠这里保持可见 -->
      <div v-if="pendingText" data-test="live-line" class="whitespace-pre-wrap break-all">
        <span v-for="(seg, i) in highlightLineCached(pendingText)" :key="i" :class="seg.cls">{{
          seg.text
        }}</span><span class="text-white/30 animate-pulse">▌</span>
      </div>
      <div v-if="!lines.length && !pendingText && !error" class="text-white/40">
        等待日志输出…
      </div>
    </div>
  </div>
</template>
