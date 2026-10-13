# 至真部署桌面客户端 · 设计方案

- 日期：2026-10-13
- 状态：已评审通过，待编写实施计划
- 目标仓库：`~/code/company/tool-demo/zz-deploy-desktop`（独立仓库）
- 应用名：至真部署
- Bundle ID：`com.zhizhengroup.deploy`

---

## 背景与目标

现有 `vscode-zz-deploy` 是一个 VSCode 扩展，通过模拟浏览器访问内部运维平台 ITSM（`https://itsm.zhizhengroup.com`），提供自动化部署与 Docker 部署能力。

本项目把它改造成**独立跨平台桌面客户端**，使用 Tauri 2，并重新设计界面。目标有两个：

1. **脱离 VSCode**：不装插件也能用，可单独分发给同事。
2. **比插件更好用**：在功能对齐的基础上，补上插件做不到的桌面端能力（托盘、通知、日志留存、快捷键等）。

现有插件**不做任何修改**，继续独立可发布。

---

## 决策摘要

以下决策均已确认，是本设计的约束前提：

| # | 决策项 | 结论 |
|---|---|---|
| 1 | 平台范围 | 仅桌面三端：macOS / Windows / Linux。不做移动端 |
| 2 | 功能范围 | 1:1 移植现有能力 + 客户端体验增强（见 §6）。**不新增业务能力** |
| 3 | 数据接入 | 保持现状：Commit 走 JSON 接口，其余解析 HTML。不探测新接口 |
| 4 | 架构分层 | Rust 做能力层（网络/系统），TS 做业务层 + 解析 + UI |
| 5 | 前端栈 | Vue 3 + Vite + TypeScript + Pinia + Tailwind CSS + shadcn-vue |
| 6 | 登录态 | 存 cookie + 账号密码；密码存应用数据目录的加密文件（**不用系统钥匙串**，见 §7）；支持自动续登 |
| 7 | 窗口模型 | 单窗口 + 顶部标签栏，不做多窗口 |
| 8 | 视觉方向 | 以「深色 SaaS」为主视觉（见 §5），吸收「浅色工程工具」的密度与克制；深/浅两个模式都交付 |
| 9 | 代码组织 | 独立新仓库，不改动现有插件仓库 |
| 10 | 分发签名 | 暂无 Apple / Windows 签名证书，P7 先出未签名包 |

---

## 1. 总体架构

```
┌───────────────────────── Tauri 2 App ─────────────────────────┐
│                                                               │
│  ┌──────────── Webview（Vue 3 + TS + Tailwind）────────────┐  │
│  │  视图层   标签栏 / 向导 / 任务列表 / 日志 / 设置          │  │
│  │  业务层   Pinia stores + api/*.ts（复刻 deploy.ts 契约） │  │
│  │  解析层   api/parser.ts（cheerio，从插件原样搬）         │  │
│  └───────────────────────┬─────────────────────────────────┘  │
│                          │ invoke / listen（IPC）              │
│  ┌───────────────────────┴─────────────────────────────────┐  │
│  │  Rust 能力层（无业务语义）                               │  │
│  │   net    reqwest + Cookie Jar + CSRF + 302 语义 + 续登   │  │
│  │   ws     tokio-tungstenite（带 Cookie 头握手）           │  │
│  │   secure 凭据加密文件（应用数据目录，不用钥匙串）        │  │
│  │   store  config / favorites / 日志索引                   │  │
│  │   shell  托盘 / 通知 / 单实例 / 自启                     │  │
│  └─────────────────────────────────────────────────────────┘  │
│  产物：macOS .dmg/.app · Windows .msi/.exe · Linux .AppImage/.deb │
└───────────────────────────────────────────────────────────────┘
```

**核心边界原则：Rust 薄，TS 厚。**

Rust 不知道「项目」「分支」「部署」是什么业务概念，只提供"按规则发 HTTP、按规则维持登录态"的能力。所有业务概念、URL 路径、HTML 解析都在 TS 里。这样做的收益是 Rust 层可以完全用 mock server 单测，无需连接真实 ITSM。

