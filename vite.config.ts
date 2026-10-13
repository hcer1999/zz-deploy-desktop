/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],

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
  },

  build: {
    // 桌面应用的资源从本地磁盘加载，不涉及按需下载，单包体积大没有实际影响。
    // 目前约 540KB，主要来自 cheerio（HTML 解析，spec §1 明确要求复用）。
    chunkSizeWarningLimit: 700,
  },
});
