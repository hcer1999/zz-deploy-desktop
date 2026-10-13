import { defineStore } from "pinia";
import { ref, computed } from "vue";

export type TabKind = "wizard" | "favorites" | "list" | "history" | "settings" | "log";

/**
 * 单例标签：同 kind 只允许一个。
 * `log` 与 `wizard` 不在其中——log 按 taskId 去重，wizard 允许开多个。
 */
const SINGLETON: ReadonlySet<TabKind> = new Set(["favorites", "list", "history", "settings"]);

export interface OpenTabOptions {
  kind: TabKind;
  /** 标签栏上显示的名字；不传则自动推导 */
  title?: string;
  /** 仅 kind === "log" 使用 */
  taskId?: number;
  /** 仅 kind === "log" 使用，决定日志会话的 submittype */
  deployType?: "auto" | "docker";
  /** 仅 kind === "log" 使用，用于标题展示 */
  projectName?: string;
}

export interface Tab extends OpenTabOptions {
  id: string;
}

const DEFAULT_TITLES: Record<TabKind, string> = {
  wizard: "新建部署",
  favorites: "收藏",
  list: "任务列表",
  history: "历史日志",
  settings: "设置",
  log: "构建日志",
};

let counter = 0;
function nextId(): string {
  counter += 1;
  return `tab-${counter}`;
}

export const useTabsStore = defineStore("tabs", () => {
  const tabs = ref<Tab[]>([]);
  const activeId = ref<string | null>(null);

  const activeTab = computed(() => tabs.value.find((t) => t.id === activeId.value) ?? null);

  /** 找到已存在的等价标签 */
  function findExisting(opts: OpenTabOptions): Tab | undefined {
    if (opts.kind === "log") {
      return tabs.value.find((t) => t.kind === "log" && t.taskId === opts.taskId);
    }
    if (SINGLETON.has(opts.kind)) {
      return tabs.value.find((t) => t.kind === opts.kind);
    }
    return undefined;
  }

  /** 打开标签；已存在则聚焦。返回该标签的 id */
  function open(opts: OpenTabOptions): string {
    const existing = findExisting(opts);
    if (existing) {
      activeId.value = existing.id;
      return existing.id;
    }
    const id = nextId();
    // 向导标签的标题在"打开时"就定死。
    // 若留到渲染时按"当前向导数量"去算，同时开两个向导会算出同一个编号。
    const wizardCount = tabs.value.filter((t) => t.kind === "wizard").length;
    const title =
      opts.title ??
      (opts.kind === "wizard" ? `${DEFAULT_TITLES.wizard} ${wizardCount + 1}` : undefined);
    tabs.value.push({ ...opts, id, title });
    activeId.value = id;
    return id;
  }

  /** 关闭标签；若关的是激活项，则优先聚焦右邻，没有右邻则聚焦左邻 */
  function close(id: string): void {
    const idx = tabs.value.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const wasActive = activeId.value === id;
    tabs.value.splice(idx, 1);
    if (!wasActive) return;
    const next = tabs.value[idx] ?? tabs.value[idx - 1] ?? null;
    activeId.value = next ? next.id : null;
  }

  function focus(id: string): void {
    if (tabs.value.some((t) => t.id === id)) activeId.value = id;
  }

  /** 批量关闭某类标签，用于向导提交成功后自毁 */
  function closeByKind(kind: TabKind): void {
    [...tabs.value].filter((t) => t.kind === kind).forEach((t) => close(t.id));
  }

  function titleOf(tab: Tab): string {
    if (tab.title) return tab.title;
    if (tab.kind === "log" && tab.projectName) return `构建日志 · ${tab.projectName}`;
    return DEFAULT_TITLES[tab.kind];
  }

  return { tabs, activeId, activeTab, open, close, focus, closeByKind, titleOf };
});