依赖选型：

| 用途 | 选型 |
|---|---|
| 应用框架 | Tauri 2 |
| HTTP 客户端 | `reqwest`（`cookies` feature，内置 Cookie Jar） |
| WebSocket | `tokio-tungstenite` |
| 凭据存储 | `aes-gcm` 加密文件（应用数据目录），**不用** `keyring` 系统钥匙串 |
| 配置与收藏持久化 | `tauri-plugin-store` |
| 通知 / 对话框 / 单实例 / 自启 | `tauri-plugin-notification` / `-dialog` / `-single-instance` / `-autostart` |
| 托盘 | Tauri 2 内置 `tauri::tray::TrayIconBuilder` |
| HTML 解析 | `cheerio`（前端） |
| 表格逻辑 | `@tanstack/vue-table`（无样式，只管状态与分页逻辑） |

---

## 2. Rust 能力层：IPC 契约

刻意做得**又薄又通用**，避免 Rust 里长出业务逻辑。

### 2.1 唯一的 HTTP 出口

```rust
/// path 必须相对 baseUrl；绝对 URL 一律拒绝（防 SSRF）
#[tauri::command]
async fn http_request(
    method: String,                          // "GET" | "POST"
    path: String,                            // 如 "/deployment/deploy/submit/"
    query: Option<Vec<(String, String)>>,
    form:  Option<Vec<(String, String)>>,
) -> Result<HttpResult, AppError>;

struct HttpResult {
    status: u16,
    location: Option<String>,   // 302 的跳转目标，交给 TS 判定语义
    body: String,               // 原始 HTML 或 JSON 文本
}
```

`http_request` 内部自动完成四件事，调用方无感：

1. **注入 Cookie**：从 Rust 内存中的 Cookie Jar 取，前端永远拿不到 cookie 明文。
2. **POST 自动补 CSRF（尽力而为，非必需）**：从 cookie `csrftoken` 取值，写入请求体的
   `csrfmiddlewaretoken` 字段，并同时设置 `X-CSRFToken` 请求头。（两个名字不同名，
   沿用插件 `src/api/client.ts:43-50` 的写法）

   > **实测事实（2026-10-13）**：ITSM **不下发 `csrftoken` cookie**——登录前后
   > 都只有 `sessionid`；且往只接受 GET 的视图发空 POST 得到 500 而非 403，
   > 说明请求已穿过 CSRF 中间件（Django 的 CSRF 失败一定返回 403）。
   > 即服务端未启用 CSRF 校验，该 cookie 从来不是必需项。
   >
   > 因此 Rust 侧**不得**因为缺失 csrftoken 而拒绝发送请求——这是早期实现的实际 bug，
   > 表现为点「确认提交部署」直接报「cookie 中缺少 csrftoken，请重新登录」。
   > 复现与验证工具：`cargo run --example probe_cookies`。
3. **302 语义前置判定**：`302` 且 `Location` 含 `/login/` 判定为**会话过期**，而非操作成功。
4. **自动续登**：会话过期且已保存账号密码时，静默重新登录，然后**重放原请求一次**，返回真实结果。重放仅允许一次，避免死循环。

> **这一层顺带修掉了现有插件的一个潜在 bug。** 插件的 `submitDeploy` 判定是 `return resp.status === 302`（`src/api/deploy.ts:61`）。当 session 过期时服务端同样返回 302，只是 `Location` 指向 `/login/` —— 插件会据此认为"部署已提交"并提示成功，而实际什么都没发生。统一拦截层消除了这个歧义。
>
> 同理适用于 `submitOnline` / `submitRollback` / `deleteTask`（`src/api/deploy.ts:79`、`84`、`89`）。

### 2.2 其余命令

