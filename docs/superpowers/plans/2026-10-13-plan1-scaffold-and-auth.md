# Plan 1：脚手架 + 认证与网络层 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭出 Tauri 2 桌面客户端骨架（三端自定义标题栏、设计系统、标签栏），并实现完整的认证与网络能力层——能登录 ITSM、把 Cookie 维持在内网、会话过期时用系统钥匙串里的密码静默续登。

**Architecture:** Rust 侧只做"能力"（HTTP 通行、Cookie Jar、CSRF 拼装、302 语义判定、自动续登、钥匙串），TS 侧只做"业务与展示"。核心请求逻辑写成不依赖 Tauri 状态的普通 async 函数，便于用本地 mock server 做 TDD；`#[tauri::command]` 只是薄封装。

**Tech Stack:** Tauri 2、Rust 1.90+、reqwest 0.12（cookies）、keyring 3.x、aes-gcm（Linux 降级）、tauri-plugin-store 2、Vue 3、Vite、TypeScript、Pinia、Tailwind CSS 4、shadcn-vue、Vitest、wiremock

**依据 spec:** `docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md`（覆盖 P0 + P1）

---

## 执行中的修正（Task 0–3 已落地）

计划写就后，实际环境暴露了若干与预期不符之处。以下为**已执行的偏离**，后续任务按此为准：

| # | 计划原稿 | 实际执行 | 原因 |
|---|---|---|---|
| 1 | `tauri build --no-bundle` 做 Task 1 验证 | 改为 `cargo build`（debug） | release 档 `lto=true` + `codegen-units=1` 太慢；release 验证推迟到 Task 18 |
| 2 | `vite.config.ts` 用 `__dirname` | 改为 `fileURLToPath(new URL("./src", import.meta.url))` | 模板是 ESM，`__dirname` 不存在 |
| 3 | tsconfig 加 `baseUrl` + `paths` | **只加 `paths`** | TypeScript 6 已弃用 `baseUrl`（TS5101） |
| 4 | 未提 pinia 安装 | 补装 `pinia@4` | 计划遗漏，`main.ts` 需要 |
| 5 | `style.css` 用 `:root{--color-bg}` + `@theme inline{--color-bg:var(--color-bg)}` | 改为 `--deploy-*` 原始调色板 + shadcn 语义 token 引用它 | 原稿是 `var()` 自引用，且与 shadcn 的 `--color-accent`/`--color-border` 撞名（后者在后会覆盖） |
| 6 | `npx shadcn-vue@latest init` | 本地装 `shadcn-vue@2.8.2` + npm `overrides` 钉 Vue 到 3.5.43 | 上游 `@vue/shared@3.5.44` 未发布，`npx` 解析失败 |
| 7 | `-b slate` | `-b zinc`（另需 `--base reka --icon-library lucide --font inter`） | 该版本有效基础色为 neutral/stone/zinc/mauve/olive/mist/taupe |
| 8 | `add ... toast` | `add ... sonner` | shadcn-vue 中 `toast` 已废弃 |
| 9 | 自研 `AppToast.vue` | 用 `vue-sonner` + `src/components/ui/sonner` | 同上，避免重复造轮子 |
| 10 | `bg-accent text-accent-fg` | `bg-primary text-primary-foreground` | `accent` 在 shadcn 语义里是"中性悬停底"，品牌色走 `primary` |

**仍然有效的 token 别名**（`@theme inline` 中保留，业务代码可直接用）：
`bg-bg` `bg-surface` `bg-surface-2` `text-text` `text-text-muted` `text-success` `text-warning` `text-danger` `border-border`
另可用 shadcn 全套：`bg-background` `text-foreground` `bg-primary` `bg-muted` `bg-popover` `bg-card` `text-muted-foreground` 等。

**`shadcn-vue add` 的可用组件名**：`button input label select switch dialog tabs separator sonner`（图标库为 `@lucide/vue`）。

---

## 前置说明

**工作目录：** `~/code/company/tool-demo/zz-deploy-desktop`（已初始化 git，含 `docs/`）

**本计划交付的里程碑：** P1 结束时，应用能：
1. 三端正常打开，标题栏与标签栏渲染正确，深浅主题可切换；
2. 用用户名密码登录 ITSM，登录态保存在 Rust 内存的 Cookie Jar 中；
3. 密码存入系统钥匙串；重启应用后无需重新输入；
4. 手动让 Cookie 失效后，下次请求自动用钥匙串密码重登并重放，前端无感；
5. 设置页可查看/修改 ITSM 地址、主题、清除已保存凭据。

**尚未实现（属于 Plan 2-4）：** 部署向导、任务列表、收藏、构建日志、托盘、通知。

---

## 文件结构

本计划创建的文件及其单一职责：

```
zz-deploy-desktop/
├── package.json / vite.config.ts / tsconfig.json / index.html / components.json
├── src/                                  前端
│   ├── main.ts                           挂载 Vue、加载主题
│   ├── App.vue                           根组件：标题栏 + 侧栏 + 标签栏 + 内容区
│   ├── style.css                         Tailwind 入口 + 设计 token（深浅两套）
│   ├── lib/utils.ts                      cn() 类名合并，shadcn 依赖
│   ├── components/
│   │   ├── ui/                           shadcn-vue 生成的原子组件
│   │   ├── layout/
│   │   │   ├── TitleBar.vue              自定义标题栏（三端分叉）
│   │   │   ├── WindowControls.vue        Windows/Linux 的最小化/最大化/关闭按钮
│   │   │   ├── SideNav.vue               左侧导航
│   │   │   └── TabBar.vue                顶部标签栏
│   │   └── common/
│   │       └── ConfirmDialog.vue         确认对话框（toast 直接用 ui/sonner）
│   ├── views/
│   │   ├── LoginView.vue                 登录页
│   │   ├── SettingsView.vue              设置页
│   │   └── WipView.vue                   未实现页面的占位（P2 起逐个替换）
│   ├── stores/
│   │   ├── auth.ts                       登录态
│   │   ├── tabs.ts                       标签列表与单例规则
│   │   ├── settings.ts                   配置（baseUrl/主题）
│   │   └── theme.ts                      深浅主题应用与跟随系统
│   └── api/
│       ├── ipc.ts                        invoke 的类型化薄封装
│       ├── errors.ts                     错误码 → 中文话术
│       ├── http.ts                       唯一网络出口与错误收口
│       └── auth.ts                       登录/登出/状态
└── src-tauri/                            Rust 后端
    ├── Cargo.toml / build.rs / tauri.conf.json
    ├── tauri.macos.conf.json             仅 macOS：Overlay 标题栏
    ├── tauri.windows.conf.json           仅 Windows：无装饰
    ├── tauri.linux.conf.json             仅 Linux：无装饰
    ├── capabilities/default.json         IPC 与插件权限
    ├── icons/                            应用图标（模板自带，P7 再换正式图标）
    └── src/
        ├── main.rs                       入口，极薄
        ├── lib.rs                        Builder：注册插件、状态、命令
        ├── error.rs                      AppError / ErrorKind
        ├── secure.rs                     凭据存储：钥匙串 + Linux 加密文件降级
        ├── commands/
        │   ├── mod.rs
        │   ├── config.rs                 config_get / config_set
        │   └── auth.rs                   auth_login / auth_logout / auth_status
        └── net/
            ├── mod.rs
            ├── csrf.rs                   从 cookie 提取 CSRF、拼装表单
            ├── redirect.rs               302 语义判定
            ├── client.rs                 HttpClient：请求核心逻辑（可独立单测）
            └── command.rs                http_request 命令封装
```

**为什么 `net/client.rs` 与 `net/command.rs` 分开：** 请求核心逻辑不依赖 `tauri::State`，可以直接用 `wiremock` 起本地 HTTP 服务做 TDD；`command.rs` 只做"取出状态 → 调用核心 → 转换错误"。

---

## Task 0: 升级 Rust 工具链

Tauri store 插件要求 Rust ≥ 1.90，当前本机是 1.87.0，必须先升级，否则后续任务装不上依赖。

**Files:** 无（环境操作）

- [ ] **Step 1: 查看当前版本**

```bash
rustc --version && cargo --version
```

预期：`rustc 1.87.0` 或相近（低于 1.90）

- [ ] **Step 2: 升级工具链**

```bash
rustup update stable
rustup default stable
```

- [ ] **Step 3: 验证版本已 ≥ 1.90**

```bash
rustc --version
```

预期：`rustc 1.9x.0` 或更高。若仍低于 1.90，说明 rustup 未生效，需检查 `rustup show` 输出的 active toolchain。

- [ ] **Step 4: 验证 macOS 构建依赖可用**

```bash
xcode-select -p && cargo --list | grep -q build && echo "toolchain ok"
```

预期：输出 Xcode 路径与 `toolchain ok`

---

## Task 1: 生成 Tauri 2 + Vue + TS 脚手架

**Files:**
- Create: 由模板生成（`package.json`、`vite.config.ts`、`index.html`、`src/`、`src-tauri/` 等）

- [ ] **Step 1: 在临时目录生成脚手架**

在**仓库之外**生成，避免模板拒绝非空目录，也避免覆盖仓库已有的 `.git` 与 `.gitignore`：

```bash
cd ~/code/company/tool-demo
rm -rf scaffold-tmp
npm create tauri-app@latest scaffold-tmp -- \
  --template vue-ts \
  --manager npm \
  --identifier com.zhizhengroup.deploy \
  --yes
```

预期：`scaffold-tmp/` 目录生成完成，内含 `src/`、`src-tauri/`、`package.json`

- [ ] **Step 2: 校验生成结果**

```bash
ls ~/code/company/tool-demo/scaffold-tmp
test -f ~/code/company/tool-demo/scaffold-tmp/src-tauri/tauri.conf.json && echo "tauri.conf.json 存在"
```

预期：列出 `src`、`src-tauri`、`package.json`、`index.html` 等，且打印 `tauri.conf.json 存在`

- [ ] **Step 3: rsync 合并进仓库（排除 .git 与 .gitignore）**

```bash
rsync -a \
  --exclude='.git' \
  --exclude='.gitignore' \
  --exclude='node_modules' \
  ~/code/company/tool-demo/scaffold-tmp/ \
  ~/code/company/tool-demo/zz-deploy-desktop/
```

- [ ] **Step 4: 清理临时目录并确认仓库结构**

```bash
rm -rf ~/code/company/tool-demo/scaffold-tmp
cd ~/code/company/tool-demo/zz-deploy-desktop
ls -a
git status --short | head -20
```

预期：仓库内出现 `src/`、`src-tauri/`、`package.json` 等；`.git` 与 `.gitignore` 未被覆盖；`git status` 显示大量新增文件

- [ ] **Step 5: 安装依赖并构建**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm install
npm run tauri build -- --no-bundle 2>&1 | tail -20
```

预期：Rust 编译通过，产出可执行文件。（`--no-bundle` 跳过打包，节省时间；打包属于 Plan 4）

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "chore: 生成 Tauri 2 + Vue 3 + TS 脚手架"
```

---

## Task 2: 接入 Tailwind CSS 与设计 token

**Files:**
- Create: `src/style.css`
- Modify: `vite.config.ts`（加 Tailwind 插件）
- Modify: `src/main.ts`（引入 style.css）
- Modify: `package.json`（依赖）

- [ ] **Step 1: 安装 Tailwind 与工具依赖**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm install -D tailwindcss @tailwindcss/vite
npm install clsx tailwind-merge
```

- [ ] **Step 2: 配置 Vite 插件**

把 `vite.config.ts` 整体替换为：

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
```

- [ ] **Step 3: 写设计 token 与主题变量**

创建 `src/style.css`。token 取自 spec 的视觉方向（深色 SaaS 为基准，浅色吸收工程工具风的克制）：

```css
@import "tailwindcss";

/* 深色为默认（spec §5：以深色 SaaS 为主视觉） */
@custom-variant dark (&:where(.dark, .dark *));

:root {
  /* 浅色模式：纯白面 + 中性灰 + 单一靛蓝强调（对应 mockup style-b） */
  --color-bg: oklch(0.98 0.002 260);
  --color-surface: oklch(1 0 0);
  --color-surface-2: oklch(0.975 0.003 260);
  --color-border: oklch(0.91 0.005 260);
  --color-text: oklch(0.22 0.01 260);
  --color-text-muted: oklch(0.52 0.012 260);
  --color-accent: oklch(0.55 0.20 265);
  --color-accent-fg: oklch(0.99 0 0);
  --color-success: oklch(0.62 0.17 150);
  --color-warning: oklch(0.75 0.15 75);
  --color-danger: oklch(0.60 0.21 25);

  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
}

.dark {
  /* 深色模式：近黑底 + 靛紫强调（对应 mockup style-a） */
  --color-bg: oklch(0.16 0.012 265);
  --color-surface: oklch(0.20 0.014 265);
  --color-surface-2: oklch(0.24 0.016 265);
  --color-border: oklch(0.30 0.016 265);
  --color-text: oklch(0.95 0.004 265);
  --color-text-muted: oklch(0.68 0.012 265);
  --color-accent: oklch(0.62 0.19 275);
  --color-accent-fg: oklch(0.99 0 0);
  --color-success: oklch(0.72 0.16 155);
  --color-warning: oklch(0.80 0.14 80);
  --color-danger: oklch(0.68 0.19 25);
}

@theme inline {
  --color-bg: var(--color-bg);
  --color-surface: var(--color-surface);
  --color-surface-2: var(--color-surface-2);
  --color-border: var(--color-border);
  --color-text: var(--color-text);
  --color-text-muted: var(--color-text-muted);
  --color-accent: var(--color-accent);
  --color-accent-fg: var(--color-accent-fg);
  --color-success: var(--color-success);
  --color-warning: var(--color-warning);
  --color-danger: var(--color-danger);
  --radius-sm: var(--radius-sm);
  --radius-md: var(--radius-md);
  --radius-lg: var(--radius-lg);
}

html, body, #app { height: 100%; }

body {
  margin: 0;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
  overflow: hidden;
}
```

- [ ] **Step 4: 引入样式表**

把 `src/main.ts` 替换为：

```ts
import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

createApp(App).use(createPinia()).mount("#app");
```

- [ ] **Step 5: 写 cn() 工具函数**

