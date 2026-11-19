<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { openLog } from "@/stores/tabPayload";
import { useLogsStore } from "@/stores/logs";
import { useTabsStore } from "@/stores/tabs";
import LogEditor from "@/components/log/LogEditor.vue";
import { Button } from "@/components/ui/button";

const props = defineProps<{ tabId: string }>();

const logs = useLogsStore();
const tabs = useTabsStore();
const editorRef = ref<InstanceType<typeof LogEditor> | null>(null);
const autoScroll = ref(true);
const sessionId = ref("");
const error = ref("");

const session = computed(() => (sessionId.value ? logs.sessions[sessionId.value] : undefined));

const lines = computed(() => session.value?.buffer.lines ?? []);
/**
 * 还在刷新中的"当前行"。
 *
 * 进度条是用「回行首重画」刷的（`\r` / `ESC[2K ESC[1G`），这类帧不会进 lines，
 * 只替换 buffer.pending。不把它显示出来，yarn/next 那种一刷几分钟的阶段
 * 界面会一片空白（看着像卡住）。
 */
const pendingText = computed(() => session.value?.buffer.pending ?? "");
const dropped = computed(() => session.value?.buffer.dropped ?? 0);
/** 缓冲区变更计数：日志原地改数组，编辑器靠它知道"真的变了" */
const rev = computed(() => session.value?.buffer.rev ?? 0);

/** 本标签当前是否可见（TabHost 用 v-show 隐藏非激活标签） */
const isActive = computed(() => tabs.activeId === props.tabId);

/**
 * ⌘F / Ctrl+F：打开 Monaco 的查找面板。
 *
 * WebView 里原生的"页内查找"对虚拟滚动的编辑器没用（看不见的行不在 DOM 里），
 * 所以这里接管按键；只在标签可见时接管，不影响其它快捷键。
 */
function onKeydown(e: KeyboardEvent): void {
  if (!isActive.value) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
    e.preventDefault();
    editorRef.value?.openFind();
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
 * 跟随到底部。
 *
 * 真正的滚动在 LogEditor 里（monaco 的 revealLine）；这里只在"自动滚动"开着时
 * 推它一把——关掉自动滚动时用户的位置必须保住，所以**不能**无条件调用。
 */
function follow(): void {
  // 隐藏时 Monaco 尺寸为 0，滚了也无效；切回来由下面的 watcher 补一次
  if (!isActive.value || !autoScroll.value) return;
  editorRef.value?.scrollToBottom();
}

// 新行与"当前行"的刷新都要跟随（否则进度阶段停在原地，看不见最新一帧）
watch([() => lines.value.length, pendingText], () => void nextTick(follow));

/**
 * 切回本标签时补一次滚到底。
 *
 * 后台标签里 Monaco 的尺寸是 0（父级 display:none），收到的日志滚不动；
 * 切回来必须先 layout 再滚，否则会定在最上面。
 */
watch(isActive, (active) => {
  if (!active) return;
  editorRef.value?.layout();
  void nextTick(follow);
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
  // 清空也是"内容变了"：不改 rev 的话编辑器收不到信号，旧内容会留在模型里
  s.buffer.rev += 1;
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
        {{ session?.ingesting ? "载入中…" : STATE_TEXT[session?.state ?? "connecting"] }}
      </span>
      <!-- 服务端拒绝时把它的原话显示出来（例：“数据格式错误”），不再静默失败 -->
      <span
        v-if="session?.detail"
        class="text-[11px] text-amber-400/90 max-w-[280px] truncate"
        :title="session?.detail"
      >
        服务端：{{ session?.detail }}
      </span>
      <!-- 查找面板用 Monaco 自带的：带命中计数与上/下一个，不用我们再算 -->
      <Button
        variant="outline"
        size="sm"
        class="h-6 px-2 text-[11px]"
        data-test="log-find"
        title="查找（⌘F / Ctrl+F）"
        @click="editorRef?.openFind()"
      >
        查找
      </Button>
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

    <LogEditor
      ref="editorRef"
      class="flex-1 min-h-0"
      :lines="lines"
      :dropped="dropped"
      :rev="rev"
      :pending="pendingText"
      :auto-scroll="autoScroll"
    />
  </div>
</template>