```rust
// 认证
auth_status()                                   -> { logged_in, username, base_url, credential_backend, credential_path }
auth_login(base_url, username, password)        -> { ok, message }
auth_logout()
auth_save_credentials(username, password)       // 写应用数据目录下的加密文件
auth_forget_credentials()

// 配置与数据
config_get()                                    -> Config
config_set(patch)                               // baseUrl / 主题 / 日志保留策略 / 关闭行为
favorites_list()                                -> Favorite[]
favorites_save(fav)                             -> Favorite
favorites_delete(id)

// 构建日志
log_open(task_id, deploy_type, project_name)    -> session_id
log_close(session_id)

// 本地日志留存
history_list()                                  -> HistoryEntry[]
history_read(task_id)                           -> String
history_delete(task_id)
```

### 2.3 事件（Rust → 前端）

```
log://data      { session_id, chunk }      原始日志块，含 ANSI 转义码，前端处理
log://status    { session_id, state }      connected | disconnected | finished | error
auth://expired  { reason }                 自动续登失败，需要用户重新登录
task://changed  { deploy_type }            某类型任务发生状态变化（供通知与列表刷新）
```

日志走**事件流**而非 invoke 返回值，因为它是长连接推送。前端按 `session_id` 分发给对应的日志标签页。

### 2.4 错误类型

```rust
struct AppError {
    kind: ErrorKind,        // Network | Timeout | Auth | Parse | Server | Config | Io
    message: String,        // 面向开发者的原始描述
    retryable: bool,        // 网络类/超时/5xx 为 true
}
```

---

## 3. 前端业务层

`src/api/` 目录刻意**与插件保持一一对应**，降低迁移心智负担，也便于对照排错。

| 插件文件 | 桌面端位置 | 变化 |
|---|---|---|
| `src/api/client.ts` (80 行) | `src/api/http.ts` | node-fetch 改为 `invoke('http_request')`，约 40 行 |
| `src/api/deploy.ts` (131 行) | `src/api/deploy.ts` | 逻辑不变，改为显式读 `status` / `location` 判定 |
| `src/api/parser.ts` (144 行) | `src/api/parser.ts` | **原样搬，零修改** |
| `src/ws/logSocket.ts` (100 行) | 删除 | 功能移至 Rust |
| `src/config.ts` (35 行) | `src/api/config.ts` | 改为 invoke |
| `src/favorites.ts` (62 行) | `src/api/favorites.ts` | 改为 invoke |
| — | `src/api/history.ts` | 新增：本地日志留存读写 |
| `media/main.js` 的 state 机 (936 行) | `src/stores/*.ts` | 拆分为 Pinia 模块 |

Pinia store 划分：

| Store | 职责 |
|---|---|
| `auth` | 登录态、用户名、登录/登出、续登失败处理 |
| `tabs` | 标签列表、当前激活标签、打开/关闭/聚焦逻辑、单例规则 |
| `wizard` | 新建部署向导（**每个标签页一份独立实例**，用工厂函数创建） |
| `tasks` | 任务列表、分页、搜索、轮询、行内操作 |
| `favorites` | 收藏列表、快速部署展开态 |
| `logs` | 日志会话、日志缓冲、ANSI 处理状态 |
| `history` | 本地日志留存索引 |
| `settings` | baseUrl、主题、保留策略、关闭行为、快捷键展示 |

`parser.ts` 虽然零修改，但会加一层类型收口：解析函数只负责 `string → 领域对象`，为纯函数，不碰网络，便于单测。

---

## 4. 关键数据流

### 4.1 常规请求（含自动续登）

```
TS:    invoke http_request(GET, "/deployment/deploy/task/", {page, search})
Rust:  带 Cookie 请求
       └─ 302 且 Location 含 /login/ ？
            ├─ 否 → 返回 { status: 302, location }
            └─ 是 → 取已保存凭据 → 重新登录 → 重放原请求 → 返回真实结果
                     └─ 重登失败 → emit auth://expired
TS:    status=302 且 location 不指向 login → 判定操作成功
       前端收到 auth://expired → 弹出重新登录对话框
```

### 4.2 提交部署