创建 `src/lib/utils.ts`：

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 6: 验证构建通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run build
```

预期：Vite 构建成功，无报错

- [ ] **Step 7: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 接入 Tailwind 与深浅主题设计 token"
```

---

## Task 3: 初始化 shadcn-vue

**Files:**
- Create: `components.json`、`src/components/ui/**`
- Modify: `src/style.css`（shadcn 需要的 CSS 变量）

- [ ] **Step 1: 初始化 shadcn-vue**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npx shadcn-vue@latest init
```

交互选项：Base color 选 **Slate**，CSS variables 选 **Yes**。

预期：生成 `components.json`，并在 `src/style.css` 中追加一组 CSS 变量

- [ ] **Step 2: 安装本计划需要的原子组件**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npx shadcn-vue@latest add button input label select switch dialog tabs toast separator
```

预期：`src/components/ui/` 下出现对应组件目录

- [ ] **Step 3: 验证构建**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run build
```

预期：构建成功

- [ ] **Step 4: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 初始化 shadcn-vue 并添加原子组件"
```

---

## Task 4: 三端自定义标题栏

spec §5.1：macOS 用 `titleBarStyle: Overlay` 保留系统红绿灯；Windows/Linux 用 `decorations: false` 自绘窗口按钮。

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `src-tauri/tauri.macos.conf.json`
- Create: `src-tauri/tauri.windows.conf.json`
- Create: `src-tauri/tauri.linux.conf.json`
- Create: `src-tauri/capabilities/default.json`
- Create: `src/components/layout/WindowControls.vue`
- Create: `src/components/layout/TitleBar.vue`

- [ ] **Step 1: 写基础窗口配置**

把 `src-tauri/tauri.conf.json` 的 `app.windows` 替换为下面这一项（其余字段保持模板生成值，`$schema` 与 `identifier` 不要动）：

```json
"windows": [
  {
    "label": "main",
    "title": "至真部署",
    "width": 1280,
    "height": 800,
    "minWidth": 1024,
    "minHeight": 640,
    "resizable": true,
    "decorations": false
  }
]
```

- [ ] **Step 2: 写 macOS 覆盖配置**

创建 `src-tauri/tauri.macos.conf.json`。平台专属配置会与主配置合并：

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "至真部署",
        "width": 1280,
        "height": 800,
        "minWidth": 1024,
        "minHeight": 640,
        "decorations": true,
        "titleBarStyle": "Overlay",
        "hiddenTitle": true
      }
    ]
  }
}
```

- [ ] **Step 3: 写 Windows 与 Linux 覆盖配置**

创建 `src-tauri/tauri.windows.conf.json`：

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "decorations": false,
        "shadow": true
      }
    ]
  }
}
```

创建 `src-tauri/tauri.linux.conf.json`：

```json
{
  "app": {
    "windows": [
      {
        "label": "main",
        "decorations": false
      }
    ]
  }
}
```

- [ ] **Step 4: 声明窗口权限**

> 注意：此处**只声明本任务用得到的权限**。`store:default` 与 `os:default`
> 要等对应插件安装后（本步末的 `tauri add os`、Task 10 的 `tauri add store`）
> 才能加上——提前写进 capabilities 会让构建直接失败。

替换 `src-tauri/capabilities/default.json`：

```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "default",
  "description": "主窗口所需的最小权限集",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-minimize",
    "core:window:allow-toggle-maximize",
    "core:window:allow-start-dragging"
  ]
}
```

- [ ] **Step 5: 写窗口控制按钮（仅 Windows/Linux 渲染）**

创建 `src/components/layout/WindowControls.vue`：

```vue
<script setup lang="ts">
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";

const appWindow = getCurrentWindow();
// macOS 使用系统红绿灯，不渲染自绘按钮
const isMac = platform() === "macos";
</script>

<template>
  <div v-if="!isMac" class="flex items-center">
    <button class="w-11 h-8 flex items-center justify-center hover:bg-surface-2 transition-colors"
            title="最小化" @click="appWindow.minimize()">
      <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1" /></svg>
    </button>
    <button class="w-11 h-8 flex items-center justify-center hover:bg-surface-2 transition-colors"
            title="最大化" @click="appWindow.toggleMaximize()">
      <svg width="10" height="10" viewBox="0 0 10 10">
        <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
    <button class="w-11 h-8 flex items-center justify-center hover:bg-danger hover:text-white transition-colors"
            title="关闭" @click="appWindow.close()">
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
      </svg>
    </button>
  </div>
</template>
```

- [ ] **Step 6: 安装 OS 插件**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri add os
```

预期：`src-tauri/Cargo.toml` 增加 `tauri-plugin-os`，`package.json` 增加 `@tauri-apps/plugin-os`，`capabilities/default.json` 自动追加 `os:default` 权限

- [ ] **Step 7: 写标题栏**

创建 `src/components/layout/TitleBar.vue`：

```vue
<script setup lang="ts">
import { platform } from "@tauri-apps/plugin-os";
import WindowControls from "./WindowControls.vue";

const isMac = platform() === "macos";
// macOS 的 Overlay 模式下红绿灯占据左上角，需留出约 76px
const leftPad = isMac ? "pl-[76px]" : "pl-3";
</script>

<template>
  <div
    data-tauri-drag-region
    :class="['h-10 shrink-0 flex items-center justify-between border-b border-border bg-surface select-none', leftPad]"
  >
    <div data-tauri-drag-region class="flex items-center gap-2 text-xs text-text-muted">
      <span data-tauri-drag-region>至真部署</span>
    </div>
    <WindowControls />
  </div>
</template>
```

> `data-tauri-drag-region` 必须加在容器**及其内部文本节点**上，否则拖拽区域会被文字切断。

- [ ] **Step 8: 临时挂载以肉眼验证**

把 `src/App.vue` 替换为：

```vue
<script setup lang="ts">
import TitleBar from "./components/layout/TitleBar.vue";
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />
    <div class="flex-1 flex items-center justify-center text-text-muted">
      标题栏验证：应能拖动窗口，Windows/Linux 右上角有按钮，macOS 左上角有红绿灯
    </div>
  </div>
</template>
```

- [ ] **Step 9: 运行并三端验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri dev
```

预期（至少在 macOS 与当前开发机对应平台验证）：
- 窗口无系统装饰，标题栏由 HTML 渲染
- 拖动标题栏空白处能移动窗口
- macOS：左上角红绿灯可见且可用，且未被内容遮挡
- Windows/Linux：右上角三个自绘按钮分别能最小化/最大化/关闭

- [ ] **Step 10: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 三端自定义标题栏与窗口控制"
```

---

## Task 5: 标签栏与左侧导航骨架

spec §5.2：导航是入口，标签是会话；单例标签重复点击只聚焦不新建。

**Files:**
- Create: `src/stores/tabs.ts`
- Create: `src/components/layout/SideNav.vue`
- Create: `src/components/layout/TabBar.vue`
- Create: `src/views/WipView.vue`、`src/views/LoginView.vue`（占位，Task 16 完善）
- Modify: `src/App.vue`
- Test: `src/stores/tabs.test.ts`
- Modify: `package.json`（vitest 依赖与脚本）

- [ ] **Step 1: 安装测试依赖**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm install -D vitest @vue/test-utils jsdom @vitejs/plugin-vue
```

在 `package.json` 的 `scripts` 中加入：

```json
"test": "vitest run",
"test:watch": "vitest"
```

在 `vite.config.ts` 的 `defineConfig({...})` 中追加：

```ts
test: {
  environment: "jsdom",
  globals: true,
},
```

> 同时需在 `vite.config.ts` 顶部加 `/// <reference types="vitest/config" />`，否则 `test` 字段类型报错。

- [ ] **Step 2: 写失败的测试**

创建 `src/stores/tabs.test.ts`：

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useTabsStore, type TabKind } from "./tabs";

describe("tabs store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("单例标签重复打开只聚焦，不新建", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "settings" });
    const b = s.open({ kind: "settings" });
    expect(a).toBe(b);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(a);
  });

  it("向导标签每次打开都新建", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    expect(a).not.toBe(b);
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe(b);
  });

  it("日志标签按 taskId 去重", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "log", taskId: 101 });
    const b = s.open({ kind: "log", taskId: 101 });
    const c = s.open({ kind: "log", taskId: 102 });
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(s.tabs).toHaveLength(2);
  });

  it("多个向导标签的标题互不相同", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    const ta = s.tabs.find((t) => t.id === a)!;
    const tb = s.tabs.find((t) => t.id === b)!;
    expect(s.titleOf(ta)).toBe("新建部署 1");
    expect(s.titleOf(tb)).toBe("新建部署 2");
  });

  it("关闭激活标签后聚焦相邻标签", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    s.close(b);
    expect(s.activeId).toBe(a);
  });

  it("关闭非激活标签不改变当前激活项", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "wizard" });
    const b = s.open({ kind: "wizard" });
    s.close(a);
    expect(s.activeId).toBe(b);
  });

  it("关闭最后一个标签后 activeId 为空", () => {
    const s = useTabsStore();
    const a = s.open({ kind: "settings" });
    s.close(a);
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tabs.test.ts
```

预期：FAIL，报错为找不到模块 `./tabs`

- [ ] **Step 4: 实现 tabs store**

创建 `src/stores/tabs.ts`：

```ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";

export type TabKind = "wizard" | "favorites" | "list" | "history" | "settings" | "log";

/** 单例标签：同 kind 只允许一个；log 例外，按 taskId 去重 */
const SINGLETON: ReadonlySet<TabKind> = new Set(["favorites", "list", "history", "settings"]);

export interface OpenTabOptions {
  kind: TabKind;
  /** 标签栏上显示的名字；不传则由 kind 推导 */
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
    // 若留到渲染时按"当前向导数量"去算，同时开两个向导会得到同一个编号。
    const wizardCount = tabs.value.filter((t) => t.kind === "wizard").length;
    const title =
      opts.title ??
      (opts.kind === "wizard" ? `${DEFAULT_TITLES.wizard} ${wizardCount + 1}` : undefined);
    tabs.value.push({ ...opts, id, title });
    activeId.value = id;
    return id;
  }

  /** 关闭标签；若关的是激活项，则聚焦右邻，没有右邻则聚焦左邻 */
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
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tabs.test.ts
```

预期：7 个测试全部 PASS

- [ ] **Step 6: 写左侧导航**

创建 `src/components/layout/SideNav.vue`：

```vue
<script setup lang="ts">
import { useTabsStore, type TabKind } from "@/stores/tabs";

const tabs = useTabsStore();

const items: { kind: TabKind; label: string; icon: string }[] = [
  { kind: "wizard", label: "新建部署", icon: "M12 5v14M5 12h14" },
  { kind: "favorites", label: "收藏", icon: "M12 3l2.7 5.9 6.3.7-4.7 4.3 1.3 6.3L12 17.8 6.4 20.2l1.3-6.3L3 9.6l6.3-.7z" },
  { kind: "list", label: "任务列表", icon: "M4 6h16M4 12h16M4 18h16" },
  { kind: "history", label: "历史日志", icon: "M12 8v5l3 2M3 12a9 9 0 1 0 3-6.7M3 4v5h5" },
  { kind: "settings", label: "设置", icon: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" },
];

function isActive(kind: TabKind): boolean {
  const t = tabs.activeTab;
  if (!t) return false;
  return kind === "wizard" ? t.kind === "wizard" : t.kind === kind;
}

function onOpen(kind: TabKind): void {
  tabs.open({ kind });
}
</script>

<template>
  <nav class="w-14 shrink-0 flex flex-col items-center gap-1 border-r border-border bg-surface py-2">
    <button
      v-for="it in items"
      :key="it.kind"
      :title="it.label"
      :class="[
        'w-10 h-10 rounded-md flex items-center justify-center transition-colors',
        isActive(it.kind) ? 'bg-primary/15 text-primary' : 'text-text-muted hover:bg-surface-2 hover:text-text',
      ]"
      @click="onOpen(it.kind)"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">
        <path :d="it.icon" />
      </svg>
    </button>
  </nav>
</template>
```

- [ ] **Step 7: 写标签栏**

创建 `src/components/layout/TabBar.vue`：

```vue
<script setup lang="ts">
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();
</script>

<template>
  <div class="h-9 shrink-0 flex items-stretch border-b border-border bg-surface overflow-x-auto">
    <div
      v-for="t in tabs.tabs"
      :key="t.id"
      :class="[
        'group flex items-center gap-2 pl-3 pr-1.5 text-xs border-r border-border cursor-pointer whitespace-nowrap',
        tabs.activeId === t.id ? 'bg-bg text-text' : 'text-text-muted hover:bg-surface-2',
      ]"
      @click="tabs.focus(t.id)"
    >
      <span>{{ tabs.titleOf(t) }}</span>
      <button
        class="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-surface-2"
        title="关闭标签"
        @click.stop="tabs.close(t.id)"
      >×</button>
    </div>
    <div v-if="tabs.tabs.length === 0" class="flex items-center px-3 text-xs text-text-muted">
      从左侧导航打开一个页面
    </div>
  </div>
</template>
```

- [ ] **Step 8: 写占位视图**

创建 `src/views/WipView.vue`：

```vue
<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <div class="h-full flex items-center justify-center text-text-muted">
    「{{ title }}」将在后续计划中实现
  </div>
</template>
```

- [ ] **Step 9: 组装 App.vue**

替换 `src/App.vue`：

```vue
<script setup lang="ts">
import { computed } from "vue";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import WipView from "./views/WipView.vue";
import { useTabsStore } from "./stores/tabs";

const tabs = useTabsStore();

const activeTitle = computed(() => (tabs.activeTab ? tabs.titleOf(tabs.activeTab) : ""));
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />
    <div class="flex-1 flex min-h-0">
      <SideNav />
      <div class="flex-1 flex flex-col min-w-0">
        <TabBar />
        <main class="flex-1 min-h-0 overflow-auto">
          <WipView v-if="tabs.activeTab" :title="activeTitle" />
          <div v-else class="h-full flex items-center justify-center text-text-muted">
            从左侧导航打开一个页面
          </div>
        </main>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 10: 运行并验证交互**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri dev
```

预期：
- 点击左侧「设置」两次 → 标签栏仍只有一个「设置」标签
- 点击左侧「新建部署」两次 → 出现「新建部署 1」「新建部署 2」两个标签
- 点击标签上的 × → 标签关闭；关闭当前标签后自动切到相邻标签
- 点击标签文字 → 切换激活态

- [ ] **Step 11: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 标签栏与左侧导航骨架（IDE 模型，含单例规则与单测）"
```

---

## Task 6: Rust 错误类型

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/net/mod.rs`（先只声明空模块）
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Test: `src-tauri/src/error.rs` 内联 `#[cfg(test)]`

- [ ] **Step 1: 添加 Rust 依赖**

在 `src-tauri/Cargo.toml` 的 `[dependencies]` 中追加：

```toml
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["cookies", "gzip", "brotli"] }
thiserror = "2"
url = "2"
aes-gcm = "0.10"
rand = "0.8"
```

同时在 `src-tauri/Cargo.toml` 顶部按平台声明 keyring。**必须分平台声明**——若把
`sync-secret-service` 写进通用依赖，macOS 构建也会被拉入 D-Bus 相关依赖：

```toml
[target.'cfg(target_os = "macos")'.dependencies]
keyring = { version = "3", features = ["apple-native"] }

[target.'cfg(target_os = "windows")'.dependencies]
keyring = { version = "3", features = ["windows-native"] }

[target.'cfg(target_os = "linux")'.dependencies]
keyring = { version = "3", features = ["sync-secret-service"] }
```

在 `[dev-dependencies]` 中追加：

```toml
wiremock = "0.6"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

- [ ] **Step 2: 写失败的测试**

创建 `src-tauri/src/error.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_errors_are_retryable() {
        let e = AppError::network("connection reset");
        assert_eq!(e.kind, ErrorKind::Network);
        assert!(e.retryable);
    }

    #[test]
    fn auth_errors_are_not_retryable() {
        let e = AppError::auth("bad password");
        assert_eq!(e.kind, ErrorKind::Auth);
        assert!(!e.retryable);
    }

    #[test]
    fn server_5xx_is_retryable_but_4xx_is_not() {
        assert!(AppError::from_status(503).retryable);
        assert!(!AppError::from_status(404).retryable);
    }

    #[test]
    fn serializes_to_kind_and_message() {
        let e = AppError::auth("session expired");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "auth");
        assert_eq!(v["message"], "session expired");
        assert_eq!(v["retryable"], false);
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib error 2>&1 | tail -20
```

预期：编译失败，报 `cannot find type AppError`

- [ ] **Step 4: 实现错误类型**

在 `src-tauri/src/error.rs` 的测试模块**之前**插入实现：

```rust
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Network,
    Timeout,
    Auth,
    Parse,
    Server,
    Config,
    Io,
}

