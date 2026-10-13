<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { openLog } from "@/stores/tabPayload";
import { useLogsStore } from "@/stores/logs";
import { Button } from "@/components/ui/button";

const props = defineProps<{ tabId: string }>();

const logs = useLogsStore();
const outputRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const sessionId = ref("");
const error = ref("");

const session = computed(() => (sessionId.value ? logs.sessions[sessionId.value] : undefined));

/** 标签在 log_open 返回前就被关掉时置位，拿到 sessionId 后立即释放连接 */
let disposed = false;

onMounted(async () => {
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
});

// 自动滚动到底部（关闭时保留用户位置）
watch(
  () => session.value?.buffer.lines.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    const el = outputRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

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
        v-for="l in session?.buffer.lines ?? []"
        :key="l.id"
        :class="l.updates > 1 ? 'opacity-80' : ''"
        class="whitespace-pre-wrap break-all"
      >
        {{ l.text }}
      </div>
      <div v-if="!session?.buffer.lines.length && !error" class="text-white/40">
        等待日志输出…
      </div>
    </div>
  </div>
</template>