```
向导标签页
  → submitDeploy(deployType, projectId, { branchtag, version })
  → invoke http_request(POST, 路径, form)
  → Rust 补 csrf token；TS 侧补 serial / destination_host
  → status=302 且非 login = 成功
  → 该向导标签页自动关闭
  → 聚焦「任务列表」标签并刷新对应类型
  → 记录本次提交，用于后续构建完成通知
```

必须保留的请求体字段（这些是踩坑加上的，见插件 `src/api/deploy.ts:48-57`）：

```ts
{ title, version, iteration_id: '0', serial: '1', destination_host: '' }
// docker 额外带 branchtag
```

路径规则：`auto` → `/deployment/deploy/...`，`docker` → `/dockerdeploy/docker/...`。

### 4.3 构建日志

```
点击 Log → 打开日志标签 → invoke log_open(taskId, deployType, projectName)
Rust:  连接 wss://<baseUrl>/wssapp/，握手带 Cookie 头
       发送认证消息：
         { sock_type: "BuildLog",
           session_key: <从 cookie 提取的 sessionid>,
           id: String(taskId),
           submittype: "delpoyment" | "dockerdelpoy" }
       每收到一帧 → emit log://data { chunk: build_log }
       收到 code === 1 → emit log://status { state: "finished" }，主动关闭，不再重连
       异常断开 → 指数退避重连，最多 3 次
       全程把收到的日志块同时追加写入本地留存文件
前端:  剥离 ANSI 转义码
       按行切分；进度行（如 `a1b2c3: Pushing xxx`）按 key 原地覆盖，普通行直接追加
       自动滚动到底（可关闭）
```

> **`submittype` 的拼写错误（`delpoyment` / `dockerdelpoy`）是服务端原始值，必须原样保持**，见插件 `src/ws/logSocket.ts:52`。

---

## 5. 界面结构与信息架构

### 5.1 窗口骨架

```
┌────────────────────────────────────────────────────────────────┐
│ ●●●  [标签: 新建部署 · zz-cy-iptv] [任务列表] [日志 · zz-vip-web] │  ← 自定义标题栏 + 标签栏
├──────────┬─────────────────────────────────────────────────────┤
│ 新建部署  │                                                      │
│ 收藏      │                    内容区                            │
│ 任务列表  │                                                      │
│ 历史日志  │                                                      │
│ 设置      │                                                      │
│           │                                                      │
│ ───────  │                                                      │
│ 用户/状态 │                                                      │
└──────────┴─────────────────────────────────────────────────────┘
```

**跨平台标题栏差异（必须处理）**：

- **macOS**：`titleBarStyle: "Overlay"`，保留系统红绿灯按钮，标签栏紧随其后排布。
- **Windows / Linux**：系统装饰会与自绘标签栏冲突，需 `decorations: false` 并自绘最小化 / 最大化 / 关闭按钮，且要处理拖拽区（`data-tauri-drag-region`）。

这是三端唯一必须分叉的 UI 代码。

### 5.2 标签模型

左侧导航采用 **IDE 模型**：导航是"入口"，标签是"当前打开的会话"。

| 导航项 | 点击行为 | 单例？ |
|---|---|---|
| 新建部署 | **新建**一个向导标签 | 否，可多开 |
| 收藏 | 打开/聚焦收藏标签 | 是 |
| 任务列表 | 打开/聚焦任务列表标签 | 是 |
| 历史日志 | 打开/聚焦历史日志标签 | 是 |
| 设置 | 打开/聚焦设置标签 | 是 |
| 列表行内「Log」 | 每个 `taskId` 一个日志标签；已存在则聚焦 | 按 taskId |

标签生命周期：

- **向导标签**：提交成功后自动关闭并跳转任务列表；含未提交内容时关闭需二次确认。
- **日志标签**：`log://status` 为 `connected` 期间关闭需确认；关闭时调用 `log_close(session_id)` 释放连接与留存写入。
- **单例标签**：可关闭，但从导航再次进入即可重开。
- 标签数量超出可视宽度时横向滚动，并提供"全部标签"下拉。

### 5.3 页面清单

