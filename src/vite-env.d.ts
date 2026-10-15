/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

/** 构建时间（ISO 串）：由 vite.config.ts 的 define 注入 */
declare const __BUILD_TIME__: string;
