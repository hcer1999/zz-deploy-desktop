<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { LogLine } from "@/lib/ansi";
import { planModelSync, type SyncState } from "@/lib/logModel";
import { LOG_LANGUAGE_ID, LOG_THEME, registerLogLanguage } from "@/lib/logLanguage";

/**
 * 只读日志编辑器（Monaco）。
 *
 * 为什么用 Monaco 而不是逐行 span：构建日志动辄几千行、每秒几十次更新，
 * DOM 渲染既慢又做不了虚拟滚动；Monaco 自带虚拟滚动、查找框、选中复制，
 * 语法高亮交给 zzlog（见 lib/logLanguage.ts）。
 *
 * 增量同步的决策在 `planModelSync`（纯函数、有单测）；这里只负责把计划
 * 翻译成 monaco 的 API 调用。
 */
const props = withDefaults(
  defineProps<{
    lines: LogLine[];
    dropped: number;
    pending: string;
    autoScroll: boolean;
    /**
     * 缓冲区变更计数（`LogBuffer.rev`）。日志是原地改数组的，引用不变，
     * 没有这个信号就只能靠"数组长度 + 末行文本"猜，中间行的原地改写会漏。
     */
    rev?: number;
    class?: string;
  }>(),
  { dropped: 0, pending: "", autoScroll: true, rev: 0 },
);

const host = ref<HTMLElement | null>(null);

/* eslint-disable @typescript-eslint/no-explicit-any */
let editor: any = null;
let monaco: any = null;
let state: SyncState | null = null;
/** 进度行装饰（updates > 1 的行压暗，对应旧实现的 opacity-80） */
let decorations: any = null;
let disposed = false;

/** ScrollType.Immediate；不引 monaco 的类型也能用 */
const SCROLL_IMMEDIATE = 1;

async function ensureMonaco(): Promise<any> {
  if (monaco) return monaco;
  const mod = await import("monaco-editor/editor/editor.api");
  try {
    // 查找面板 + worker 都在这里按需引入（测试环境里整个模块被 mock 掉）
    const { installMonacoSupport } = await import("@/lib/monacoContribs");
    installMonacoSupport();
  } catch {
    // 装不上也能读日志（只是少了编辑器内部服务）
  }
  registerLogLanguage(mod as unknown as Parameters<typeof registerLogLanguage>[0]);
  monaco = mod;
  return mod;
}

function applyPlan(): void {
  if (!editor || disposed) return;
  const m = editor.getModel();
  if (!m) return;

  const plan = planModelSync(state, {
    lines: props.lines,
    pending: props.pending,
    dropped: props.dropped,
  });

  if (plan.mode === "reset") {
    m.setValue(plan.text);
  } else if (plan.edits.length > 0) {
    // 升序、互不重叠（见 planModelSync 的约束），一次批量提交
    const lastLine = m.getLineCount();
    m.applyEdits(
      plan.edits.map((e: { startLine: number; endLine: number; text: string }) => ({
        range: new monaco.Range(
          Math.min(e.startLine + 1, lastLine + 1),
          1,
          Math.min(e.endLine + 1, lastLine + 1),
          1,
        ),
        text: e.text,
        forceMoveMarkers: true,
      })),
    );
  }
  state = plan.state;

  applyProgressDecorations();

  if (props.autoScroll) {
    editor.revealLine(m.getLineCount(), SCROLL_IMMEDIATE);
  }
}

/**
 * 进度行压暗。
 *
 * 用装饰而不是改文本：日志正文必须保持原样（复制/查找/导出都读模型）。
 * 进度行数量很少（通常 0~1 行），整组重建比做 diff 简单且开销可忽略。
 */
function applyProgressDecorations(): void {
  if (!editor || !monaco) return;
  if (!decorations) decorations = editor.createDecorationsCollection([]);
  const items = props.lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.updates > 1)
    .map(({ i }) => ({
      range: new monaco.Range(i + 1, 1, i + 1, 1),
      options: { isWholeLine: true, className: "log-progress-dim" },
    }));
  decorations.set(items);
}

onMounted(async () => {
  const mod = await ensureMonaco();
  if (disposed || !host.value) return;
  editor = mod.editor.create(host.value, {
    value: "",
    language: LOG_LANGUAGE_ID,
    theme: LOG_THEME,
    readOnly: true,
    domReadOnly: true,
    minimap: { enabled: false },
    // 行号打开：构建日志里报错常带 "行/步骤" 语境，行号也方便和同事对着看
    lineNumbers: "on",
    lineNumbersMinChars: 4,
    wordWrap: "on",
    scrollBeyondLastLine: false,
    fontSize: 12,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    automaticLayout: true,
    renderLineHighlight: "none",
    contextmenu: false,
    ariaLabel: "构建日志",
  });
  applyPlan();
});

/**
 * 同步触发条件。
 *
 * **不能**监听 `props.lines` 本身：缓冲区是原地 push / splice / 改字段，
 * 数组引用永远不变（这是 C1 那个 bug 的根因——监听引用等于只同步第一次）。
 * 这里用 rev（store 侧的变更计数）为主，长度与末行内容兜底：
 * 纯函数 `planModelSync` 是幂等的，多触发一次只是空跑一次比较。
 */
watch(
  () =>
    [
      props.rev,
      props.lines.length,
      props.lines[props.lines.length - 1]?.text,
      props.lines[props.lines.length - 1]?.updates,
      props.dropped,
      props.pending,
    ] as const,
  () => applyPlan(),
  { flush: "post" },
);

function scrollToBottom(): void {
  if (!editor) return;
  editor.revealLine(editor.getModel()?.getLineCount() ?? 1, SCROLL_IMMEDIATE);
}

/** 从隐藏标签切回来时必须重排：display:none 期间 Monaco 的尺寸是 0 */
function layout(): void {
  editor?.layout();
}

/**
 * 打开 Monaco 自带的查找面板（带命中计数、上一个/下一个、Esc 关闭）。
 *
 * 为什么不自研：查重要在 5000 行的模型上做高亮与跳转，Monaco 已经做了，
 * 而且它能正确处理虚拟滚动之外的行。我们只负责把面板叫出来。
 */
function openFind(backwards = false): void {
  if (!editor) return;
  editor.getAction(backwards ? "actions.findWithSelection" : "actions.find")?.run();
}

/** 用关键词搜索：打开面板并写入关键词（面板内部继续可用上/下一个） */
function search(term: string): void {
  const q = term.trim();
  if (!editor) return;
  openFind();
  if (!q) return;
  editor
    .getContribution("editor.contrib.findController")
    ?.getState()
    .change({ searchString: q }, false);
}

function getText(): string {
  return editor?.getModel()?.getValue() ?? "";
}

onBeforeUnmount(() => {
  disposed = true;
  decorations = null;
  editor?.dispose();
  editor = null;
});

defineExpose({ scrollToBottom, layout, getText, openFind, search });
</script>

<template>
  <div ref="host" data-test="log-editor" :class="props.class" />
</template>

<style>
/* 进度行（会被原地覆盖的行）压暗，替代旧实现的 opacity-80 */
.log-progress-dim {
  opacity: 0.8;
}
</style>