| 页面 | 说明 |
|---|---|
| 登录 | 未登录时的全屏页。baseUrl 可改，默认 `https://itsm.zhizhengroup.com` |
| 新建部署向导 | 见 §5.4 |
| 收藏 | 收藏列表 + 内联快速部署 |
| 任务列表 | 核心页面，见 §5.5 |
| 构建日志 | 深色等宽终端风格，实时流 |
| 历史日志 | 本地留存的日志回看、搜索、导出、删除 |
| 设置 | 见 §5.6 |

全局组件：确认对话框、Toast、空状态、骨架屏。

### 5.4 新建部署向导

保持插件的**纵向渐进单页**模型（选类型 → 选环境 → 选项目 → 选分支 → 选 Commit → 提交），以减少迁移风险，但视觉层级重做：

1. **部署类型**：分段控件（自动化 / Docker）。
2. **环境**：9 个环境以卡片网格呈现，不再是下拉。环境列表**硬编码不变**：

   ```
   1 测试环境        2 正式环境        4 预发布环境      7 开发环境
   8 测试环境2       9 UAT环境        11 测试环境3      12 谷歌云
   14 腾讯云
   ```

3. **项目**：卡片网格 + 搜索框；每个卡片右上角星标用于收藏。
4. **分支**：可搜索下拉。
5. **Commit**：**可搜索**下拉 —— commit message 很长，原生 select 不可用。选项形如 `a1b2c3d4 修复播放页黑屏问题`。
6. **提交**：主按钮「确认提交部署」+ 次按钮「保存为收藏」。

### 5.5 任务列表

- 顶部：分段控件（自动化 / Docker）、搜索框、刷新按钮、最后刷新时间。
- 表格：使用 `@tanstack/vue-table` 管理状态，样式自绘。
- 列：标题 / 项目 / 环境 / 分支 / 版本 / 上线状态 / 构建状态 / 提交人 / 时间 / 操作。
- 状态渲染：胶囊标签，成功=绿、构建中=琥珀+转圈、失败=红、其他=中性。
- 操作列：上线 / 回滚 / 删除 / Log，按服务端返回的可用性显示（`canUp` / `canRoll` / `canDelete`）；Log 始终可用。
- 分页：首页 / « / 页码窗口（当前页 ±2） / » / 尾页 + 每页条数。
- 轮询：默认 60 秒，窗口失焦时暂停，页面不可见时暂停，连续失败 3 次后停止并显示离线状态。

> 依赖的解析契约（来自插件 `src/api/parser.ts`，**原样保留**）。注意部分字段用 **id 选择器**取、部分用 **td 位置索引**取，写 fixture 断言时不能混：
>
> | 字段 | 自动化 | Docker |
> |---|---|---|
> | taskId | `td[id^="title_"]` 的 id 后缀 | 同左 |
> | title | `td[id^="title_"]` | `td[id^="title_"]` |
> | projectName | `td[id^="project_"]` | `td[1]` |
> | envName | `td[id^="env_"]` | `td[id^="env_"]` |
> | branch | `td[id^="branchtag_"]` | `td[id^="branchtag_"]` |
> | version | `td[id^="version_"]` | `td[id^="version_"]` |
> | onlineStatus | `td[8]` | `td[7]` |
> | buildStatus | `td[9]` | `td[8]` |
> | submitTime | `td[10]` | `td[9]` |
> | submitter | `td[11]` | `td[10]` |
> | actions（canUp/canRoll/canDelete） | `td[12]` | `td[11]` |
> | cluster / deployType | 空（不适用） | `td[3]` / `td[4]` |
>
> 另有两条硬性前置条件：行内 `td` 数量必须 `>= 11`，且必须能匹配到 `td[id^="title_"]`，否则整行跳过。
>
> 分页解析依赖 jQuery 专有伪类 `:contains("尾页")` 与 `:contains("«")`，CSS 选择器不支持，**这是解析必须留在 TS 的原因之一**。

### 5.6 设置页

