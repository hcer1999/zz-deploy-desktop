import { onMounted, onUnmounted } from "vue";
import { useTabsStore, type TabKind } from "@/stores/tabs";

/** 侧栏里的固定顺序，Cmd/Ctrl+1..5 按这个顺序切换 */
const FIXED_ORDER: TabKind[] = ["wizard", "favorites", "list", "history", "settings"];

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
}

type TabsStore = ReturnType<typeof useTabsStore>;

/**
 * 处理一个按键事件，返回是否已消费。
 *
 * 抽成纯函数是为了能单测：`useShortcuts` 里的监听只在组件挂载后存在，
 * 直接测监听器要先挂载组件，成本高且容易漏掉"输入框内不劫持"这类分支。
 */
export function handleKeydown(e: KeyboardEvent, tabs: TabsStore): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (!meta) return false;

  // 输入框里不劫持按键（否则在搜索框按 Cmd+W 想删词都会关标签）。
  // 例外：Cmd/Ctrl+, 是设置入口，逗号在输入框里没有特殊含义。
  if (isTypingTarget(e.target) && e.key !== ",") return false;

  switch (e.key.toLowerCase()) {
    case "n":
      e.preventDefault();
      tabs.open({ kind: "wizard" });
      return true;
    case "r":
      e.preventDefault();
      // 通知当前页面重新拉取数据；页面各自监听（见 TaskListView / FavoritesView）
      window.dispatchEvent(new CustomEvent("app://refresh"));
      return true;
    case "w":
      e.preventDefault();
      if (tabs.activeId) tabs.close(tabs.activeId);
      return true;
    case ",":
      e.preventDefault();
      tabs.open({ kind: "settings" });
      return true;
    default: {
      const n = Number(e.key);
      if (Number.isInteger(n) && n >= 1 && n <= 5) {
        e.preventDefault();
        tabs.open({ kind: FIXED_ORDER[n - 1] });
        return true;
      }
      return false;
    }
  }
}

/**
 * 应用级快捷键（spec §6.4）。
 *
 * 用 DOM keydown 而不是 Tauri 的全局快捷键：这些都是"应用内"快捷键，
 * 不该在应用失焦时抢占系统按键。
 */
export function useShortcuts(): void {
  const tabs = useTabsStore();
  const onKeydown = (e: KeyboardEvent): void => {
    handleKeydown(e, tabs);
  };
  onMounted(() => window.addEventListener("keydown", onKeydown));
  onUnmounted(() => window.removeEventListener("keydown", onKeydown));
}
