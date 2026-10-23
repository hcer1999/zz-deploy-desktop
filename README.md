# 至真部署（桌面客户端）

内部运维平台 ITSM 的部署桌面客户端：接入原运维平台的部署功能，
并补上网页端做不到的桌面体验。

- **部署**：自动化部署 / Docker 部署，选环境 → 项目 → 分支 → Commit → 提交
- **批量部署**：购物车式批量计划——每项自带环境/项目/分支/commit，可**跨环境、跨分支、跨部署类型**攒一批再一起提交；右侧清单可移除与逐项修改，整批构建完**只汇总一条通知**；可选「构建成功即自动上线」（默认关）；可**存成批量收藏**反复用、随时修改
- **实时构建日志**：WebSocket 流式输出（服务端推全量快照，客户端只追加增量），docker 的进度行原地更新；**语法高亮**（失败/警告/成功/Step/进度/hash）、**查找与命中高亮**（⌘F）、`$<3>` 还原为换行；日志同时落盘留存
- **收藏**：支持「仅项目」与「项目+分支」两种粒度，可按 项目 / 环境 / 分支 筛选，可拖动排序（筛选时禁用拖动），一键复用（部署时分支仍可改）
- **任务列表**：上下线 / 回滚 / 重新构建（仅构建失败时） / 删除 / 查看日志，自动轮询
- **历史日志**：列表、搜索、展开、导出、删除、按天数和条数保留；大日志只读末尾预览、分片解析，不再卡死界面
- **应用内更新**：启动后台检查 / 关于页与托盘手动检查；发现新版本点「立即更新」即可在客户端内下载、校签、安装，重启生效，不需要用户再去下载新包
- **首页（启动器）**：没打开标签时显示品牌头与六个常用入口，点卡片即进入
- **关于页**：介绍、更新日志（`src/data/changelog.ts`，发版时在头部加一条）、logo 原图、版本号与构建时间
- **品牌标**：`src/assets/reframe-draw-on.svg`（draw-on：先画方块与沙漏的描边再填色；资产自带青底 `#00ADC3`）
- **桌面能力**：启动欢迎页（同时遮住登录状态判定的空窗，避免登录页闪屏）、系统托盘与关闭到托盘、构建完成系统通知（**默认始终通知、且只通知自己提交的任务**）、键盘快捷键、深浅主题、侧边栏可展开

---

## 一、安装（给使用者）

### macOS

1. 双击 `.dmg`，把「至真部署」拖进「应用程序」
2. 首次打开会被系统拦下（应用**未做 Apple 公证**，见下方说明），按提示放行：
   - 提示「无法验证开发者 / Apple 无法检查是否包含恶意软件」→
     打开「系统设置 → 隐私与安全性」，在底部点「**仍要打开**」
     （macOS 15 起「右键 → 打开」的旧技巧已失效）
   - 提示「**已损坏，无法打开**」→ 终端执行下面这行，之后双击即可：
     ```bash
     xattr -dr com.apple.quarantine "/Applications/至真部署.app"
     ```
3. 用**你自己的** ITSM 账号登录；勾选「记住密码」后会话过期会自动重登

> 完整说明（含两种提示的区别、完整性校验、让同事完全看不到提示的办法）见
> [`docs/install-unsigned.md`](docs/install-unsigned.md)。

### Windows

双击 `.msi` 安装；若出现 SmartScreen 提示 → 「更多信息」→「仍要运行」。

### Linux

```bash
chmod +x 至真部署_*.AppImage && ./至真部署_*.AppImage
# 或
sudo dpkg -i 至真部署_*.deb
```

### 使用前提与数据位置

- **网络**：需要能访问 ITSM（内网 / VPN）。连不上时表现为登录或列表请求超时。
- **账号**：每人用自己的账号，互不影响。
- **本机数据**（macOS `~/Library/Application Support/com.zhizhengroup.deploy/`）：

  | 文件 | 内容 |
  |---|---|
  | `config.json` | 地址、主题、关闭行为、轮询间隔、日志保留策略、通知条件、侧边栏展开、上次用的部署类型与环境 |
  | `favorites.json` | 收藏 |
  | `batch_favorites.json` | 批量部署收藏（环境 + 分支 + 一批项目；不记 commit 与自动上线开关） |
  | `credentials.bin` + `credentials.key` | 记住的账号密码（AES-256-GCM 加密，**不写系统钥匙串**） |
  | `logs/` | 历史日志（索引 + 正文） |

