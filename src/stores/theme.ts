import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeMode = "system" | "dark" | "light";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** jsdom 等环境可能没有 matchMedia，做个守卫避免抛错 */
function mediaQueryList(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(MEDIA_QUERY);
}

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>("system");
  let listener: ((e: MediaQueryListEvent) => void) | null = null;

  function resolve(m: ThemeMode): boolean {
    if (m === "dark") return true;
    if (m === "light") return false;
    return mediaQueryList()?.matches ?? false;
  }

  function paint(isDark: boolean): void {
    document.documentElement.classList.toggle("dark", isDark);
  }

  function apply(m: ThemeMode): void {
    mode.value = m;
    paint(resolve(m));

    // 只在 system 模式下跟随系统实时切换（spec §6.5）
    const mql = mediaQueryList();
    if (listener && mql) {
      mql.removeEventListener("change", listener);
      listener = null;
    }
    if (m === "system" && mql) {
      listener = (e) => paint(e.matches);
      mql.addEventListener("change", listener);
    }
  }

  return { mode, apply };
});