#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    pub retryable: bool,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self { kind, message: message.into(), retryable }
    }

    pub fn network(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Network, message, true)
    }

    pub fn timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Timeout, message, true)
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Auth, message, false)
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Parse, message, false)
    }

    pub fn config(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Config, message, false)
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Io, message, false)
    }

    /// 5xx 与服务端 429 视为可重试；其余 4xx 不可重试
    pub fn from_status(status: u16) -> Self {
        let retryable = status >= 500 || status == 429;
        Self::new(ErrorKind::Server, format!("HTTP {status}"), retryable)
    }

    /// 把 reqwest 的错误归类；超时单独识别，便于前端提示
    pub fn from_reqwest(err: reqwest::Error) -> Self {
        if err.is_timeout() {
            return Self::timeout(err.to_string());
        }
        if err.is_connect() || err.is_request() {
            return Self::network(err.to_string());
        }
        Self::new(ErrorKind::Network, err.to_string(), true)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AppError {}
```

- [ ] **Step 5: 让模块可被编译**

创建 `src-tauri/src/net/mod.rs`：

```rust
// 子模块在后续 Task 中逐个添加
```

在 `src-tauri/src/lib.rs` 顶部加入：

```rust
pub mod error;
pub mod net;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib error 2>&1 | tail -20
```

预期：4 个测试全部 PASS

- [ ] **Step 7: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): AppError 错误类型与分类（5xx 可重试、4xx 不可）"
```

---

## Task 7: CSRF 提取与表单拼装

spec §2.1 第 2 条：cookie 名是 `csrftoken`，请求体字段是 `csrfmiddlewaretoken`，两者不同名。

**Files:**
- Create: `src-tauri/src/net/csrf.rs`
- Modify: `src-tauri/src/net/mod.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/net/csrf.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_csrf_from_cookie_string() {
        let cookie = "sessionid=abc123; csrftoken=XYZ789; other=1";
        assert_eq!(extract_csrf(cookie), Some("XYZ789".to_string()));
    }

    #[test]
    fn returns_none_when_csrf_absent() {
        assert_eq!(extract_csrf("sessionid=abc123"), None);
    }

    #[test]
    fn handles_csrf_as_first_pair() {
        let cookie = "csrftoken=AAA; sessionid=b";
        assert_eq!(extract_csrf(cookie), Some("AAA".to_string()));
    }

    #[test]
    fn adds_csrfmiddlewaretoken_not_csrftoken() {
        let form = vec![("title".to_string(), "deploy".to_string())];
        let out = with_csrf(form, "TOKEN");
        assert!(out.contains(&("csrfmiddlewaretoken".to_string(), "TOKEN".to_string())));
        assert!(!out.iter().any(|(k, _)| k == "csrftoken"));
        assert!(out.contains(&("title".to_string(), "deploy".to_string())));
    }

    #[test]
    fn replaces_existing_csrfmiddlewaretoken_rather_than_duplicating() {
        let form = vec![("csrfmiddlewaretoken".to_string(), "OLD".to_string())];
        let out = with_csrf(form, "NEW");
        assert_eq!(out.iter().filter(|(k, _)| k == "csrfmiddlewaretoken").count(), 1);
        assert!(out.contains(&("csrfmiddlewaretoken".to_string(), "NEW".to_string())));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib csrf 2>&1 | tail -20
```

预期：编译失败，报找不到 `extract_csrf`

- [ ] **Step 3: 实现**

在测试模块之前插入：

```rust
use crate::error::AppError;

/// 从 cookie 字符串里取出 csrftoken 的值。
/// 对应插件 `src/api/client.ts:43` 的 `cookie.match(/csrftoken=([^;]+)/)`
pub fn extract_csrf(cookie: &str) -> Option<String> {
    cookie.split(';').find_map(|pair| {
        let pair = pair.trim();
        pair.strip_prefix("csrftoken=").map(|v| v.to_string())
    })
}

/// 往表单里塞 CSRF。
/// 注意：请求体字段名是 `csrfmiddlewaretoken`，与 cookie 名 `csrftoken` 不同名。
/// 对应插件 `src/api/client.ts:45`
pub fn with_csrf(mut form: Vec<(String, String)>, token: &str) -> Vec<(String, String)> {
    form.retain(|(k, _)| k != "csrfmiddlewaretoken");
    form.push(("csrfmiddlewaretoken".to_string(), token.to_string()));
    form
}

/// 从 reqwest 的 cookie store 读出 csrftoken。
/// 读不到时报 Auth 错误——没有 CSRF 的 POST 一定会被服务端拒绝。
pub fn require_csrf(cookie_header: Option<&str>) -> Result<String, AppError> {
    cookie_header
        .and_then(extract_csrf)
        .ok_or_else(|| AppError::auth("cookie 中缺少 csrftoken，请重新登录"))
}
```

- [ ] **Step 4: 在 mod.rs 中声明**

把 `src-tauri/src/net/mod.rs` 替换为：

```rust
pub mod csrf;
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib csrf 2>&1 | tail -20
```

预期：5 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): CSRF 提取与表单拼装（csrfmiddlewaretoken 字段名对齐服务端）"
```

---

## Task 8: 302 语义判定

spec §2.1 第 3 条：这是修掉插件潜在 bug 的核心。

**Files:**
- Create: `src-tauri/src/net/redirect.rs`
- Modify: `src-tauri/src/net/mod.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/net/redirect.rs`：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://itsm.zhizhengroup.com";

    #[test]
    fn absolute_login_redirect_is_login() {
        let loc = "https://itsm.zhizhengroup.com/login/?next=/deployment/deploy/task/";
        assert!(is_login_redirect(302, Some(loc)));
    }

    #[test]
    fn relative_login_redirect_is_login() {
        assert!(is_login_redirect(302, Some("/login/?next=/" )));
    }

    #[test]
    fn single_slash_login_is_login() {
        assert!(is_login_redirect(302, Some("/login/")));
    }

    #[test]
    fn business_redirect_is_not_login() {
        // 提交部署成功时服务端也返回 302，但指向任务列表
        assert!(!is_login_redirect(302, Some("/deployment/deploy/task/")));
    }

    #[test]
    fn only_302_counts() {
        assert!(!is_login_redirect(200, Some("/login/")));
        assert!(!is_login_redirect(301, Some("/login/")));
    }

    #[test]
    fn missing_location_is_not_login() {
        assert!(!is_login_redirect(302, None));
    }

    #[test]
    fn url_mentioned_in_query_is_not_a_login_redirect() {
        // 防止把 "/deployment/?ref=/login/" 这种路径误判为登录跳转
        assert!(!is_login_redirect(302, Some("/deployment/deploy/task/?ref=/login/")));
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib redirect 2>&1 | tail -20
```

预期：编译失败，报找不到 `is_login_redirect`

- [ ] **Step 3: 实现**

在测试模块之前插入：

```rust
/// 判定一次响应是否代表"会话过期、被踢到登录页"。
///
/// 这是本层最重要的语义判定。插件把 `status === 302` 一律当成操作成功
/// （见 `src/api/deploy.ts:61`），于是 session 过期时提交部署会**误报成功**。
/// 这里把两种情况区分开：302 指向登录页 = 会话过期；其余 302 = 业务成功。
pub fn is_login_redirect(status: u16, location: Option<&str>) -> bool {
    if status != 302 {
        return false;
    }
    let Some(loc) = location else {
        return false;
    };
    // 只看 path 部分，避免 query 里出现的 "/login/" 造成误判
    let path = loc
        .split('?')
        .next()
        .unwrap_or("")
        .trim_end_matches('/');
    path.ends_with("/login") || path == "/login"
}
```

- [ ] **Step 4: 在 mod.rs 中声明**

把 `src-tauri/src/net/mod.rs` 替换为：

```rust
pub mod csrf;
pub mod redirect;
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib redirect 2>&1 | tail -20
```

