/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],

  /*
   * 构建时间注入：关于页要显示"这个包是什么时候构建的"。
   * 不能用运行时 Date — 那是用户打开应用的时间，不是构建时间。
   * vite.config 在构建开始时求值一次，所以这里就是准确的构建时刻。
   */
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },

  resolve: {
    alias: {
      // ESM 下没有 __dirname，必须用 import.meta.url
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    // jsdom 缺失的浏览器 API 在这里补齐（见该文件注释）
    setupFiles: ["src/test-setup.ts"],
  },

  build: {
    // 桌面应用的资源从本地磁盘加载，不涉及按需下载，单包体积大没有实际影响。
    // 目前约 690KB：cheerio（HTML 解析，spec §1 明确要求复用）+ reka-ui 的
    // Combobox（可搜索下拉）。上限给到 900KB，只是为了在明显变大时能收到提醒。
    chunkSizeWarningLimit: 900,
  },
});
