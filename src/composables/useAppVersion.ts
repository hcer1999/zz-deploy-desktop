import { ref, type Ref } from "vue";
import { getVersion } from "@tauri-apps/api/app";

/**
 * 运行时版本号（`tauri.conf.json` 里的 version，真值只有那一处）。
 *
 * 模块级缓存：欢迎页与登录页都要显示它，取一次就够；
 * 在没有 Tauri 运行时（浏览器里 `npm run dev` 预览界面）时拿不到，保持空串即可。
 */
const version = ref("");
let loading: Promise<void> | null = null;

export function useAppVersion(): Ref<string> {
  if (!loading) {
    loading = getVersion()
      .then((v) => {
        version.value = v;
      })
      .catch(() => {
        // 浏览器预览：没有 Tauri 运行时，静默忽略
      });
  }
  return version;
}