预期：7 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 302 语义判定，区分会话过期与业务成功"
```

---

## Task 9: 请求核心逻辑（可独立单测）

**Files:**
- Create: `src-tauri/src/net/client.rs`
- Modify: `src-tauri/src/net/mod.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/net/client.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn http_client(base: &str) -> HttpClient {
        HttpClient::new(base)
    }

    #[tokio::test]
    async fn get_returns_status_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/deployment/deploy/task/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>ok</html>"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let r = c.get("/deployment/deploy/task/", &[]).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "<html>ok</html>");
        assert_eq!(r.location, None);
    }

    #[tokio::test]
    async fn sends_query_params() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/task/"))
            .and(query_param("page", "2"))
            .and(query_param("search", "zz-pay"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let params = vec![
            ("page".to_string(), "2".to_string()),
            ("search".to_string(), "zz-pay".to_string()),
        ];
        let r = c.get("/task/", &params).await.unwrap();
        assert_eq!(r.status, 200);
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/redirect-me"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", "/deployment/deploy/task/"),
            )
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let r = c.get("/redirect-me", &[]).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(r.location.as_deref(), Some("/deployment/deploy/task/"));
    }

    #[tokio::test]
    async fn post_sends_form_urlencoded_with_csrf() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/submit/"))
            .and(wiremock::matchers::header("Content-Type", "application/x-www-form-urlencoded"))
            .and(wiremock::matchers::header("X-CSRFToken", "TOK"))
            .and(wiremock::matchers::body_string_contains("csrfmiddlewaretoken=TOK"))
            .and(wiremock::matchers::body_string_contains("title=deploy"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/task/"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        c.seed_cookie("sessionid=s1; csrftoken=TOK").await;
        let form = vec![("title".to_string(), "deploy".to_string())];
        let r = c.post("/submit/", &form).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(r.location.as_deref(), Some("/task/"));
    }

    #[tokio::test]
    async fn stores_and_replays_cookies_across_requests() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/set-cookie"))
            .respond_with(
                ResponseTemplate::new(200).insert_header("set-cookie", "sessionid=abc; Path=/"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/needs-cookie"))
            .and(wiremock::matchers::header("cookie", "sessionid=abc"))
            .respond_with(ResponseTemplate::new(200).set_body_string("authorized"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        c.get("/set-cookie", &[]).await.unwrap();
        let r = c.get("/needs-cookie", &[]).await.unwrap();
        assert_eq!(r.body, "authorized");
    }

    #[test]
    fn rejects_absolute_url_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        let err = c.validate_path("https://evil.example.com/steal").unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Config);
    }

    #[test]
    fn rejects_protocol_relative_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        assert!(c.validate_path("//evil.example.com/x").is_err());
    }

    #[test]
    fn accepts_rooted_relative_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        assert!(c.validate_path("/deployment/deploy/task/").is_ok());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib client 2>&1 | tail -20
```

预期：编译失败，报找不到 `HttpClient`

- [ ] **Step 3: 实现**

在测试模块之前插入：

```rust
use std::sync::Arc;

use reqwest::cookie::Jar;
use reqwest::redirect::Policy;
use reqwest::Client;
use serde::Serialize;
use url::Url;

use crate::error::AppError;
use crate::net::csrf::{require_csrf, with_csrf};

/// 与插件 `src/api/client.ts:4-8` 保持一致的请求头。
/// User-Agent 必须伪装成浏览器，服务端会据此判断客户端类型。
const COMMON_HEADERS: &[(&str, &str)] = &[
    ("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
    ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8"),
    ("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"),
];

#[derive(Debug, Clone, Serialize)]
pub struct HttpResult {
    pub status: u16,
    pub location: Option<String>,
    pub body: String,
}

/// 不带任何 Tauri 依赖的 HTTP 客户端，可直接用 wiremock 单测。
/// Cookie 全部由 reqwest 的 Jar 管理，前端永远接触不到 cookie 明文。
pub struct HttpClient {
    inner: Client,
    jar: Arc<Jar>,
    base_url: String,
}

impl HttpClient {
    pub fn new(base_url: &str) -> Self {
        let jar = Arc::new(Jar::default());
        let inner = Client::builder()
            // 必须手动处理重定向：302 是业务语义的一部分
            .redirect(Policy::none())
            .cookie_provider(jar.clone())
            .build()
            .expect("构建 reqwest client 失败");
        Self {
            inner,
            jar,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 拒绝绝对 URL 与协议相对 URL，只允许以 `/` 开头的站内路径。
    /// 目的是防止 baseUrl 被绕过，向任意主机发请求。
    pub fn validate_path(&self, path: &str) -> Result<(), AppError> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(AppError::config(format!(
                "只允许站内相对路径，收到：{path}"
            )));
        }
        Ok(())
    }

    fn url_for(&self, path: &str) -> Result<Url, AppError> {
        self.validate_path(path)?;
        Url::parse(&format!("{}{}", self.base_url, path))
            .map_err(|e| AppError::config(format!("URL 拼接失败：{e}")))
    }

    /// 预置 cookie（登录成功后写入，或应用启动时不需要——因为 cookie 不落盘）
    pub async fn seed_cookie(&self, cookie: &str) {
        if let Ok(url) = Url::parse(&self.base_url) {
            self.jar.add_cookie_str(cookie, &url);
        }
    }

    /// 取出当前所有 cookie 拼成的请求头，用于 WS 握手与 CSRF 提取
    pub async fn cookie_header(&self) -> Option<String> {
        let url = Url::parse(&self.base_url).ok()?;
        let cookies = self.jar.cookies(&url)?;
        cookies.to_str().ok().map(|s| s.to_string())
    }

    pub async fn get(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let mut url = self.url_for(path)?;
        if !query.is_empty() {
            let mut qp = url.query_pairs_mut();
            for (k, v) in query {
                qp.append_pair(k, v);
            }
        }
        self.execute(self.inner.get(url)).await
    }

    pub async fn post(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let url = self.url_for(path)?;
        let cookie = self.cookie_header().await;
        let token = require_csrf(cookie.as_deref())?;
        let body = with_csrf(form.to_vec(), &token);

        let req = self
            .inner
            .post(url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("X-CSRFToken", token)
            .header("Origin", &self.base_url)
            .header("Referer", url.as_str())
            .form(&body);
        self.execute(req).await
    }

    async fn execute(&self, mut req: reqwest::RequestBuilder) -> Result<HttpResult, AppError> {
        for (k, v) in COMMON_HEADERS {
            req = req.header(*k, *v);
        }
        req = req.header("Origin", &self.base_url).header("Referer", &self.base_url);

        let resp = req.send().await.map_err(AppError::from_reqwest)?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::network(format!("读取响应体失败：{e}")))?;

        Ok(HttpResult { status, location, body })
    }
}
```

- [ ] **Step 4: 在 mod.rs 中声明**

把 `src-tauri/src/net/mod.rs` 替换为：

```rust
pub mod client;
pub mod csrf;
pub mod redirect;
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib client 2>&1 | tail -30
```

预期：8 个测试全部 PASS。若 `stores_and_replays_cookies_across_requests` 失败，检查 `Jar::add_cookie_str` 的 domain 是否与 mock server 的 `127.0.0.1` 匹配。

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): HTTP 客户端核心（Cookie Jar、不跟随重定向、CSRF 表单、拒绝绝对 URL）"
```


---

## Task 10: 配置存储（baseUrl / 主题）

**Files:**
- Create: `src-tauri/src/commands/mod.rs`、`src-tauri/src/commands/config.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`、`src-tauri/capabilities/default.json`

- [ ] **Step 1: 添加 store 插件**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri add store
```

预期：`Cargo.toml` 增加 `tauri-plugin-store`，`package.json` 增加 `@tauri-apps/plugin-store`

- [ ] **Step 2: 手动确认 store 权限已声明**

`npm run tauri add store` 通常会自动追加权限，但仍需确认 `src-tauri/capabilities/default.json` 的 `permissions` 数组里含有 `"store:default"`。若没有则手动加上——缺少它时 `app.store()` 会在运行时被拒绝。

- [ ] **Step 3: 写配置类型与读写**

创建 `src-tauri/src/commands/config.rs`：

```rust
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

pub const DEFAULT_BASE_URL: &str = "https://itsm.zhizhengroup.com";
const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub base_url: String,
    /// "system" | "dark" | "light"
    pub theme: String,
    pub username: String,
    /// 关闭窗口行为："tray" | "quit"
    pub close_behavior: String,
    pub poll_interval_secs: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            theme: "system".to_string(),
            username: String::new(),
            close_behavior: "tray".to_string(),
            poll_interval_secs: 60,
        }
    }
}

/// 只接受这几种主题值，防止配置文件被手改成无效值
fn normalize_theme(v: &str) -> String {
    match v {
        "dark" | "light" | "system" => v.to_string(),
        _ => "system".to_string(),
    }
}

fn normalize_close_behavior(v: &str) -> String {
    match v {
        "tray" | "quit" => v.to_string(),
        _ => "tray".to_string(),
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<AppConfig, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开配置存储失败：{e}")))?;

    let get_str = |key: &str| -> Option<String> {
        store.get(key).and_then(|v| v.as_str().map(|s| s.to_string()))
    };

    let mut cfg = AppConfig::default();
    if let Some(v) = get_str("baseUrl") {
        cfg.base_url = v.trim_end_matches('/').to_string();
    }
    if let Some(v) = get_str("theme") {
        cfg.theme = normalize_theme(&v);
    }
    if let Some(v) = get_str("username") {
        cfg.username = v;
    }
    if let Some(v) = get_str("closeBehavior") {
        cfg.close_behavior = normalize_close_behavior(&v);
    }
    if let Some(v) = store.get("pollIntervalSecs").and_then(|v| v.as_u64()) {
        cfg.poll_interval_secs = v.clamp(10, 3600) as u32;
    }
    Ok(cfg)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &AppConfig) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开配置存储失败：{e}")))?;
    store.set("baseUrl", serde_json::json!(cfg.base_url.trim_end_matches('/')));
    store.set("theme", serde_json::json!(normalize_theme(&cfg.theme)));
    store.set("username", serde_json::json!(cfg.username));
    store.set("closeBehavior", serde_json::json!(normalize_close_behavior(&cfg.close_behavior)));
    store.set("pollIntervalSecs", serde_json::json!(cfg.poll_interval_secs));
    store
        .save()
        .map_err(|e| AppError::config(format!("写入配置失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn config_get<R: Runtime>(app: AppHandle<R>) -> Result<AppConfig, AppError> {
    load(&app)
}

#[tauri::command]
pub async fn config_set<R: Runtime>(app: AppHandle<R>, patch: AppConfig) -> Result<AppConfig, AppError> {
    save(&app, &patch)?;
    load(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_theme_falls_back_to_system() {
        assert_eq!(normalize_theme("neon"), "system");
        assert_eq!(normalize_theme("dark"), "dark");
    }

    #[test]
    fn invalid_close_behavior_falls_back_to_tray() {
        assert_eq!(normalize_close_behavior("explode"), "tray");
        assert_eq!(normalize_close_behavior("quit"), "quit");
    }

    #[test]
    fn default_config_points_at_itsm() {
        assert_eq!(AppConfig::default().base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn config_serializes_with_camel_case_keys() {
        let v = serde_json::to_value(AppConfig::default()).unwrap();
        assert!(v.get("baseUrl").is_some());
        assert!(v.get("pollIntervalSecs").is_some());
    }
}
```

- [ ] **Step 4: 声明模块并注册命令**

创建 `src-tauri/src/commands/mod.rs`：

```rust
pub mod config;
```

把 `src-tauri/src/lib.rs` 的 `run()` 替换为：

```rust
pub mod commands;
pub mod error;
pub mod net;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .invoke_handler(tauri::generate_handler![
            commands::config::config_get,
            commands::config::config_set,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
```

- [ ] **Step 5: 运行测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib config 2>&1 | tail -20
```

预期：4 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 配置存储 config_get/config_set（含取值归一化与单测）"
```

---

## Task 11: 自动续登拦截（核心，TDD）

spec §2.1 第 4 条：会话过期且钥匙串有密码时，静默重登并**重放原请求一次**。

**Files:**
- Create: `src-tauri/src/net/session.rs`
- Modify: `src-tauri/src/net/mod.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/net/session.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::client::HttpClient;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 构造一个"第一次请求被踢到登录页、续登后正常"的服务端
    async fn server_requiring_relogin() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/login/?next=/protected"))
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(200).set_body_string("secret-data"))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn normal_response_does_not_trigger_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("fine"))
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let r = execute_with_relogin(&c, Method::Get, "/ok", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.body, "fine");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "不应触发续登");
    }

    #[tokio::test]
    async fn login_redirect_triggers_relogin_and_replays_once() {
        let server = server_requiring_relogin().await;
        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();

        let r = execute_with_relogin(&c, Method::Get, "/protected", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.status, 200);
        assert_eq!(r.body, "secret-data");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "应恰好续登一次");
    }

    #[tokio::test]
    async fn business_redirect_does_not_trigger_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/submit-task"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/deployment/deploy/task/"))
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let r = execute_with_relogin(&c, Method::Get, "/submit-task", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.status, 302);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "业务 302 不该触发续登");
    }

    #[tokio::test]
    async fn relogin_failure_propagates_error() {
        let server = server_requiring_relogin().await;
        let c = HttpClient::new(&server.uri());

        let err = execute_with_relogin(&c, Method::Get, "/protected", &[], &[], || async {
            Err(crate::error::AppError::auth("密码已失效"))
        })
        .await
        .unwrap_err();

        assert_eq!(err.kind, crate::error::ErrorKind::Auth);
        assert_eq!(err.message, "密码已失效");
    }

    #[tokio::test]
    async fn still_redirected_after_relogin_is_reported_not_looped() {
        let server = MockServer::start().await;
        // 始终指向登录页
        Mock::given(method("GET"))
            .and(path("/always-login"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/login/"))
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let err = execute_with_relogin(&c, Method::Get, "/always-login", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        })
        .await
        .unwrap_err();

        assert_eq!(err.kind, crate::error::ErrorKind::Auth);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "续登只允许一次，不能死循环");
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib session 2>&1 | tail -20
```

预期：编译失败，报找不到 `execute_with_relogin`

- [ ] **Step 3: 实现**

在测试模块之前插入：

```rust
use std::future::Future;

use crate::error::AppError;
use crate::net::client::{HttpClient, HttpResult};
use crate::net::redirect::is_login_redirect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

async fn send(
    client: &HttpClient,
    method: Method,
    path: &str,
    query: &[(String, String)],
    form: &[(String, String)],
) -> Result<HttpResult, AppError> {
    match method {
        Method::Get => client.get(path, query).await,
        Method::Post => client.post(path, form).await,
    }
}

/// 带"会话过期自动续登"的请求。
///
/// 行为：
/// 1. 先正常发一次；
/// 2. 若响应是 302 且指向登录页，判定会话过期，调用 `relogin`；
/// 3. 续登成功后**只重放一次**原请求；
/// 4. 重放后仍指向登录页，报 Auth 错误（绝不循环重试，否则会打爆服务端）。
///
/// `relogin` 用闭包注入，使这个函数不依赖 Tauri 状态，可以用 wiremock 单测。
pub async fn execute_with_relogin<F, Fut>(
    client: &HttpClient,
    method: Method,
    path: &str,
    query: &[(String, String)],
    form: &[(String, String)],
    relogin: F,
) -> Result<HttpResult, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let first = send(client, method, path, query, form).await?;
    if !is_login_redirect(first.status, first.location.as_deref()) {
        return Ok(first);
    }

    relogin().await?;

    let second = send(client, method, path, query, form).await?;
    if is_login_redirect(second.status, second.location.as_deref()) {
        return Err(AppError::auth(
            "自动续登后仍被要求登录，请确认账号权限或重新登录",
        ));
    }
    Ok(second)
}
```

- [ ] **Step 4: 在 mod.rs 中声明**

把 `src-tauri/src/net/mod.rs` 替换为：

```rust
pub mod client;
pub mod csrf;
pub mod redirect;
pub mod session;
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib session 2>&1 | tail -30
```

预期：5 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 会话过期自动续登与单次重放（含 wiremock 单测）"
```

---

## Task 12: 凭据存储（钥匙串 + Linux 加密文件降级）

spec §12：Linux 可能没有 Secret Service，需要降级到加密文件并在设置页明示。

**Files:**
- Create: `src-tauri/src/secure.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/secure.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(dir: &TempDir) -> EncryptedFileStore {
        EncryptedFileStore::new(dir.path().join("credentials.bin"))
    }

    #[test]
    fn roundtrips_credentials() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("zhangsan", "p@ssw0rd").unwrap();
        let got = s.load().unwrap().unwrap();
        assert_eq!(got.0, "zhangsan");
        assert_eq!(got.1, "p@ssw0rd");
    }

    #[test]
    fn overwrites_previous_credentials() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        s.save("b", "2").unwrap();
        assert_eq!(s.load().unwrap().unwrap(), ("b".to_string(), "2".to_string()));
    }

    #[test]
    fn forget_clears_credentials_but_keeps_key_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        s.forget().unwrap();
        assert!(s.load().unwrap().is_none());
        assert!(dir.path().join("credentials.key").exists(), "不应删除密钥文件");
    }

    #[test]
    fn load_returns_none_when_file_missing() {
        let dir = TempDir::new().unwrap();
        assert!(store(&dir).load().unwrap().is_none());
    }

    #[test]
    fn plaintext_password_is_not_present_in_ciphertext_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("zhangsan", "SUPER_SECRET_VALUE").unwrap();
        let raw = std::fs::read(dir.path().join("credentials.bin")).unwrap();
        assert!(
            !raw.windows(18).any(|w| w == b"SUPER_SECRET_VALUE"),
            "密文文件里不应出现明文密码"
        );
    }

    #[test]
    fn corrupted_file_reports_error_not_panic() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("credentials.bin"), b"garbage").unwrap();
        std::fs::write(dir.path().join("credentials.key"), [7u8; 32]).unwrap();
        let e = store(&dir).load().unwrap_err();
        assert_eq!(e.kind, crate::error::ErrorKind::Config);
    }

    #[test]
    fn key_is_32_bytes_and_reused_across_instances() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        // 新实例应能读到同一把密钥并解出原值
        assert_eq!(store(&dir).load().unwrap().unwrap().1, "1");
        let key = std::fs::read(dir.path().join("credentials.key")).unwrap();
        assert_eq!(key.len(), 32);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib secure 2>&1 | tail -20
```