- **卸载**：把 App 拖进废纸篓；想彻底重置再删上面那个目录（会需要重新登录、收藏清空）。

---

## 二、从源码构建

### 前置依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（本机 24） | 前端构建与测试 |
| Rust | stable（`rustup`） | Tauri 后端 |
| macOS | — | Xcode Command Line Tools（`xcode-select --install`） |
| Windows | — | MSVC 工具链 + WebView2 Runtime |
| Linux | — | `libwebkit2gtk-4.1-dev`、`libappindicator3-dev`、`librsvg2-dev` 等 |

### 开发与测试

```bash
npm ci                     # 安装前端依赖
npm run tauri dev          # 启动应用（自动带起 Vite）
npm run dev                # 只跑前端（浏览器里预览界面，Tauri IPC 不可用）

npm test                   # 前端单测（Vitest）
npm run test:watch         # 前端单测 watch
npx vue-tsc --noEmit       # 类型检查（npm run build 里也会跑）
cd src-tauri && cargo test # Rust 单测
```

另有需要真实内网环境的工具（默认跳过，手动才跑）：

```bash
cd src-tauri
cargo test -- --ignored        # 真实续登 e2e（会消耗一次登录）
cargo run --example probe_cookies      # 探查 CSRF / cookie 行为
cargo run --example capture_fixtures   # 刷新 HTML fixture（ITSM 改版时用）
cargo run --example probe_log_ws -- <taskId> auto   # 打印日志 WebSocket 的原始帧（排查「日志不实时更新」）
```

### 打包

```bash
npm run tauri build                                   # 当前平台（不含 updater 产物，无需签名密钥）
npm run tauri build -- --target universal-apple-darwin # macOS 通用包（需先 rustup target add x86_64-apple-darwin）

# 发版（生成 .app.tar.gz / .exe / AppImage 的 .sig，供应用内更新使用）
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/zz-deploy-desktop.key"
npm run build:release
```

产物：

| 平台 | 路径 |
|---|---|
| macOS | `src-tauri/target/release/bundle/dmg/*.dmg`、`bundle/macos/*.app` |
| Windows | `src-tauri/target/release/bundle/msi/*.msi`、`bundle/nsis/*.exe` |
| Linux | `src-tauri/target/release/bundle/appimage/*.AppImage`、`bundle/deb/*.deb` |

**三端产物必须在各自平台上构建**，Tauri 不支持交叉编译打包。
`build:release` 的签名密钥、`latest.json` 与发布流程见 [`docs/updates.md`](docs/updates.md)。

### 版本号

三处必须一致（标题、Dock、关于页、包名都从这里来）：

| 位置 | 作用 |
|---|---|
| `src-tauri/tauri.conf.json` 的 `version` | **真值**：`getVersion()` 与 dmg/msi 文件名都用它 |
| `package.json` 的 `version` | 前端工程版本 |
| `src-tauri/Cargo.toml` 的 `version` | crate 版本 |
| `src-tauri/Cargo.lock` 里的 `zz-deploy-desktop` 条目 | 顺手一起改：不改的话下次 `cargo` 会改回来，出现无谓 diff |

窗口标题与设置页「关于」都取运行时版本，所以不会与上面漂移。

### macOS 签名现状（重要）

`tauri.conf.json` 里 `bundle.macOS.signingIdentity: "-"`（ad-hoc 签名**整个 bundle**）**不能删**：
没有它，主二进制只有 linker 签名而 bundle 缺 `_CodeSignature/CodeResources`，
`codesign --verify` 会报 `code has no resources but signature indicates they must be present`，
用户侧表现是「**已损坏**」且**没有任何放行入口**——等于发不出去。

出包后建议自检：

```bash
APP="src-tauri/target/release/bundle/macos/至真部署.app"
codesign --verify --deep --strict "$APP"; echo "期望退出码 0"
codesign -dv --verbose=2 "$APP" | grep Sealed    # 期望 Sealed Resources version=2
spctl -a -vv -t exec "$APP"                      # 期望 rejected（未公证属正常）
```

