# 至真部署（桌面客户端）

内部运维平台 ITSM 的部署桌面客户端：自动化部署 / Docker 部署、实时构建日志、收藏快速部署、
历史日志留存、系统托盘与构建完成通知。功能与 `vscode-zz-deploy` 插件对齐，并补上桌面端特有的体验。

## 开发

```bash
npm install                 # 前端依赖
npm run dev                 # 只跑前端（Vite）
npm run tauri dev           # 跑完整应用（会自动带上 npm run dev）

npm test                    # 前端单测（Vitest）
npm run build               # 类型检查 + 前端构建
cd src-tauri && cargo test  # Rust 单测
```

## 打包

```bash
npm run tauri build                                   # 当前平台
npm run tauri build -- --target universal-apple-darwin # macOS 通用包
```

产物在 `src-tauri/target/release/bundle/`。**三端产物必须在各自平台上构建**，Tauri 不支持交叉编译打包。
未签名版本的放行步骤见 [`docs/install-unsigned.md`](docs/install-unsigned.md)。

## 结构

```
src/                前端（Vue 3 + Pinia + Tailwind + shadcn-vue）
  api/              Rust 命令与 HTTP 的薄封装；parser.ts 负责 ITSM 的 HTML 解析
  stores/           会话、任务、收藏、日志、历史、设置
  composables/      日志事件入口、构建完成通知、快捷键
  views/            登录 / 向导 / 任务列表 / 收藏 / 日志 / 历史 / 设置
src-tauri/src/      Rust 能力层
  net/              HTTP 客户端（Cookie 只在内存、302 语义、CSRF、自动续登）
  ws/               构建日志 WebSocket（握手需带 Cookie，所以必须在 Rust）
  logs/             日志落盘、索引与保留策略
  commands/         IPC 命令；tray.rs 常驻托盘
docs/superpowers/   设计与实施计划（spec 为准）
```

设计约束与取舍见 `docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md`。