预期：编译失败，报找不到 `EncryptedFileStore`

- [ ] **Step 3: 在 Cargo.toml 加测试依赖**

在 `[dev-dependencies]` 中追加：

```toml
tempfile = "3"
```

- [ ] **Step 4: 实现**

在测试模块之前插入：

```rust
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;

use crate::error::AppError;

const CREDENTIALS_FILE: &str = "credentials.bin";
const KEY_FILE: &str = "credentials.key";
const NONCE_LEN: usize = 12;

/// 凭据后端。`backend()` 的值会透传给设置页，用于提示用户当前存储方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Keyring,
    EncryptedFile,
}

pub trait CredentialStore: Send + Sync {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError>;
    fn load(&self) -> Result<Option<(String, String)>, AppError>;
    fn forget(&self) -> Result<(), AppError>;
    fn backend(&self) -> Backend;
}

// ---------- 系统钥匙串 ----------

const SERVICE: &str = "com.zhizhengroup.deploy";
const ACCOUNT: &str = "itsm";

pub struct KeyringStore;

impl KeyringStore {
    fn entry() -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|e| AppError::config(format!("访问系统钥匙串失败：{e}")))
    }

    /// 探测系统钥匙串是否真的可用（Linux 上没有 Secret Service 时会失败）。
    /// 往一个探测条目写一次再读回，避免只判断构造是否成功。
    pub fn available() -> bool {
        let Ok(e) = keyring::Entry::new(SERVICE, "__probe__") else {
            return false;
        };
        let probe = "probe";
        if e.set_password(probe).is_err() {
            return false;
        }
        let ok = e.get_password().map(|v| v == probe).unwrap_or(false);
        let _ = e.delete_credential();
        ok
    }
}

impl CredentialStore for KeyringStore {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError> {
        // 用户名与密码一起编码存放，避免多开一个条目
        let payload = serde_json::json!({ "u": username, "p": password }).to_string();
        Self::entry()?
            .set_password(&payload)
            .map_err(|e| AppError::config(format!("写入钥匙串失败：{e}")))
    }

    fn load(&self) -> Result<Option<(String, String)>, AppError> {
        let entry = Self::entry()?;
        match entry.get_password() {
            Ok(payload) => {
                let v: serde_json::Value = serde_json::from_str(&payload)
                    .map_err(|e| AppError::config(format!("钥匙串内容无法解析：{e}")))?;
                let u = v.get("u").and_then(|x| x.as_str()).unwrap_or_default();
                let p = v.get("p").and_then(|x| x.as_str()).unwrap_or_default();
                if u.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some((u.to_string(), p.to_string())))
                }
            }
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::config(format!("读取钥匙串失败：{e}"))),
        }
    }

    fn forget(&self) -> Result<(), AppError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::config(format!("清除钥匙串失败：{e}"))),
        }
    }

    fn backend(&self) -> Backend {
        Backend::Keyring
    }
}

// ---------- 加密文件降级 ----------

/// 注意其安全等级：密钥与密文存放在同一台机器的同一目录下。
/// 它只保证"文件被肉眼或随手拷走时看不到明文"，
/// **不能**防御已经能在本机读取文件系统的攻击者。
pub struct EncryptedFileStore {
    data_path: PathBuf,
    key_path: PathBuf,
}

impl EncryptedFileStore {
    /// `data_path` 例如 `<appDataDir>/credentials.bin`，密钥同目录下 `credentials.key`
    pub fn new(data_path: PathBuf) -> Self {
        let key_path = data_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(KEY_FILE);
        Self { data_path, key_path }
    }

    fn load_or_create_key(&self) -> Result<[u8; 32], AppError> {
        if let Ok(bytes) = std::fs::read(&self.key_path) {
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        if let Some(parent) = self.key_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&self.key_path, key)
            .map_err(|e| AppError::io(format!("写入密钥失败：{e}")))?;
        restrict_permissions(&self.key_path);
        Ok(key)
    }

    fn cipher(&self) -> Result<Aes256Gcm, AppError> {
        let key = self.load_or_create_key()?;
        Ok(Aes256Gcm::new_from_slice(&key).expect("32 字节密钥必然合法"))
    }
}

/// 把文件权限收紧到 0600（仅所有者可读写）
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

impl CredentialStore for EncryptedFileStore {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError> {
        let plain = serde_json::json!({ "u": username, "p": password }).to_string();
        let cipher = self.cipher()?;

        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plain.as_bytes())
            .map_err(|e| AppError::config(format!("加密失败：{e}")))?;

        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);

        if let Some(parent) = self.data_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&self.data_path, out)
            .map_err(|e| AppError::io(format!("写入凭据失败：{e}")))?;
        restrict_permissions(&self.data_path);
        Ok(())
    }

    fn load(&self) -> Result<Option<(String, String)>, AppError> {
        let raw = match std::fs::read(&self.data_path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::io(format!("读取凭据失败：{e}"))),
        };
        if raw.len() <= NONCE_LEN {
            return Err(AppError::config("凭据文件已损坏（长度异常）".to_string()));
        }
        let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plain = self
            .cipher()?
            .decrypt(nonce, ciphertext)
            .map_err(|_| AppError::config("凭据解密失败，文件或密钥已损坏".to_string()))?;
        let text = String::from_utf8(plain)
            .map_err(|e| AppError::config(format!("凭据内容不是合法文本：{e}")))?;
        let v: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| AppError::config(format!("凭据内容无法解析：{e}")))?;
        let u = v.get("u").and_then(|x| x.as_str()).unwrap_or_default();
        let p = v.get("p").and_then(|x| x.as_str()).unwrap_or_default();
        if u.is_empty() {
            return Ok(None);
        }
        Ok(Some((u.to_string(), p.to_string())))
    }

    fn forget(&self) -> Result<(), AppError> {
        match std::fs::remove_file(&self.data_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io(format!("清除凭据失败：{e}"))),
        }
    }

    fn backend(&self) -> Backend {
        Backend::EncryptedFile
    }
}

/// 优先用系统钥匙串；不可用时降级到加密文件。
/// 返回值是 `Box<dyn CredentialStore>`，调用方无需知道具体实现。
pub fn detect_store(app_data_dir: &Path) -> Box<dyn CredentialStore> {
    if KeyringStore::available() {
        Box::new(KeyringStore)
    } else {
        Box::new(EncryptedFileStore::new(
            app_data_dir.join(CREDENTIALS_FILE),
        ))
    }
}
```

- [ ] **Step 5: 声明模块**

在 `src-tauri/src/lib.rs` 的模块声明中加入：

```rust
pub mod secure;
```

- [ ] **Step 6: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib secure 2>&1 | tail -30
```

预期：7 个测试全部 PASS

- [ ] **Step 7: 手工验证钥匙串可用性（macOS）**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib secure -- --nocapture 2>&1 | grep -i keyring || echo "（钥匙串探测需在集成阶段验证）"
```

预期：无 panic。钥匙串的真实读写会在 Task 18 冒烟测试中随登录流程一起验证。