| 分组 | 项 |
|---|---|
| 服务 | ITSM 地址（只读展示 + 修改）、当前登录用户、退出登录 |
| 凭据 | 存储方式与文件位置（只读展示）、清除已保存凭据 |
| 外观 | 主题（跟随系统 / 深色 / 浅色） |
| 行为 | 关闭窗口行为（最小化到托盘 / 退出）、启动时自动运行、轮询间隔、构建完成通知触发条件 |
| 日志留存 | 保留天数、最大条数、占用空间、清空全部 |
| 关于 | 版本、当前平台、快捷键列表 |

---

## 6. 体验增强设计

### 6.1 系统托盘

- 图标常驻，菜单：显示主窗口 / 新建部署 / 任务列表 / ─── / 退出。
- 关闭窗口行为由设置决定，默认「最小化到托盘」。
- 有进行中的构建时，托盘图标附加提示（macOS 用 `set_title` 显示数量）。**该能力三端不一致，需能力探测 + 优雅降级。**

### 6.2 构建完成通知

两个触发点：

1. **日志流**：日志标签页已连接，收到 `log://status { state: "finished" }` → 依据最后若干行日志判定成功/失败。
2. **列表轮询**：轮询时对比前后状态，某任务从"构建中"跃迁到终态（成功/失败）。

**必须去重**：按 `(taskId, 终态)` 记录，同一任务同一终态只通知一次，否则两个触发点会重复弹窗。

- 点击通知：聚焦主窗口并打开该任务的日志标签。
- 设置项：始终通知 / 仅窗口失焦时通知（默认）。

### 6.3 日志本地留存与回看

| 项 | 设计 |
|---|---|
| 正文路径 | `appDataDir/logs/<deployType>/<taskId>.log`（纯文本，ANSI 已剥离，每行前缀时间戳） |
| 索引 | `appDataDir/logs/index.json`：taskId / 项目 / 环境 / 提交人 / 首次订阅时间 / 大小 |
| 留存范围 | **仅留存用户主动打开过日志的任务**，不会把全站日志拉下来 |
| 保留策略 | 默认保留 30 天且最多 500 条；超出按时间淘汰；设置页可调 |
| 回看 | 「历史日志」标签：列表 + 搜索 + 查看 + 导出（另存为 `.log`）+ 删除单条 / 清空 |

### 6.4 键盘快捷键

| 快捷键 | 动作 |
|---|---|
| `⌘/Ctrl + N` | 新建部署标签 |
| `⌘/Ctrl + R` | 刷新当前标签页数据 |
| `⌘/Ctrl + W` | 关闭当前标签 |
| `⌘/Ctrl + 1…5` | 切换到第 N 个标签 |
| `⌘/Ctrl + ,` | 打开设置 |
| `⌘/Ctrl + K` | 打开命令面板（可选，P6 后段实现） |

设置页「关于」分组可查看全部快捷键。

### 6.5 主题

- 三档：跟随系统（默认）/ 强制深色 / 强制浅色。
- 使用 Tailwind 的 `class` 策略 + CSS 变量 token，深浅两套共享同一设计系统。
- 跟随系统时监听 Tauri 的窗口主题变更事件，实时切换无需重启。

### 6.6 自动重试

| 场景 | 策略 |
|---|---|
| `GET` 幂等请求失败（超时 / 5xx） | 自动重试 2 次，指数退避 |
| **`POST` 请求** | **绝不自动重试** —— 提交部署、上线、回滚、删除均不可重复执行，这是安全红线 |
| WebSocket | 保留 3 次指数退避重连（与插件一致） |
| 列表轮询 | 连续失败 3 次停止，显示离线状态，恢复后可手动或自动继续 |

---

## 7. 数据与存储