要彻底去掉同事的放行步骤，需要 Apple Developer 账号做 Developer ID 签名 + 公证；
配置已留好接口，带环境变量构建即可（会自动覆盖 ad-hoc 签名）：

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: <名字> (<TEAMID>)"
export APPLE_ID=... APPLE_PASSWORD=... APPLE_TEAM_ID=...
npm run tauri build
```

### 推送给同事前自检（重要）

**本地能编译 ≠ 仓库完整**。被 `.gitignore` 忽略的源码文件不会进版本库，而 `git status`
也看不到它们（被忽略的文件不显示），所以“工作区干净”不能当作可构建的证明。
实测踩过：`.gitignore` 里一条 `logs/` 把源码目录 `src-tauri/src/logs/` 一起忽略了，
本地一直正常，但从仓库 clone/下载 ZIP 的人编译必报 `file not found for module logs`。

所以每次推送前（尤其是改了目录名/新增目录时）跑一遍**干净克隆全量构建**：

```bash
rm -rf /tmp/freshcheck
git clone <repo-url> /tmp/freshcheck && cd /tmp/freshcheck
npm ci && npm run build
(cd src-tauri && cargo test)
```

更省事的做法是接 CI：在 `.github/workflows/ci.yml` 里对 push/PR 跑上面三条命令，
这类问题就不会溜到同事手上（私有仓库用 Actions 额度，一次约 5–8 分钟）。

另外自查一条：**本地有、但没进版本库的源码文件**（不是构建产物的话就是漏提交了）：

```bash
comm -13 <(git ls-files | sort) \
  <(find . -type f -not -path "./.git/*" -not -path "./node_modules/*" \
      -not -path "./dist/*" -not -path "./src-tauri/target/*" -not -path "./src-tauri/gen/*" \
      | sed 's|^\./||' | sort)
```

### 打包小坑

`bundle_dmg.sh` 偶发失败（`failed to run bundle_dmg.sh`）并在 `/Volumes/` 留下未卸载的临时卷：

```bash
hdiutil detach /Volumes/<残留卷> -force
npx tauri bundle --bundles app,dmg -v   # 加 -v 能看到真实输出
```

另外 `--bundles dmg` 单独跑会在完成后删掉 `.app`，需要 `.app` 就再跑一次 `--bundles app`。

---

## 三、代码结构

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
docs/               设计与实施文档（见下）
```

### 分层约定（改代码前先看）

- **Rust 只做能力，不带业务语义**：网络、WebSocket、文件、托盘、通知。它不知道"标签""向导"这些概念。
- **所有持久化配置只有一个出处**：`config.json`（Rust 侧读写，前端 store 只做镜像与回填）。
  改一个字段时别忘了在 `patch()` 里回填其余字段，否则会把别的设置写成默认值。
- **视图不直接调 `api/*` 的写操作**：写操作走 store，否则同一份数据会出现两个真相来源。
- **前端不接触 cookie / 密码明文**：都在 Rust 侧。

## 四、测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| 前端业务 | Vitest + jsdom | store 状态迁移、日志行缓冲/ANSI/`$<3>` 还原、语法高亮与查找、日志自动滚动（含后台标签切回）、通知去重与**只通知自己提交的任务**、标签生命周期、收藏粒度/筛选与部署流程、外壳交互 |
| Rust | `cargo test` | HTTP 语义、续登、解析器（真实 fixture 快照）、日志留存与保留策略、WebSocket 客户端、配置 |
| 真实环境 | `cargo test -- --ignored` | 真实 ITSM 续登、fixture 抓取 |

排查「日志不实时更新」时用 `cargo run --example probe_log_ws -- <taskId> auto`：它用应用保存的凭据登录，
把日志 WebSocket 收到的**原始帧**按时间打出来，并交叉验证页面里的 `session_key` 与 cookie 里的
`sessionid` 是否一致（不一致时 HTTP 一切正常、WS 却永远收不到数据，而界面只显示「已连接」）。

无法用 jsdom 覆盖的部分（拖放、下拉在真实引擎里的行为）用 **CDP 驱动真实 Chromium + 打桩 Tauri IPC** 的方式验证，
思路见 `docs/superpowers/plans/2026-10-13-plan5-favorites-granularity-and-shell.md` 的验收章节。

## 五、文档

| 文档 | 内容 |
|---|---|
| [`docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md`](docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md) | **设计真值**：架构、IPC 契约、界面、体验增强、存储、约束与取舍 |
| `docs/superpowers/plans/*.md` | 各阶段实施计划与执行结果（Plan 1 → Plan 6） |
| [`docs/install-unsigned.md`](docs/install-unsigned.md) | 未签名版本的安装放行与签名不变量 |
| [`docs/updates.md`](docs/updates.md) | 应用内更新：签名密钥、release 构建、latest.json、平台行为与排查 |
| [`docs/distribution.md`](docs/distribution.md) | 分发指南：产物、按平台选包、新版本怎么发、CI 矩阵示例 |