- [ ] **Step 8: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 凭据存储（系统钥匙串 + Linux 加密文件降级）"
```

---

## Task 13: 登录 / 登出 / 状态

**Files:**
- Create: `src-tauri/src/commands/auth.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/net/client.rs`（新增不带 CSRF 的 POST）
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的测试（post_raw）**

在 `src-tauri/src/net/client.rs` 的测试模块中追加：

```rust
    #[tokio::test]
    async fn post_raw_sends_no_csrf() {
        // 登录接口本身不需要 csrfmiddlewaretoken：
        // 对应插件 src/api/deploy.ts:110 的登录 POST，body 里只有 username/password
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let form = vec![
            ("username".to_string(), "zhangsan".to_string()),
            ("password".to_string(), "pw".to_string()),
        ];
        let r = c.post_raw("/login/", &form).await.unwrap();
        assert_eq!(r.status, 302);

        let reqs = server.received_requests().await.unwrap();
        let body = String::from_utf8(reqs[0].body.clone()).unwrap();
        assert!(body.contains("username=zhangsan"));
        assert!(!body.contains("csrfmiddlewaretoken"), "登录请求不应带 CSRF 字段");
    }
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib post_raw 2>&1 | tail -20
```

预期：编译失败，报找不到 `post_raw`

- [ ] **Step 3: 实现 post_raw**

在 `src-tauri/src/net/client.rs` 的 `post` 方法**之后**插入：

```rust
    /// 不带 CSRF 的 POST，仅用于登录接口。
    ///
    /// 登录页在未认证状态下拿不到有效的 csrftoken 配对，插件也是直接发
    /// 纯 username/password（见 `src/api/deploy.ts:110`），此处保持一致。
    pub async fn post_raw(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let url = self.url_for(path)?;
        let req = self
            .inner
            .post(url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Origin", &self.base_url)
            .header("Referer", url.as_str())
            .form(form);
        self.execute(req).await
    }
```

- [ ] **Step 4: 运行 post_raw 测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib client 2>&1 | tail -20
```

预期：9 个测试全部 PASS

- [ ] **Step 5: 实现登录命令**

创建 `src-tauri/src/commands/auth.rs`：

```rust
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::commands::config;
use crate::error::AppError;
use crate::net::client::HttpClient;
use crate::net::redirect::is_login_redirect;
use crate::secure::{Backend, CredentialStore};
use crate::session::SessionState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: String,
    pub base_url: String,
    pub credential_backend: Backend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub ok: bool,
    pub message: String,
}

/// 走一次真实的登录流程。
///
/// 步骤与插件 `src/api/deploy.ts:96-131` 一致：
/// 1. GET /login/ 拿初始 sessionid 与 csrftoken（由 Cookie Jar 自动保存）；
/// 2. POST /login/ 提交 username/password；
/// 3. 校验登录是否真的成功。
///
/// 与插件不同的一点：插件仅凭响应里是否出现 sessionid 判断成功，
/// 这里额外发一次受保护请求来确认——避免"密码错误但服务端仍发了新 session"的误判。
pub async fn login_flow(
    client: &HttpClient,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    // 1. 预热：触发服务端下发 sessionid 与 csrftoken
    client.get("/login/", &[]).await?;

    // 2. 提交登录表单
    let form = vec![
        ("username".to_string(), username.to_string()),
        ("password".to_string(), password.to_string()),
    ];
    let resp = client.post_raw("/login/", &form).await?;

    // 部分配置下认证失败会 302 回登录页（多数情况下 Django 返回 200 并回显表单，
    // 那种情况由下面的探测请求兜住）
    if is_login_redirect(resp.status, resp.location.as_deref()) {
        return Err(AppError::auth("用户名或密码错误"));
    }

    // 3. 用一次受保护请求确认登录态真的生效。
    //    这一步是必须的：插件仅凭"响应里出现 sessionid"判断成功
    //    （见 src/api/deploy.ts:126），而服务端在认证失败时也可能下发新 session，
    //    会造成"密码错了却提示登录成功"。探测请求能真正区分两者。
    let probe = client.get("/deployment/deploy/task/", &[]).await?;
    if is_login_redirect(probe.status, probe.location.as_deref()) {
        return Err(AppError::auth("用户名或密码错误"));
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_status<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<AuthStatus, AppError> {
    let cfg = config::load(&app)?;
    Ok(AuthStatus {
        logged_in: session.is_logged_in().await,
        username: cfg.username,
        base_url: cfg.base_url,
        credential_backend: session.credentials.backend(),
    })
}

#[tauri::command]
pub async fn auth_login<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
    username: String,
    password: String,
    remember: bool,
) -> Result<LoginResult, AppError> {
    let mut cfg = config::load(&app)?;
    let client = session.client().await;

    match login_flow(&client, &username, &password).await {
        Ok(()) => {
            cfg.username = username.clone();
            config::save(&app, &cfg)?;
            if remember {
                session.credentials.save(&username, &password)?;
            } else {
                session.credentials.forget()?;
            }
            Ok(LoginResult { ok: true, message: String::new() })
        }
        Err(e) => {
            // 登录失败不返回 Err，让前端能用统一结构展示 message
            Ok(LoginResult { ok: false, message: e.message })
        }
    }
}

#[tauri::command]
pub async fn auth_logout<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<(), AppError> {
    let mut cfg = config::load(&app)?;
    cfg.username = String::new();
    config::save(&app, &cfg)?;
    session.clear_cookies().await;
    let _ = session.credentials.forget();
    Ok(())
}

/// 前端在收到 auth://expired 后调用，用保存的凭据再试一次
#[tauri::command]
pub async fn auth_relogin<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<LoginResult, AppError> {
    let cfg = config::load(&app)?;
    let Some((user, pass)) = session.credentials.load()? else {
        return Ok(LoginResult { ok: false, message: "没有保存的凭据".to_string() });
    };
    let client = session.client().await;
    match login_flow(&client, &user, &pass).await {
        Ok(()) => Ok(LoginResult { ok: true, message: String::new() }),
        Err(e) => Ok(LoginResult { ok: false, message: e.message }),
    }
}

/// 登录页用：在未登录状态下改 ITSM 地址
#[tauri::command]
pub async fn set_base_url<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
    base_url: String,
) -> Result<(), AppError> {
    let mut cfg = config::load(&app)?;
    cfg.base_url = base_url.trim_end_matches('/').to_string();
    config::save(&app, &cfg)?;
    session.rebuild_client(&cfg.base_url).await;
    Ok(())
}

/// 应用启动时若钥匙串有凭据，静默续登一次
pub async fn try_silent_login<R: Runtime>(
    app: &AppHandle<R>,
    session: &SessionState,
) -> Result<bool, AppError> {
    let Ok(Some((user, pass))) = session.credentials.load() else {
        return Ok(false);
    };
    let client = session.client().await;
    match login_flow(&client, &user, &pass).await {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}
```

- [ ] **Step 6: 让 config_set 在地址变更时重建 HTTP 客户端**

这一步必须做：`config_set` 改了 `baseUrl` 之后，如果不同步重建 `HttpClient`，
应用仍会往旧地址发请求。`SessionState` 在本任务才出现，所以放在这里补。

把 `src-tauri/src/commands/config.rs` 里的 `config_set` 替换为：

```rust
#[tauri::command]
pub async fn config_set<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, crate::session::SessionState>,
    patch: AppConfig,
) -> Result<AppConfig, AppError> {
    let previous = load(&app)?;
    save(&app, &patch)?;
    // 地址变了就重建客户端：旧 Cookie 对新域名无意义，必须丢弃
    if previous.base_url != patch.base_url {
        session.rebuild_client(&patch.base_url).await;
    }
    load(&app)
}
```

并在该文件顶部补上 `use tauri::State;`。

- [ ] **Step 7: 写会话状态**

创建 `src-tauri/src/session.rs`：

```rust
use std::sync::Arc;

use tokio::sync::{Mutex, RwLock};

use crate::net::client::HttpClient;
use crate::net::session::{execute_with_relogin, Method};
use crate::net::client::HttpResult;
use crate::error::AppError;
use crate::secure::CredentialStore;

/// 全局会话：持有 HTTP 客户端、凭据存储，以及"当前是否已登录"的依据。
///
/// Cookie 只活在这里的内存中，**不落盘**（spec §7）。应用重启后靠钥匙串里的
/// 密码静默续登，用户无感。
pub struct SessionState {
    client: RwLock<Arc<HttpClient>>,
    pub credentials: Box<dyn CredentialStore>,
    /// 续登期间串行化，避免多个请求同时触发续登、把服务端打爆
    relogin_lock: Mutex<()>,
}

impl SessionState {
    pub fn new(base_url: &str, credentials: Box<dyn CredentialStore>) -> Self {
        Self {
            client: RwLock::new(Arc::new(HttpClient::new(base_url))),
            credentials,
            relogin_lock: Mutex::new(()),
        }
    }

    pub async fn client(&self) -> Arc<HttpClient> {
        self.client.read().await.clone()
    }

    pub async fn rebuild_client(&self, base_url: &str) {
        let mut w = self.client.write().await;
        *w = Arc::new(HttpClient::new(base_url));
    }

    pub async fn clear_cookies(&self) {
        let url = {
            let c = self.client.read().await;
            c.base_url().to_string()
        };
        self.rebuild_client(&url).await;
    }

    /// 判据：Cookie Jar 里还有 sessionid
    pub async fn is_logged_in(&self) -> bool {
        let c = self.client.read().await;
        c.cookie_header()
            .await
            .map(|h| h.contains("sessionid="))
            .unwrap_or(false)
    }

    /// 所有业务请求的统一入口：带自动续登
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(String, String)],
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let client = self.client().await;
        let result = execute_with_relogin(&client, method, path, query, form, || async {
            let _guard = self.relogin_lock.lock().await;
            let Some((user, pass)) = self.credentials.load()? else {
                return Err(AppError::auth("会话已过期，且没有保存的凭据"));
            };
            let c = self.client().await;
            crate::commands::auth::login_flow(&c, &user, &pass).await
        })
        .await;

        if let Err(e) = &result {
            if e.kind == crate::error::ErrorKind::Auth {
                // 由 lib.rs 注册的事件转发器把 auth://expired 广播给前端
                self.notify_expired(&e.message);
            }
        }
        result
    }

    fn notify_expired(&self, message: &str) {
        if let Some(tx) = self.expired_tx.get() {
            let _ = tx.send(message.to_string());
        }
    }
}
```

> 上面 `notify_expired` 依赖一个 `expired_tx` 字段。在 `SessionState` 结构体中加入：
>
> ```rust
> use tokio::sync::broadcast;
>
> // 字段
> expired_tx: std::sync::OnceLock<broadcast::Sender<String>>,
> ```
>
> 并在 `new()` 中加 `expired_tx: std::sync::OnceLock::new(),`。
> 在 `src-tauri/src/lib.rs` 的 `setup` 中初始化：
>
> ```rust
> let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
> let session = app.state::<SessionState>();
> session.set_expired_sender(tx.clone());
> let handle = app.handle().clone();
> let mut rx = tx.subscribe();
> tauri::async_runtime::spawn(async move {
>     while let Ok(msg) = rx.recv().await {
>         let _ = handle.emit("auth://expired", msg);
>     }
> });
> ```
>
> 并给 `SessionState` 加上：
>
> ```rust
> pub fn set_expired_sender(&self, tx: tokio::sync::broadcast::Sender<String>) {
>     let _ = self.expired_tx.set(tx);
> }
> ```

- [ ] **Step 8: 在 Cargo.toml 确认 tokio 已是非测试依赖**

`[dependencies]` 中需要有：

```toml
tokio = { version = "1", features = ["sync", "rt-multi-thread", "macros"] }
```

`emit` 需要 `use tauri::Emitter;`。

- [ ] **Step 9: 注册命令与状态**

把 `src-tauri/src/lib.rs` 的 `run()` 替换为：

```rust
pub mod commands;
pub mod error;
pub mod net;
pub mod secure;
pub mod session;

use tauri::{Emitter, Manager};
use commands::auth::try_silent_login;
use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("无法解析应用数据目录");
            std::fs::create_dir_all(&app_data_dir).ok();

            let handle = app.handle().clone();
            let cfg = commands::config::load(&handle)?;
            let credentials = secure::detect_store(&app_data_dir);
            let state = SessionState::new(&cfg.base_url, credentials);

            let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
            state.set_expired_sender(tx.clone());
            app.manage(state);

            // 把续登失败事件转发给前端
            let mut rx = tx.subscribe();
            let emit_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(msg) = rx.recv().await {
                    let _ = emit_handle.emit("auth://expired", msg);
                }
            });

            // 启动时尝试用钥匙串凭据静默续登
            let login_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = login_handle.state::<SessionState>();
                let _ = try_silent_login(&login_handle.clone(), &state).await;
                let _ = login_handle.emit("auth://ready", ());
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::config_get,
            commands::config::config_set,
            commands::auth::auth_status,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_relogin,
            commands::auth::set_base_url,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
```

- [ ] **Step 10: 编译并跑全部 Rust 测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib 2>&1 | tail -30
```

预期：Task 6-13 的所有测试全部 PASS（共 41 个：error 4 / csrf 5 / redirect 7 / client 9 / session 5 / config 4 / secure 7）

- [ ] **Step 11: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 登录/登出/状态命令与会话状态管理（Cookie 仅存内存）"
```

---

## Task 14: http_request 命令

**Files:**
- Create: `src-tauri/src/net/command.rs`
- Modify: `src-tauri/src/net/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 实现命令**

创建 `src-tauri/src/net/command.rs`：

```rust
use serde::Deserialize;
use tauri::State;

use crate::error::AppError;
use crate::net::client::HttpResult;
use crate::net::session::Method;
use crate::session::SessionState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpArgs {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    #[serde(default)]
    pub form: Vec<(String, String)>,
}

/// 前端唯一的 HTTP 出口。
///
/// Rust 不知道任何业务概念——它只会"按规则发请求、按规则维持登录态"。
/// 业务路径、参数、以及响应体的 HTML 解析全部在前端 TS 侧完成。
#[tauri::command]
pub async fn http_request(
    session: State<'_, SessionState>,
    args: HttpArgs,
) -> Result<HttpResult, AppError> {
    let method = match args.method.to_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        other => {
            return Err(AppError::config(format!("不支持的 HTTP 方法：{other}")));
        }
    };
    session
        .request(method, &args.path, &args.query, &args.form)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_camel_case_args() {
        let a: HttpArgs = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "path": "/deployment/deploy/task/",
            "query": [["page", "2"]],
            "form": []
        }))
        .unwrap();
        assert_eq!(a.method, "GET");
        assert_eq!(a.path, "/deployment/deploy/task/");
        assert_eq!(a.query, vec![("page".to_string(), "2".to_string())]);
    }

    #[test]
    fn query_and_form_default_to_empty() {
        let a: HttpArgs = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "path": "/x/"
        }))
        .unwrap();
        assert!(a.query.is_empty());
        assert!(a.form.is_empty());
    }
}
```

- [ ] **Step 2: 在 mod.rs 中声明**

```rust
pub mod client;
pub mod command;
pub mod csrf;
pub mod redirect;
pub mod session;
```

- [ ] **Step 3: 注册命令**

在 `src-tauri/src/lib.rs` 的 `generate_handler!` 列表中追加一行：

```rust
            net::command::http_request,
```

- [ ] **Step 4: 跑测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib 2>&1 | tail -20
```

预期：全部 PASS（共 43 个，较上一步多出 command 模块的 2 个）

- [ ] **Step 5: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 通用 http_request 命令（业务语义全部留在前端）"
```

---

## Task 15: 前端 IPC 与错误收口

**Files:**
- Create: `src/api/ipc.ts`、`src/api/errors.ts`、`src/api/http.ts`
- Test: `src/api/errors.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/api/errors.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { toUserMessage, isAuthError, type AppError } from "./errors";