| 数据 | 位置 | 方式 | 是否落盘 |
|---|---|---|---|
| baseUrl / 主题 / 保留策略 / 关闭行为 / 轮询间隔 | `config.json` | `tauri-plugin-store` | 是 |
| 账号密码 | `<appDataDir>/credentials.bin` | AES-256-GCM，密钥同目录 `credentials.key`（0600） | 是（加密） |
| Cookie / session | 仅 Rust 内存 | reqwest Cookie Jar | **否** |
| 收藏列表 | `favorites.json` | `tauri-plugin-store` | 是 |
| 日志正文 | `logs/<type>/<taskId>.log` | 文件系统 | 是 |
| 日志索引 | `logs/index.json` | 文件系统 | 是 |
| 应用自身日志 | `logs/app.log` | 文件系统 | 是 |

**两处相对插件的安全改进：**

1. **Cookie 不再落盘**。插件把 cookie 明文存在 VSCode `globalState` 里；本客户端 cookie 只存在于内存，重启后靠已保存的凭据静默续登，用户无感。
2. **密码加密落盘，不再是明文**（插件把账号密码明文写进 `globalState`）。

**为什么不用系统钥匙串（`keyring` crate）**：早期版本优先写钥匙串，实测在未签名/每次构建签名都变的情况下，macOS 无法把 ACL 与已有条目匹配，**每次启动都弹授权框**，等于每次都要输密码。故改为只用加密文件。代价是密钥与密文同机存放，只能防止明文外泄，无法抵御能读本机文件系统的攻击者——设置页会明示这一点。

`Favorite` 数据结构与插件保持一致：

```ts
interface Favorite {
  id: string;
  type: 'project' | 'config';
  deployType: 'auto' | 'docker';
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  branch?: string;
}
// 去重键：`${projectId}_${envId}_${deployType}_${branch ?? ''}`
```

---

## 8. 错误处理

**分层收口**：

- Rust 层统一返回 `Result<T, AppError>`，网络类错误带 `retryable` 标记。
- 前端在 `src/api/http.ts` 唯一收口，把错误翻译成中文用户话术（例如「网络不可达，请检查 VPN 或内网连接」）。
- 业务层不再各自处理原始错误。

**UI 三级呈现**：

| 级别 | 场景 | 表现 |
|---|---|---|
| Toast | 可恢复的瞬时错误 | 右下角，3 秒自动消失 |
| 页内错误块 | 影响当前页面的错误 | 该区域显示错误 + 「重试」按钮，其余功能可用 |
| 全屏错误页 | 无法继续（如 baseUrl 不可达） | 全屏提示 + 引导去设置页修改地址 |

**会话失效流程**：`auth://expired` → 弹出重新登录对话框 → 登录成功后**自动重放刚才失败的操作**，用户无感。

**兜底**：所有未捕获异常写入 `appDataDir/logs/app.log`（与应用业务无关的构建日志分开存放）。

---

## 9. 测试策略

| 层 | 工具 | 覆盖内容 |
|---|---|---|
| Rust 网络层 | `cargo test` + 本地 mock server（`wiremock` 或 `axum`） | CSRF 拼装、Cookie 维持、302→login 判定、续登重放（且仅一次）、拒绝绝对 URL、POST 不重试、退避策略 |
| TS 解析层 | Vitest + **真实 HTML fixture 快照** | 项目 / 分支 / 任务列表（auto 与 docker 两种）、分页解析、`:contains` 选择器 |
| TS 业务层 | Vitest | store 状态迁移、通知去重、标签生命周期、日志保留淘汰策略 |
| UI 组件 | Vitest + `@vue/test-utils` | 向导、任务表格、标签栏的关键交互 |
| 端到端 | 手测清单，三端各跑一遍 | Tauri 三端 Webview 差异，自动化性价比低 |

**Fixture 快照是本项目最重要的测试资产。** 从 ITSM 抓取真实页面（脱敏后）存入 `fixtures/`，解析单测跑快照比对。ITSM 一改版，CI 立即报红并指出是哪张表哪一列变了。

---

## 10. 交付阶段

| 阶段 | 内容 | 里程碑意义 |
|---|---|---|
| **P0** | 脚手架：Tauri 2 + Vue 3 + Tailwind + shadcn-vue；自定义标题栏（含三端分叉）；设计 token；深浅主题 | 空壳可运行 |
| **P1** | 登录 + 设置页 + 凭据加密存储 + Rust 网络层（含自动续登） | 能登录并维持会话 |
| **P2** | 新建部署向导 | 能提交部署 |
| **P3** | 任务列表（分页 / 搜索 / 上线 / 回滚 / 删除）+ 轮询 | 核心闭环打通 |
| **P4** | 构建日志（Rust WS + 日志标签页 + ANSI + 进度行原地更新） | 功能对齐插件 |
| **P5** | 收藏（项目级 / 配置级 + 快速部署） | **功能与插件 1:1，可替代插件** |
| **P6** | 托盘、通知、日志留存与回看、快捷键、自动重试 | 成为"更好的客户端" |
| **P7** | 打包：未签名 macOS `.dmg` / Windows `.msi` / Linux `.AppImage` + `.deb` | 可分发给同事 |

P0–P5 是「能替代插件」，P6–P7 是「成为更好的客户端」。

---

## 11. 范围边界（明确不做）

- 不做移动端（仅桌面三端）
- 不做自定义环境列表，9 个环境继续硬编码
- 不做多账号 / 多 baseUrl 并行
- 不做审批流、批量部署、部署统计面板
- 不去探测 ITSM 新的 `/devapi/` 接口，保持现有混合比例
- **不修改现有 VSCode 插件仓库**
- 不做多窗口模型（日志在标签内，不做独立窗口）
- 不做自动更新（`tauri-plugin-updater` 后续再议）

---

## 12. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| ITSM HTML 改版 | 解析全部失效 | fixture 快照单测，改版当天报红并定位到具体列 |
| **两份 parser 拷贝漂移** | 插件端与桌面端行为不一致 | 两端使用**同一份 fixture 快照**与同一组断言，任一端行为变化都会暴露。（可选后续：在插件仓库 README 加一行指向本仓库的注记） |
| 加密文件被本机其他进程读取 | 凭据泄露 | 目录 0700、文件 0600；设置页明示「密钥与密文同机存放」这一安全等级。若要更高等级，需引入系统级密钥库或用户主密码（见 §11 范围边界） |
| 三端 Webview 差异（WKWebView / WebView2 / WebKitGTK） | 样式或 API 行为不一致 | 每个阶段末在三端各跑一遍；避免冷门 CSS 特性 |
| 托盘 / 通知能力三端不一致 | 功能打折 | 运行时能力探测 + 优雅降级（例如不支持托盘角标则省略该提示） |
| 302 语义歧义（会话过期 vs 操作成功） | 误报成功，实际未执行 | 已在 §2.1 统一拦截层消除 |
| 无代码签名证书 | 用户首次打开需手动放行 | 已确认接受：P7 先出未签名包，随包附「首次打开」说明文档 |

---

## 13. 与现有 VSCode 插件的关系

- 插件仓库 `~/code/company/tool-demo/vscode-zz-deploy` **不做任何修改**，继续独立可发布。
- 本项目是能力对齐后的平行实现，不是插件的重构。
- 唯一实质耦合点是 `src/api/parser.ts` 的逻辑拷贝，通过共享 fixture 快照控制漂移。
- 若未来要收敛为单一来源，可把 `parser.ts` 提取为独立 npm 包供两端引用；**本设计不包含该工作**。

---

## 附：设计参考图

位于 `docs/design/mockups/`：

| 文件 | 说明 |
|---|---|
| `style-a-dark-saas.png` | **主视觉方向**（深色 SaaS，靛紫强调色，大圆角，胶囊状态标签） |
| `style-b-light-engineering.png` | 浅色模式参考（纯白 + 单一蓝强调 + 1px 细线，高信息密度） |
| `style-c-terminal-hud.png` | 仅用于日志标签页的参考（近黑 + 青色 + 全等宽字体） |

主视觉取 A 的结构与气质，吸收 B 的密度与克制；深色与浅色是同一套设计系统的两个模式。C 只在日志标签页局部使用。