describe("toUserMessage", () => {
  it("网络错误提示检查内网连接", () => {
    const e: AppError = { kind: "network", message: "connection reset", retryable: true };
    expect(toUserMessage(e)).toContain("网络");
  });

  it("超时错误单独提示", () => {
    const e: AppError = { kind: "timeout", message: "timed out", retryable: true };
    expect(toUserMessage(e)).toContain("超时");
  });

  it("认证错误提示重新登录", () => {
    const e: AppError = { kind: "auth", message: "bad", retryable: false };
    expect(toUserMessage(e)).toContain("登录");
  });

  it("非 AppError 的异常也能出话术", () => {
    expect(toUserMessage(new Error("boom"))).toContain("boom");
    expect(toUserMessage("字符串错误")).toBeTruthy();
  });

  it("未知形状返回兜底话术", () => {
    expect(toUserMessage({})).toContain("未知");
  });

  it("isAuthError 只认 auth", () => {
    expect(isAuthError({ kind: "auth", message: "", retryable: false })).toBe(true);
    expect(isAuthError({ kind: "network", message: "", retryable: true })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/api/errors.test.ts
```

预期：FAIL，找不到模块 `./errors`

- [ ] **Step 3: 实现 errors.ts**

创建 `src/api/errors.ts`：

```ts
/** 与 Rust `src-tauri/src/error.rs` 的 AppError 一一对应 */
export type ErrorKind =
  | "network"
  | "timeout"
  | "auth"
  | "parse"
  | "server"
  | "config"
  | "io";

export interface AppError {
  kind: ErrorKind;
  message: string;
  retryable: boolean;
}

const FRIENDLY: Record<ErrorKind, string> = {
  network: "网络不可达，请检查内网连接或 VPN",
  timeout: "请求超时，请稍后重试",
  auth: "登录状态已失效，请重新登录",
  parse: "页面结构解析失败，ITSM 可能已改版",
  server: "服务端返回错误，请稍后重试",
  config: "配置有误，请到设置页检查",
  io: "本地读写失败，请检查磁盘权限",
};

function isAppError(v: unknown): v is AppError {
  if (typeof v !== "object" || v === null) return false;
  const k = (v as AppError).kind;
  return typeof k === "string" && k in FRIENDLY;
}

export function isAuthError(v: unknown): boolean {
  return isAppError(v) && v.kind === "auth";
}

export function toAppError(v: unknown): AppError {
  if (isAppError(v)) return v;
  return {
    kind: "server",
    message: v instanceof Error ? v.message : String(v),
    retryable: false,
  };
}

/** 转成给用户看的一句话。原始信息附在后面便于排障。 */
export function toUserMessage(v: unknown): string {
  if (!isAppError(v)) {
    const raw = v instanceof Error ? v.message : typeof v === "string" ? v : "";
    return raw ? `${FRIENDLY.server}（${raw}）` : "发生未知错误";
  }
  return v.message ? `${FRIENDLY[v.kind]}（${v.message}）` : FRIENDLY[v.kind];
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/api/errors.test.ts
```

预期：6 个测试全部 PASS

- [ ] **Step 5: 实现 ipc.ts**

创建 `src/api/ipc.ts`：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { AppError } from "./errors";

/**
 * invoke 的类型化薄封装。
 *
 * Tauri 在命令返回 Err 时，抛出的是命令 error 载荷本身（即 AppError 形状的对象），
 * 所以这里不做任何转换，交给 http.ts / store 统一收口。
 */
export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

export type { AppError };
```

- [ ] **Step 6: 实现 http.ts（唯一网络出口，含 GET 重试）**

创建 `src/api/http.ts`：

```ts
import { call } from "./ipc";
import { toAppError, isAuthError, toUserMessage, type AppError } from "./errors";

export interface HttpResult {
  status: number;
  location: string | null;
  body: string;
}

export type Query = Record<string, string | number> | undefined;
export type Form = Record<string, string>;

function toPairs(o: Record<string, string | number> | undefined): [string, string][] {
  if (!o) return [];
  return Object.entries(o).map(([k, v]) => [k, String(v)]);
}

const GET_RETRY_LIMIT = 2;
const RETRY_BASE_DELAY_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET 请求。
 * 仅 GET 会自动重试（幂等）；POST 一律不重试——见 spec §6.6 的安全红线：
 * 提交部署 / 上线 / 回滚 / 删除都不可重复执行。
 */
export async function httpGet(path: string, query?: Query): Promise<HttpResult> {
  let last: AppError | null = null;
  for (let attempt = 0; attempt <= GET_RETRY_LIMIT; attempt++) {
    try {
      return await call<HttpResult>("http_request", {
        args: { method: "GET", path, query: toPairs(query), form: [] },
      });
    } catch (e) {
      const err = toAppError(e);
      last = err;
      // 认证类错误交给上层走重新登录流程，重试无意义
      if (isAuthError(err)) throw err;
      if (!err.retryable || attempt === GET_RETRY_LIMIT) throw err;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
    }
  }
  throw last ?? toAppError("未知错误");
}

/** POST 请求，绝不重试 */
export async function httpPost(path: string, form?: Form): Promise<HttpResult> {
  return call<HttpResult>("http_request", {
    args: { method: "POST", path, query: [], form: toPairs(form) },
  });
}

/** 302 指向登录页 = 会话过期；其余 302 = 业务成功 */
export function isLoginRedirect(r: HttpResult): boolean {
  if (r.status !== 302 || !r.location) return false;
  const path = r.location.split("?")[0].replace(/\/+$/, "");
  return path === "/login" || path.endsWith("/login");
}

/** 业务成功判定：302 且不是被踢到登录页 */
export function isSuccessRedirect(r: HttpResult): boolean {
  return r.status === 302 && !isLoginRedirect(r);
}

export { toUserMessage, toAppError, isAuthError };
export type { AppError };
```

- [ ] **Step 7: 为 isLoginRedirect 补测试**

创建 `src/api/http.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { isLoginRedirect, isSuccessRedirect, type HttpResult } from "./http";

function r(status: number, location: string | null): HttpResult {
  return { status, location, body: "" };
}

describe("isLoginRedirect", () => {
  it("绝对地址的登录跳转", () => {
    expect(isLoginRedirect(r(302, "https://itsm.zhizhengroup.com/login/?next=/x"))).toBe(true);
  });

  it("相对地址的登录跳转", () => {
    expect(isLoginRedirect(r(302, "/login/"))).toBe(true);
  });

  it("业务跳转不算登录跳转", () => {
    expect(isLoginRedirect(r(302, "/deployment/deploy/task/"))).toBe(false);
  });

  it("200 不算", () => {
    expect(isLoginRedirect(r(200, "/login/"))).toBe(false);
  });

  it("query 里出现 /login/ 不误判", () => {
    expect(isLoginRedirect(r(302, "/deployment/deploy/task/?ref=/login/"))).toBe(false);
  });
});

describe("isSuccessRedirect", () => {
  it("业务 302 是成功", () => {
    expect(isSuccessRedirect(r(302, "/deployment/deploy/task/"))).toBe(true);
  });

  it("会话过期的 302 不是成功", () => {
    expect(isSuccessRedirect(r(302, "/login/?next=/x"))).toBe(false);
  });
});
```

- [ ] **Step 8: 运行全部前端测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test
```

预期：tabs(6) + errors(6) + http(7) = 19 个测试全部 PASS

- [ ] **Step 9: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 前端 IPC 封装、错误话术、GET 重试与 POST 不重试"
```

---

## Task 16: 登录页与 auth store

**Files:**
- Create: `src/api/auth.ts`、`src/stores/auth.ts`、`src/views/LoginView.vue`
- Modify: `src/App.vue`
- Test: `src/stores/auth.test.ts`

- [ ] **Step 1: 实现 auth API**

创建 `src/api/auth.ts`：

```ts
import { call } from "./ipc";

export interface AuthStatus {
  loggedIn: boolean;
  username: string;
  baseUrl: string;
  credentialBackend: "keyring" | "encryptedFile";
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return call<AuthStatus>("auth_status");
}

export function login(
  username: string,
  password: string,
  remember: boolean,
): Promise<LoginResult> {
  return call<LoginResult>("auth_login", { username, password, remember });
}

export function logout(): Promise<void> {
  return call<void>("auth_logout");
}

export function relogin(): Promise<LoginResult> {
  return call<LoginResult>("auth_relogin");
}

export function setBaseUrl(baseUrl: string): Promise<void> {
  return call<void>("set_base_url", { baseUrl });
}
```

- [ ] **Step 2: 写失败的测试**

创建 `src/stores/auth.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/auth", () => ({
  getAuthStatus: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  relogin: vi.fn(),
  setBaseUrl: vi.fn(),
}));

import * as authApi from "@/api/auth";
import { useAuthStore } from "./auth";

describe("auth store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refresh 后填入登录态", async () => {
    vi.mocked(authApi.getAuthStatus).mockResolvedValue({
      loggedIn: true,
      username: "zhangsan",
      baseUrl: "https://itsm.zhizhengroup.com",
      credentialBackend: "keyring",
    });
    const s = useAuthStore();
    await s.refresh();
    expect(s.loggedIn).toBe(true);
    expect(s.username).toBe("zhangsan");
    expect(s.credentialBackend).toBe("keyring");
  });

  it("登录成功写入状态", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ ok: true, message: "" });
    const s = useAuthStore();
    const ok = await s.login("lisi", "pw", true);
    expect(ok).toBe(true);
    expect(s.loggedIn).toBe(true);
    expect(s.username).toBe("lisi");
    expect(s.error).toBe("");
  });

  it("登录失败保留错误信息且不置为已登录", async () => {
    vi.mocked(authApi.login).mockResolvedValue({ ok: false, message: "用户名或密码错误" });
    const s = useAuthStore();
    const ok = await s.login("lisi", "bad", true);
    expect(ok).toBe(false);
    expect(s.loggedIn).toBe(false);
    expect(s.error).toBe("用户名或密码错误");
  });

  it("登录期间 loading 为 true，结束后复位", async () => {
    let resolve!: (v: authApi.LoginResult) => void;
    vi.mocked(authApi.login).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const s = useAuthStore();
    const p = s.login("a", "b", false);
    expect(s.loading).toBe(true);
    resolve({ ok: true, message: "" });
    await p;
    expect(s.loading).toBe(false);
  });

  it("logout 清空状态", async () => {
    vi.mocked(authApi.logout).mockResolvedValue(undefined);
    const s = useAuthStore();
    s.loggedIn = true;
    s.username = "zhangsan";
    await s.logout();
    expect(s.loggedIn).toBe(false);
    expect(s.username).toBe("");
  });

  it("会话过期事件把 loggedIn 置 false 并带上原因", () => {
    const s = useAuthStore();
    s.loggedIn = true;
    s.handleExpired("会话已过期，且没有保存的凭据");
    expect(s.loggedIn).toBe(false);
    expect(s.error).toContain("过期");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/auth.test.ts
```

预期：FAIL，找不到模块 `./auth`

- [ ] **Step 4: 实现 auth store**

创建 `src/stores/auth.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import * as authApi from "@/api/auth";

export const useAuthStore = defineStore("auth", () => {
  const loggedIn = ref(false);
  const username = ref("");
  const baseUrl = ref("https://itsm.zhizhengroup.com");
  const credentialBackend = ref<"keyring" | "encryptedFile">("keyring");
  const loading = ref(false);
  const error = ref("");

  async function refresh(): Promise<void> {
    const s = await authApi.getAuthStatus();
    loggedIn.value = s.loggedIn;
    username.value = s.username;
    baseUrl.value = s.baseUrl;
    credentialBackend.value = s.credentialBackend;
  }

  async function login(user: string, password: string, remember: boolean): Promise<boolean> {
    loading.value = true;
    error.value = "";
    try {
      const r = await authApi.login(user, password, remember);
      if (r.ok) {
        loggedIn.value = true;
        username.value = user;
        await refresh();
      } else {
        error.value = r.message || "登录失败";
      }
      return r.ok;
    } finally {
      loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    await authApi.logout();
    loggedIn.value = false;
    username.value = "";
    error.value = "";
  }

  async function changeBaseUrl(url: string): Promise<void> {
    await authApi.setBaseUrl(url);
    baseUrl.value = url.replace(/\/$/, "");
  }

  /** 收到 Rust 的 auth://expired 事件时调用 */
  function handleExpired(reason: string): void {
    loggedIn.value = false;
    error.value = reason || "登录状态已失效，请重新登录";
  }

  return {
    loggedIn,
    username,
    baseUrl,
    credentialBackend,
    loading,
    error,
    refresh,
    login,
    logout,
    changeBaseUrl,
    handleExpired,
  };
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/auth.test.ts
```

预期：6 个测试全部 PASS

- [ ] **Step 6: 写登录页**

创建 `src/views/LoginView.vue`：

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useAuthStore } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const auth = useAuthStore();
const username = ref("");
const password = ref("");
const remember = ref(true);
const showAdvanced = ref(false);
const baseUrlDraft = ref(auth.baseUrl);

async function onSubmit(): Promise<void> {
  if (!username.value.trim() || !password.value) {
    auth.error = "请输入用户名和密码";
    return;
  }
  await auth.login(username.value.trim(), password.value, remember.value);
}

async function onSaveBaseUrl(): Promise<void> {
  await auth.changeBaseUrl(baseUrlDraft.value.trim());
  showAdvanced.value = false;
}
</script>

<template>
  <div class="h-full flex items-center justify-center bg-bg">
    <div class="w-[380px] p-8 rounded-lg border border-border bg-surface">
      <h1 class="text-lg font-semibold mb-1">至真部署</h1>
      <p class="text-xs text-text-muted mb-6">使用 ITSM 账号登录</p>

      <div class="space-y-4">
        <div class="space-y-1.5">
          <Label for="login-username">用户名</Label>
          <Input id="login-username" v-model="username" placeholder="请输入用户名"
                 :disabled="auth.loading" @keyup.enter="onSubmit" />
        </div>

        <div class="space-y-1.5">
          <Label for="login-password">密码</Label>
          <Input id="login-password" v-model="password" type="password" placeholder="请输入密码"
                 :disabled="auth.loading" @keyup.enter="onSubmit" />
        </div>

        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Switch id="remember" v-model="remember" />
            <Label for="remember" class="text-text-muted">记住密码（存入系统钥匙串）</Label>
          </div>
          <button class="text-xs text-text-muted hover:text-text underline"
                  @click="showAdvanced = !showAdvanced">服务器</button>
        </div>

        <div v-if="showAdvanced" class="space-y-2 p-3 rounded-md bg-surface-2">
          <Label for="base-url" class="text-xs">ITSM 地址</Label>
          <Input id="base-url" v-model="baseUrlDraft" placeholder="https://itsm.zhizhengroup.com" />
          <Button variant="outline" size="sm" class="w-full" @click="onSaveBaseUrl">保存地址</Button>
        </div>

        <p v-if="auth.error" class="text-xs text-danger">{{ auth.error }}</p>

        <Button class="w-full" :disabled="auth.loading" @click="onSubmit">
          {{ auth.loading ? "登录中…" : "登录" }}
        </Button>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 7: 接入 App.vue 并监听事件**

替换 `src/App.vue`：

```vue
<script setup lang="ts">
import { computed, onMounted } from "vue";
import { listen } from "@tauri-apps/api/event";
import TitleBar from "./components/layout/TitleBar.vue";
import SideNav from "./components/layout/SideNav.vue";
import TabBar from "./components/layout/TabBar.vue";
import WipView from "./views/WipView.vue";
import LoginView from "./views/LoginView.vue";
import { useTabsStore } from "./stores/tabs";
import { useAuthStore } from "./stores/auth";

const tabs = useTabsStore();
const auth = useAuthStore();

const activeTitle = computed(() => (tabs.activeTab ? tabs.titleOf(tabs.activeTab) : ""));

onMounted(async () => {
  await listen<string>("auth://expired", (e) => auth.handleExpired(e.payload));
  await listen("auth://ready", () => auth.refresh());
  await auth.refresh();
});
</script>

<template>
  <div class="h-full flex flex-col bg-bg text-text">
    <TitleBar />

    <LoginView v-if="!auth.loggedIn" />

    <div v-else class="flex-1 flex min-h-0">
      <SideNav />
      <div class="flex-1 flex flex-col min-w-0">
        <TabBar />
        <main class="flex-1 min-h-0 overflow-auto">
          <WipView v-if="tabs.activeTab" :title="activeTitle" />
          <div v-else class="h-full flex items-center justify-center text-text-muted">
            从左侧导航打开一个页面
          </div>
        </main>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 8: 在 capabilities 中允许自定义事件监听**

Tauri 2 的 `core:default` 已包含 `core:event:allow-listen`。若运行时报权限错误，在 `src-tauri/capabilities/default.json` 的 `permissions` 中补：

```json
"core:event:default"
```

- [ ] **Step 9: 端到端手工验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri dev
```

按顺序验证：

1. 应用启动后显示登录页（全屏，无侧栏）
2. 输入**错误**密码 → 页面显示「用户名或密码错误」，不进入主界面
3. 输入**正确**密码 → 进入主界面，左侧出现导航，标签栏显示「从左侧导航打开一个页面」
4. 勾选「记住密码」登录成功后：在 macOS 打开「钥匙串访问」，搜索 `com.zhizhengroup.deploy`，应能看到一条记录
5. **关闭应用并重启** → 应直接进入主界面，不再要求输入密码（静默续登生效）
6. 设置页中（Task 17 完成后）点「退出登录」→ 回到登录页

- [ ] **Step 10: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 登录页与 auth store（含记住密码、静默续登、过期事件处理）"
```

---

## Task 17: 设置页与主题

**Files:**
- Create: `src/api/config.ts`、`src/stores/settings.ts`、`src/stores/theme.ts`、`src/views/SettingsView.vue`
- Modify: `src/App.vue`
- Test: `src/stores/theme.test.ts`

- [ ] **Step 1: 实现 config API**

创建 `src/api/config.ts`：

```ts
import { call } from "./ipc";

export interface AppConfig {
  baseUrl: string;
  theme: "system" | "dark" | "light";
  username: string;
  closeBehavior: "tray" | "quit";
  pollIntervalSecs: number;
}

export function getConfig(): Promise<AppConfig> {
  return call<AppConfig>("config_get");
}

export function setConfig(patch: AppConfig): Promise<AppConfig> {
  return call<AppConfig>("config_set", { patch });
}
```

- [ ] **Step 2: 写失败的测试**

创建 `src/stores/theme.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/config", () => ({
  getConfig: vi.fn(),
  setConfig: vi.fn(),
}));

import { useThemeStore } from "./theme";

describe("theme store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    document.documentElement.classList.remove("dark");
  });

  it("dark 模式给根元素加 dark 类", () => {
    const s = useThemeStore();
    s.apply("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("light 模式移除 dark 类", () => {
    const s = useThemeStore();
    s.apply("dark");
    s.apply("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("system 模式跟随 prefers-color-scheme", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const s = useThemeStore();
    s.apply("system");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("记录当前 mode 以便设置页回显", () => {
    const s = useThemeStore();
    s.apply("light");
    expect(s.mode).toBe("light");
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/theme.test.ts
```

预期：FAIL，找不到模块 `./theme`

- [ ] **Step 4: 实现 theme store**

创建 `src/stores/theme.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";

export type ThemeMode = "system" | "dark" | "light";

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const useThemeStore = defineStore("theme", () => {
  const mode = ref<ThemeMode>("system");
  let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

  function resolve(m: ThemeMode): boolean {
    if (m === "dark") return true;
    if (m === "light") return false;
    return window.matchMedia(MEDIA_QUERY).matches;
  }

  function paint(isDark: boolean): void {
    document.documentElement.classList.toggle("dark", isDark);
  }

  function apply(m: ThemeMode): void {
    mode.value = m;
    paint(resolve(m));

    if (mediaListener) {
      window.matchMedia(MEDIA_QUERY).removeEventListener("change", mediaListener);
      mediaListener = null;
    }
    // 仅在 system 模式下跟随系统实时切换（spec §6.5）
    if (m === "system") {
      mediaListener = (e) => paint(e.matches);
      window.matchMedia(MEDIA_QUERY).addEventListener("change", mediaListener);
    }
  }

  return { mode, apply };
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/theme.test.ts
```

预期：4 个测试全部 PASS

- [ ] **Step 6: 实现 settings store**

创建 `src/stores/settings.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import * as configApi from "@/api/config";
import { useThemeStore } from "./theme";
import { useAuthStore } from "./auth";

export const useSettingsStore = defineStore("settings", () => {
  const baseUrl = ref("https://itsm.zhizhengroup.com");
  const theme = ref<"system" | "dark" | "light">("system");
  const closeBehavior = ref<"tray" | "quit">("tray");
  const pollIntervalSecs = ref(60);
  const loaded = ref(false);

  async function load(): Promise<void> {
    const c = await configApi.getConfig();
    baseUrl.value = c.baseUrl;
    theme.value = c.theme;
    closeBehavior.value = c.closeBehavior;
    pollIntervalSecs.value = c.pollIntervalSecs;
    loaded.value = true;
    useThemeStore().apply(c.theme);
  }

  async function patch(partial: Partial<configApi.AppConfig>): Promise<void> {
    const next = await configApi.setConfig({
      baseUrl: partial.baseUrl ?? baseUrl.value,
      theme: partial.theme ?? theme.value,
      username: partial.username ?? "",
      closeBehavior: partial.closeBehavior ?? closeBehavior.value,
      pollIntervalSecs: partial.pollIntervalSecs ?? pollIntervalSecs.value,
    });
    baseUrl.value = next.baseUrl;
    theme.value = next.theme;
    closeBehavior.value = next.closeBehavior;
    pollIntervalSecs.value = next.pollIntervalSecs;
    if (partial.theme) useThemeStore().apply(next.theme);
    // baseUrl 变更时，Rust 侧已在 config_set 里重建了 HttpClient（见 Task 13 Step 6）。
    // 这里只需把新地址同步回 auth store 供界面展示，不要再调一次 set_base_url，
    // 否则会重复写一次配置文件。
    if (partial.baseUrl) await useAuthStore().refresh();
  }

  return { baseUrl, theme, closeBehavior, pollIntervalSecs, loaded, load, patch };
});
```

- [ ] **Step 7: 写设置页**

创建 `src/views/SettingsView.vue`：

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const settings = useSettingsStore();
const auth = useAuthStore();

const baseUrlDraft = ref("");
const saved = ref("");

onMounted(async () => {
  if (!settings.loaded) await settings.load();
  baseUrlDraft.value = settings.baseUrl;
});

async function saveBaseUrl(): Promise<void> {
  await settings.patch({ baseUrl: baseUrlDraft.value.trim() });
  flash("地址已保存，下次请求生效");
}

function flash(msg: string): void {
  saved.value = msg;
  setTimeout(() => (saved.value = ""), 2500);
}

const backendLabel = () =>
  auth.credentialBackend === "keyring" ? "系统钥匙串" : "加密文件（本机未启用系统钥匙串）";
</script>

<template>
  <div class="max-w-[640px] p-6 space-y-8">
    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-text-muted uppercase tracking-wide">服务</h2>
      <div class="space-y-1.5">
        <Label for="s-base-url">ITSM 地址</Label>
        <div class="flex gap-2">
          <Input id="s-base-url" v-model="baseUrlDraft" />
          <Button @click="saveBaseUrl">保存</Button>
        </div>
      </div>
      <div class="flex items-center justify-between text-xs">
        <span class="text-text-muted">当前登录用户</span>
        <span>{{ auth.username || "未登录" }}</span>
      </div>
      <Button variant="outline" size="sm" @click="auth.logout()">退出登录</Button>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-text-muted uppercase tracking-wide">凭据</h2>
      <div class="flex items-center justify-between text-xs">
        <span class="text-text-muted">存储方式</span>
        <span>{{ backendLabel() }}</span>
      </div>
      <p v-if="auth.credentialBackend === 'encryptedFile'" class="text-xs text-warning">
        本机未检测到系统钥匙串，密码以加密文件形式保存在应用数据目录。
        该文件与密钥同机存放，仅能防止明文外泄，无法防御本机读取。
      </p>
      <Button variant="outline" size="sm" @click="auth.logout()">清除已保存凭据</Button>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-text-muted uppercase tracking-wide">外观</h2>
      <div class="flex gap-2">
        <Button
          v-for="m in (['system', 'light', 'dark'] as const)"
          :key="m"
          :variant="settings.theme === m ? 'default' : 'outline'"
          size="sm"
          @click="settings.patch({ theme: m })"
        >
          {{ m === "system" ? "跟随系统" : m === "light" ? "浅色" : "深色" }}
        </Button>
      </div>
    </section>

    <section class="space-y-3">
      <h2 class="text-sm font-semibold text-text-muted uppercase tracking-wide">行为</h2>
      <div class="flex items-center justify-between">
        <Label for="s-close">关闭窗口时最小化到托盘</Label>
        <Switch
          id="s-close"
          :model-value="settings.closeBehavior === 'tray'"
          @update:model-value="(v: boolean) => settings.patch({ closeBehavior: v ? 'tray' : 'quit' })"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="s-poll">列表轮询间隔（秒）</Label>
        <Input
          id="s-poll"
          type="number"
          :model-value="String(settings.pollIntervalSecs)"
          min="10"
          max="3600"
          @change="(e: Event) => settings.patch({ pollIntervalSecs: Number((e.target as HTMLInputElement).value) })"
        />
      </div>
      <p class="text-xs text-text-muted">
        托盘常驻、构建完成通知将在后续计划（P6）中实现。
      </p>
    </section>

    <p v-if="saved" class="text-xs text-success">{{ saved }}</p>
  </div>
</template>
```

- [ ] **Step 8: 把设置页接到标签内容区**

替换 `src/App.vue` 的 `<main>` 内部：

```vue
        <main class="flex-1 min-h-0 overflow-auto">
          <SettingsView v-if="tabs.activeTab?.kind === 'settings'" />
          <WipView v-else-if="tabs.activeTab" :title="activeTitle" />
          <div v-else class="h-full flex items-center justify-center text-text-muted">
            从左侧导航打开一个页面
          </div>
        </main>
```

并在 `App.vue` 的 import 中加入：

```ts
import SettingsView from "./views/SettingsView.vue";
import { useSettingsStore } from "./stores/settings";
```

在 `onMounted` 中追加：

```ts
  await useSettingsStore().load();
```

- [ ] **Step 9: 手工验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri dev
```

预期：
1. 登录后点左侧「设置」→ 打开设置标签
2. 点「深色」「浅色」「跟随系统」→ 界面立即切换主题，无需重启
3. 选「跟随系统」后，在系统设置里切换外观 → 应用实时跟随
4. 「凭据 - 存储方式」显示 `系统钥匙串`（macOS）或降级提示（Linux）
5. 修改 ITSM 地址并保存 → 提示「地址已保存」
6. 点「退出登录」→ 回到登录页

- [ ] **Step 10: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 设置页、settings store 与三档主题（含跟随系统实时切换）"
```

---

## Task 18: 里程碑验证

**Files:** 无新增

- [ ] **Step 1: 跑全部前端测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test
```

预期：30 个测试全部 PASS（tabs 7 / errors 6 / http 7 / auth 6 / theme 4）

- [ ] **Step 2: 跑全部 Rust 测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib 2>&1 | tail -30
```

预期：全部 PASS，0 failed

- [ ] **Step 3: 前端类型检查与构建**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npx vue-tsc --noEmit
npm run build
```

预期：无类型错误，构建成功

- [ ] **Step 4: 自动续登端到端验证（本计划最关键的一条）**

这是验证 spec §2.1 第 4 条与 §4.1 是否真正落地的唯一方式。

1. 启动 `npm run tauri dev`，用正确密码登录，勾选「记住密码」
2. 确认进入主界面
3. **在浏览器里登录同一个 ITSM 账号**，然后点浏览器的「退出登录」（这会让服务端使之前的 session 失效）
4. 回到桌面应用，点左侧「设置」→ 修改 ITSM 地址为一个无关值再改回来并保存（触发一次真实请求）
5. 观察结果

预期：**应用不弹登录页**，请求自动续登成功并正常返回。在终端里能看到续登过程发生的日志。

如果第 5 步弹出登录页，说明续登链路有问题，需检查：
- `src-tauri/src/session.rs` 的 `request()` 是否真的被调用（`http_request` 命令走的是 `session.request`）
- 钥匙串里是否确实存了凭据（macOS「钥匙串访问」搜索 `com.zhizhengroup.deploy`）
- `login_flow` 里的探测请求（`GET /deployment/deploy/task/`）是否返回 302

- [ ] **Step 5: 关闭窗口行为验证**

预期：点关闭按钮后应用退出（托盘行为属于 P6；此阶段 `closeBehavior` 已在配置中持久化，但尚未生效，属预期）

- [ ] **Step 6: 三端构建验证**

在各自平台上分别执行：

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri build -- --no-bundle
```

预期：macOS / Windows / Linux 各自编译通过。**三端都要跑**——Tauri 的 Webview 与窗口装饰在不同平台差异明显，这是 spec §12 列出的风险。

- [ ] **Step 7: 提交里程碑**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "chore: Plan 1 里程碑验证通过（P0 脚手架 + P1 认证与网络层）" --allow-empty
git log --oneline | head -20
```

---

---

## 执行结果（2026-10-13 完成）

| 验收项 | 结果 |
|---|---|
| Rust 单元测试 | ✅ 56 passed / 1 ignored（另有 1 个真实环境 e2e，手工运行通过） |
| 前端 Vitest | ✅ 47 passed（tabs 7 / errors 7 / http 9 / auth 8 / theme 8 / settings 8） |
| `vue-tsc --noEmit` | ✅ 无类型错误 |
| 登录页区分正确/错误密码 | ✅ 用户实测 |
| 记住密码后重启免登录 | ✅ 用户实测 |
| **会话失效后静默续登** | ✅ 真实 ITSM e2e 实测，Replay 拿回 106892 字节任务列表 |
| 主题三档 + 跟随系统实时切换 | ✅ 用户实测 |
| macOS 钥匙串条目 | ✅ `security find-generic-password` 独立核验 |
| 标签栏单例规则 | ✅ 用户实测 |
| release 构建 | ✅ macOS arm64 通过（5.1MB）；**Windows / Linux 未验** |
| 三端构建 | ⚠️ 仅 macOS。Windows / Linux 需在对应机器上执行 `npm run tauri build --no-bundle` |

### 执行中发现并修掉的问题（计划稿的缺陷）

1. `style.css` 里 `@theme inline` 写出 `var()` 自引用；且与 shadcn 的
   `--color-accent` / `--color-border` 撞名，后者在后方会覆盖品牌色
2. `vite.config.ts` 用了 ESM 下不存在的 `__dirname`
3. tsconfig 的 `baseUrl` 在 TypeScript 6 已弃用
4. `settings.patch` 传 `username: partial.username ?? ""`，改主题会清空用户名
5. **`baseUrl` 同时存放于两个 store**，导致登录页改了地址后设置页显示旧值
   （用户实测报出）。已收口为 settings store 单一持有者
6. 自动续登只串行化未去重，N 个并发请求会触发 N 次登录（已用登录代际计数修复）
7. capabilities 提前声明未安装插件的权限会导致构建失败
8. `keyring` 用通用依赖声明会把 D-Bus 拉进 macOS 构建
9. `Jar::add_cookie_str` 按单条 Set-Cookie 解析，传 `a=1; b=2` 会丢后半段
10. 设置页「退出登录」与「清除凭据」原本都调 `auth.logout()`，行为重复

### 交付物

```
zz-deploy-desktop/
├── src/                      Vue 3 前端（api / stores / components / views）
├── src-tauri/                Rust 能力层（net / secure / session / commands）
├── docs/superpowers/specs/   设计方案
└── docs/superpowers/plans/   本实施计划
```

Rust 能力层已就绪，Plan 2 只需在前端写业务请求与解析，无需再动 Rust。

## Plan 1 完成标准

全部满足即视为 P0 + P1 交付完成：

- [ ] Rust 单元测试全绿（共 43 个：error 4 / csrf 5 / redirect 7 / client 9 / session 5 / config 4 / secure 7 / command 2）
- [ ] 前端 Vitest 全绿（共 30 个）
- [ ] `npx vue-tsc --noEmit` 无错误
- [ ] 三端 `npm run tauri build --no-bundle` 均通过
- [ ] 登录页能区分正确/错误密码
- [ ] 勾选「记住密码」后重启应用无需重新登录
- [ ] 服务端 session 失效后，应用能静默续登，用户无感
- [ ] 主题三档即时切换，跟随系统模式能实时响应系统外观变化
- [ ] macOS 上钥匙串可见 `com.zhizhengroup.deploy` 条目
- [ ] 标签栏单例规则正确（设置点两次只有一个标签；向导点两次有两个）

**下一计划：** Plan 2（P2 + P3 + P5）——新建部署向导、任务列表、收藏，完成后功能与 VSCode 插件 1:1 对齐。
