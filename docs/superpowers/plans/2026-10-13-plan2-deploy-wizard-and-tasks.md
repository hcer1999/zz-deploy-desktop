# Plan 2：部署向导 / 任务列表 / 收藏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐业务功能——新建部署向导、任务列表（上线/回滚/删除）、收藏与快速部署。完成后桌面客户端功能与现有 VSCode 插件 1:1 对齐，可真正替代插件。

**Architecture:** Rust 能力层已在 Plan 1 完备，本计划**不改动 Rust 网络层**（只新增 favorites 三个命令）。全部业务逻辑在前端 TS：`api/deploy.ts` 组装请求，`api/parser.ts` 用 cheerio 解析 HTML（从插件原样搬），Pinia store 管理状态，Vue 组件负责展示。

**Tech Stack:** 复用 Plan 1 全部栈；新增 `cheerio`（前端解析）、`@tanstack/vue-table`（表格状态）

**依据 spec:** `docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md`（覆盖 P2 + P3 + P5，及 §9 fixture 快照策略）

---

## 与 spec 的两处有意偏离

写计划时发现 spec 的 §1 技术栈表与 §3 store 划分有两处可以简化，这里明确记录：

### 1. 不建 `stores/wizard.ts`，向导状态放在组件本地

spec §3 列了 `wizard` store，并说"每个标签页一份独立实例，用工厂函数创建"。

**实际做法**：`DeployWizard.vue` 用组件本地 `ref` 持有状态。因为 Task 5 已把
TabHost 改成"所有标签都挂载、非激活的用 v-show 隐藏"，每个向导标签本来就渲染
一个独立的组件实例，**状态天然隔离**。再引入一个 `Map<tabId, WizardState>`
只是把同一件事换个地方做，还多出"tabId 变化时清理旧状态"的麻烦。

### 2. 不引入 `@tanstack/vue-table`

spec §1 列了它，但本项目的表格是**固定 10 列、无客户端排序、分页在服务端**——
用 TanStack 只会多一层 API 而换不来任何能力。Task 8 直接用 `<table>` + `v-for`。

若将来要做列排序/列显隐/列冻结，再引入不迟。

两处都属于 YAGNI 而非能力缺失：交付的功能与 spec 描述完全一致。

---

## 前置说明

**工作目录：** `~/code/company/tool-demo/zz-deploy-desktop`

**前置条件：** Plan 1 已完成（56 个 Rust 测试 + 47 个前端测试通过，release 构建通过）。

**本计划交付的里程碑：** 能完整走通「选环境 → 选项目 → 选分支 → 选 Commit → 提交部署」，
在任务列表里看到刚提交的任务并执行上线/回滚/删除，以及用收藏一键复用常用配置。

**不属于本计划：** 构建日志（Plan 3）、托盘/通知/日志留存（Plan 4）。

---

## 文件结构

```
src/
├── api/
│   ├── parser.ts                     从插件原样搬（144 行，含 td 索引领域知识）
│   ├── parser.test.ts                fixture 快照测试（本计划最重要的资产）
│   ├── deploy.ts                     业务接口：项目/分支/Commit/提交/任务列表/操作
│   ├── deploy.test.ts
│   ├── favorites.ts                  收藏的 invoke 封装
│   └── __fixtures__/                 从真实 ITSM 抓取的 HTML 快照
├── stores/
│   ├── wizard.ts                     向导状态工厂（每个标签页一份）
│   ├── tasks.ts                       任务列表、分页、搜索、轮询
│   └── favorites.ts
└── components/
    ├── common/
    │   ├── ConfirmDialog.vue         基于 ui/dialog 的确认框
    │   └── StatusBadge.vue           上线/构建状态的胶囊标签
    └── deploy/
        ├── EnvPicker.vue
        ├── ProjectPicker.vue
        ├── BranchPicker.vue
        └── CommitPicker.vue
└── views/
    ├── DeployWizard.vue
    ├── TaskListView.vue
    └── FavoritesView.vue
```

Rust 侧只新增：

```
src-tauri/src/commands/favorites.rs   收藏的读写（tauri-plugin-store）
```

---

## Task 0: 抓取真实 HTML fixture

spec §9 把 fixture 快照列为最重要的测试资产：ITSM 一改版，CI 立刻报红并指出哪张表变了。
趁现在有可用会话，先把真实页面抓下来存档。

**Files:**
- Create: `src-tauri/examples/capture_fixtures.rs`
- Create: `src/api/__fixtures__/*.html`（由工具产出）

- [ ] **Step 1: 写抓取工具**

在 `src-tauri/examples/capture_fixtures.rs` 创建（`examples/` 下的文件可用 `cargo run --example` 直接跑）：

```rust
//! 从真实 ITSM 抓取 HTML 快照，供 parser 的 fixture 快照测试使用。
//!
//! 运行（需先在内网/VPN 环境，且钥匙串里已保存凭据）：
//!   cargo run --example capture_fixtures
//!
//! 产出写入 ../src/api/__fixtures__/。这些文件会提交进仓库——
//! 它们锁住了"服务端 HTML 长什么样"，是解析器唯一可靠的回归防线。

use std::path::PathBuf;

use zz_deploy_desktop_lib::net::client::HttpClient;
use zz_deploy_desktop_lib::secure::detect_store;

const PROJECT_ID_FALLBACK: i64 = 0;

fn out_dir() -> PathBuf {
    // 从 src-tauri 跑到仓库根的 src/api/__fixtures__
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri 应有父目录")
        .join("src/api/__fixtures__")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = out_dir();
    std::fs::create_dir_all(&dir)?;

    let credentials = detect_store(&std::env::temp_dir().join("zz-deploy-capture"));
    let (user, pass) = credentials
        .load()?
        .ok_or("钥匙串里没有凭据：请先在应用里登录并勾选「记住密码」")?;

    let base_url = std::env::var("ZZ_ITSM_BASE_URL")
        .unwrap_or_else(|_| "https://itsm.zhizhengroup.com".to_string());
    let client = HttpClient::new(&base_url);
    zz_deploy_desktop_lib::commands::auth::login_flow(&client, &user, &pass)
        .await
        .map_err(|e| format!("登录失败：{e}"))?;
    println!("登录成功");

    let mut save = |name: &str, html: String| -> Result<(), Box<dyn std::error::Error>> {
        let path = dir.join(name);
        std::fs::write(&path, &html)?;
        println!("  已保存 {name}（{} 字节）", html.len());
        Ok(())
    };

    // 项目列表（自动化 / Docker，分别取两个环境看差异）
    for env in [1_i64, 2] {
        let html = client
            .get("/deployment/deploy/submit/", &[("env".into(), env.to_string())])
            .await?
            .body;
        save(&format!("projects_auto_env{env}.html"), html)?;

        let html = client
            .get("/dockerdeploy/docker/submit/", &[("env".into(), env.to_string())])
            .await?
            .body;
        save(&format!("projects_docker_env{env}.html"), html)?;
    }

    // 分支列表：需要一个真实 project id。先抓项目页，从里面挑第一个
    let first_projects = client
        .get(
            "/deployment/deploy/submit/",
            &[("env".into(), "1".to_string())],
        )
        .await?
        .body;
    save("projects_auto_env1.html", first_projects.clone())?;

    let project_id = extract_first_project_id(&first_projects).unwrap_or(PROJECT_ID_FALLBACK);
    if project_id > 0 {
        let html = client
            .get(&format!("/deployment/deploy/submit/{project_id}/"), &[])
            .await?
            .body;
        save("branches_auto.html", html)?;
    } else {
        println!("  ⚠️ 未能从项目页解析出 project id，跳过分支抓取");
    }

    // 任务列表（自动化 / Docker）
    for (name, path) in [
        ("tasks_auto.html", "/deployment/deploy/task/"),
        ("tasks_docker.html", "/dockerdeploy/docker/task/"),
    ] {
        let html = client
            .get(path, &[("page".into(), "1".to_string()), ("search".into(), String::new())])
            .await?
            .body;
        save(name, html)?;
    }

    println!("\n抓取完成，产出目录：{}", dir.display());
    println!("请人工抽查这些文件确实是登录后的页面（不含登录表单），再提交。");
    Ok(())
}

/// 从项目列表页里抠出第一个 `/submit/<id>/` 的 id，避免硬编码。
/// 这里用最土的办法即可——它只是抓取工具，不是产品代码。
fn extract_first_project_id(html: &str) -> Option<i64> {
    let marker = "/submit/";
    let mut rest = html;
    while let Some(idx) = rest.find(marker) {
        let after = &rest[idx + marker.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            if let Ok(id) = digits.parse() {
                return Some(id);
            }
        }
        rest = &rest[idx + marker.len()..];
    }
    None
}
```

- [ ] **Step 2: 运行抓取**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo run --example capture_fixtures
```

预期：打印每个已保存的文件与字节数，末尾给出产出目录。若报「钥匙串里没有凭据」，先在应用里登录并勾选「记住密码」。

- [ ] **Step 3: 人工抽查 fixture 内容**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
ls -la src/api/__fixtures__/
echo "--- 任务列表页是否包含表格 ---"
grep -c "table" src/api/__fixtures__/tasks_auto.html
echo "--- 是否误抓成登录页（应为 0）---"
grep -c "csrfmiddlewaretoken" src/api/__fixtures__/tasks_auto.html || true
echo "--- 是否含敏感信息 ---"
grep -o "sessionid=[^\"'&<]*" src/api/__fixtures__/*.html | head -5 || echo "无 sessionid ✓"
```

预期：`table` 出现次数 > 0；无 `sessionid` 泄漏（HTML 里通常不含 cookie，但必须确认）。
**若发现任何凭据/个人信息（真实人名、内部 IP），先脱敏再提交。**

- [ ] **Step 4: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add src-tauri/examples/capture_fixtures.rs src/api/__fixtures__/
git commit -m "test: 抓取真实 ITSM HTML 快照作为解析器的回归防线"
```

---

## Task 1: 移植 parser.ts 并用 fixture 锁定行为

**Files:**
- Create: `src/api/parser.ts`（从插件原样搬）
- Create: `src/api/parser.test.ts`
- Modify: `package.json`（加 cheerio）

- [ ] **Step 1: 安装 cheerio**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm install cheerio
```

- [ ] **Step 2: 从插件原样搬 parser.ts**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
cp ~/code/company/tool-demo/vscode-zz-deploy/src/api/parser.ts src/api/parser.ts
echo "--- 搬运后确认无改动 ---"
diff ~/code/company/tool-demo/vscode-zz-deploy/src/api/parser.ts src/api/parser.ts && echo "完全一致 ✓（零修改，spec §3 的要求）"
wc -l src/api/parser.ts
```

预期：diff 无输出（完全一致），144 行。

> 这个文件包含踩坑得来的领域知识（`td[8]`、`td[12]` 这些列索引，以及 jQuery 专有的
> `:contains("尾页")` 选择器）。**不要"顺手重构"它**——它的价值就在于跟服务端 HTML 一一对应。

- [ ] **Step 3: 写 fixture 快照测试**

创建 `src/api/parser.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseProjects, parseBranches, parseTaskList } from "./parser";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf-8");
}

/** fixture 缺失时给出可操作的提示，而不是一句 ENOENT */
function hasFixture(name: string): boolean {
  try {
    readFileSync(join(FIXTURES, name));
    return true;
  } catch {
    return false;
  }
}

const MISSING = "缺 fixture：请先跑 `cargo run --example capture_fixtures`（需内网 + 已保存凭据）";

describe("parseProjects", () => {
  it("能从真实项目页解析出项目列表", () => {
    if (!hasFixture("projects_auto_env1.html")) throw new Error(MISSING);
    const projects = parseProjects(fixture("projects_auto_env1.html"));
    expect(projects.length).toBeGreaterThan(0);
    for (const p of projects) {
      expect(p.id).toBeGreaterThan(0);
      expect(p.name.length).toBeGreaterThan(0);
    }
  });

  it("项目 id 互不重复", () => {
    if (!hasFixture("projects_auto_env1.html")) throw new Error(MISSING);
    const ids = parseProjects(fixture("projects_auto_env1.html")).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("parseBranches", () => {
  it("能从真实分支页解析出分支列表", () => {
    if (!hasFixture("branches_auto.html")) throw new Error(MISSING);
    const branches = parseBranches(fixture("branches_auto.html"));
    expect(branches.length).toBeGreaterThan(0);
    expect(branches.every((b) => b.length > 0)).toBe(true);
  });
});

describe("parseTaskList - 自动化", () => {
  it("解析出任务与分页信息", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.pageInfo.currentPage).toBeGreaterThanOrEqual(1);
    expect(r.pageInfo.totalPages).toBeGreaterThanOrEqual(r.pageInfo.currentPage);
  });

  it("每条任务的字段都取到了值", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    for (const t of r.tasks) {
      expect(t.taskId).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.submitTime.length).toBeGreaterThan(0);
      // cluster / deployType 在自动化下按设计为空（见 parser.ts）
      expect(t.cluster).toBe("");
      expect(t.deployType).toBe("");
    }
  });

  it("canUp / canRoll / canDelete 与页面上是否存在对应链接一致", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_auto.html"), "auto");
    // 至少有一个任务带有可用于判断的标志位，否则说明列索引已经错位
    const anyFlag = r.tasks.some((t) => t.canUp || t.canRoll || t.canDelete);
    expect(anyFlag).toBe(true);
  });
});

describe("parseTaskList - Docker", () => {
  it("解析出任务与分页信息", () => {
    if (!hasFixture("tasks_docker.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_docker.html"), "docker");
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(r.pageInfo.currentPage).toBeGreaterThanOrEqual(1);
  });

  it("docker 下 cluster 与 deployType 有值（与 auto 的列布局不同）", () => {
    if (!hasFixture("tasks_docker.html")) throw new Error(MISSING);
    const r = parseTaskList(fixture("tasks_docker.html"), "docker");
    const withCluster = r.tasks.filter((t) => t.cluster.length > 0);
    expect(withCluster.length).toBeGreaterThan(0);
  });
});

describe("parseTaskList - 两种类型互不串位", () => {
  it("同一份 auto HTML 用 docker 规则解析会得到不同的 projectName", () => {
    if (!hasFixture("tasks_auto.html")) throw new Error(MISSING);
    const html = fixture("tasks_auto.html");
    const asAuto = parseTaskList(html, "auto").tasks;
    const asDocker = parseTaskList(html, "docker").tasks;
    // 列顺序不同，必然至少有一行的 projectName 不一致——这条测试锁住
    // "type 参数真的被用上了"，防止以后有人把分支写反
    const differs = asAuto.some((t, i) => t.projectName !== asDocker[i]?.projectName);
    expect(differs).toBe(true);
  });
});

describe("parseTaskList - 空输入", () => {
  it("没有表格时返回空列表而不是抛错", () => {
    const r = parseTaskList("<html><body><p>no table</p></body></html>", "auto");
    expect(r.tasks).toEqual([]);
    expect(r.pageInfo.currentPage).toBe(1);
  });
});
```

- [ ] **Step 4: 运行测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/api/parser.test.ts
```

预期：全部 PASS。若某条失败，说明 fixture 与服务端的真实结构对不上——
**这时要改的是 fixture 或抓取工具，不是 parser.ts**（parser 的行为已与线上插件一致）。

- [ ] **Step 5: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 移植 parser.ts 并加真实 fixture 快照测试"
```

---

## Task 2: Rust 收藏命令

**Files:**
- Create: `src-tauri/src/commands/favorites.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/commands/favorites.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn fav(project: i64, env: i64, dtype: &str, branch: Option<&str>) -> Favorite {
        Favorite {
            id: String::new(),
            kind: "config".to_string(),
            deploy_type: dtype.to_string(),
            env_id: env,
            env_name: "测试环境".to_string(),
            project_id: project,
            project_name: format!("zz-proj-{project}"),
            branch: branch.map(|s| s.to_string()),
        }
    }

    #[test]
    fn dedupe_key_ignores_absent_branch() {
        assert_eq!(dedupe_key(&fav(1, 2, "auto", None)), "1_2_auto_");
        assert_eq!(dedupe_key(&fav(1, 2, "auto", Some("main"))), "1_2_auto_main");
    }

    #[test]
    fn dedupe_key_distinguishes_deploy_type() {
        assert_ne!(dedupe_key(&fav(1, 2, "auto", None)), dedupe_key(&fav(1, 2, "docker", None)));
    }

    #[test]
    fn dedupe_key_distinguishes_env() {
        assert_ne!(dedupe_key(&fav(1, 2, "auto", None)), dedupe_key(&fav(1, 4, "auto", None)));
    }

    #[test]
    fn upsert_replaces_same_key_and_keeps_id() {
        let mut list = vec![];
        let first = upsert(&mut list, fav(1, 2, "auto", Some("main")), 1000);
        let second = upsert(&mut list, fav(1, 2, "auto", Some("main")), 2000);
        assert_eq!(list.len(), 1, "同键应替换而非追加");
        assert_eq!(first.id, second.id, "替换时应沿用原 id，避免前端引用失效");
        assert_eq!(second.project_name, "zz-proj-1");
    }

    #[test]
    fn upsert_appends_when_key_differs() {
        let mut list = vec![];
        upsert(&mut list, fav(1, 2, "auto", Some("main")), 1000);
        upsert(&mut list, fav(1, 2, "auto", Some("dev")), 1001);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn upsert_assigns_unique_ids_from_timestamp() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 2, "auto", None), 1000);
        let b = upsert(&mut list, fav(3, 2, "auto", None), 1000);
        assert_ne!(a.id, b.id, "同一毫秒内新增两条也要拿到不同 id");
    }

    #[test]
    fn remove_drops_matching_id_only() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 2, "auto", None), 1000);
        let b = upsert(&mut list, fav(3, 2, "auto", None), 1001);
        remove(&mut list, &a.id);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, b.id);
    }

    #[test]
    fn serializes_with_camel_case_and_type_key() {
        let v = serde_json::to_value(fav(1, 2, "auto", Some("main"))).unwrap();
        assert_eq!(v["deployType"], "auto");
        assert_eq!(v["projectId"], 1);
        assert_eq!(v["envName"], "测试环境");
        // 前端用 type 表示"项目级/配置级"收藏
        assert_eq!(v["type"], "config");
    }

    #[test]
    fn deserializes_existing_json() {
        let text = r#"{"id":"9","type":"project","deployType":"docker","envId":4,
            "envName":"预发布环境","projectId":7,"projectName":"zz-x","branch":null}"#;
        let f: Favorite = serde_json::from_str(text).unwrap();
        assert_eq!(f.kind, "project");
        assert_eq!(f.deploy_type, "docker");
        assert_eq!(f.branch, None);
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib favorites 2>&1 | grep -E "^error" | head -5
```

预期：编译失败，报找不到 `Favorite`

- [ ] **Step 3: 实现**

在测试模块**之前**插入：

```rust
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

const STORE_FILE: &str = "favorites.json";
const ITEMS_KEY: &str = "items";

/// 与插件 `src/favorites.ts` 的 Favorite 结构完全一致，
/// 这样从插件导出的收藏文件可以直接用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub id: String,
    /// "project"（只记项目）| "config"（项目 + 环境 + 分支）
    #[serde(rename = "type")]
    pub kind: String,
    /// "auto" | "docker"
    pub deploy_type: String,
    pub env_id: i64,
    pub env_name: String,
    pub project_id: i64,
    pub project_name: String,
    #[serde(default)]
    pub branch: Option<String>,
}

/// 去重键，与插件 `src/favorites.ts:46` 一致：
/// 同项目 + 同环境 + 同部署类型 + 同分支 视为同一条收藏。
pub fn dedupe_key(f: &Favorite) -> String {
    format!(
        "{}_{}_{}_{}",
        f.project_id,
        f.env_id,
        f.deploy_type,
        f.branch.as_deref().unwrap_or("")
    )
}

/// 新增或替换。已存在同键时**沿用原 id**，否则前端持有的引用会失效。
/// `now_ms` 由调用方传入，便于测试在同一毫秒内新增多条。
pub fn upsert(list: &mut Vec<Favorite>, mut incoming: Favorite, now_ms: u128) -> Favorite {
    let key = dedupe_key(&incoming);
    if let Some(idx) = list.iter().position(|f| dedupe_key(f) == key) {
        incoming.id = list[idx].id.clone();
        list[idx] = incoming.clone();
        return incoming;
    }
    if incoming.id.is_empty() {
        incoming.id = unique_id(list, now_ms);
    }
    list.push(incoming.clone());
    incoming
}

/// 时间戳可能撞车（同一毫秒内连续新增），因此撞了就往后挪一位
fn unique_id(list: &[Favorite], now_ms: u128) -> String {
    let mut candidate = now_ms;
    while list.iter().any(|f| f.id == candidate.to_string()) {
        candidate += 1;
    }
    candidate.to_string()
}

pub fn remove(list: &mut Vec<Favorite>, id: &str) {
    list.retain(|f| f.id != id);
}

fn load_all<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Favorite>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    match store.get(ITEMS_KEY) {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| AppError::config(format!("收藏数据已损坏：{e}"))),
        None => Ok(Vec::new()),
    }
}

fn save_all<R: Runtime>(app: &AppHandle<R>, list: &[Favorite]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    store.set(
        ITEMS_KEY,
        serde_json::to_value(list).map_err(|e| AppError::config(format!("序列化收藏失败：{e}")))?,
    );
    store
        .save()
        .map_err(|e| AppError::config(format!("写入收藏失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn favorites_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Favorite>, AppError> {
    load_all(&app)
}

#[tauri::command]
pub async fn favorites_save<R: Runtime>(
    app: AppHandle<R>,
    fav: Favorite,
) -> Result<Favorite, AppError> {
    let mut list = load_all(&app)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let saved = upsert(&mut list, fav, now_ms);
    save_all(&app, &list)?;
    Ok(saved)
}

#[tauri::command]
pub async fn favorites_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), AppError> {
    let mut list = load_all(&app)?;
    remove(&mut list, &id);
    save_all(&app, &list)
}
```

- [ ] **Step 4: 声明并注册**

`src-tauri/src/commands/mod.rs` 改为：

```rust
pub mod auth;
pub mod config;
pub mod favorites;
```

`src-tauri/src/lib.rs` 的 `generate_handler!` 中追加：

```rust
            commands::favorites::favorites_list,
            commands::favorites::favorites_save,
            commands::favorites::favorites_delete,
```

- [ ] **Step 5: 运行测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib favorites 2>&1 | tail -15
```

预期：9 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat(rust): 收藏读写命令（去重键与 id 沿用逻辑对齐插件）"
```


---

## Task 3: 收藏的前端封装与 store

**Files:**
- Create: `src/api/favorites.ts`
- Create: `src/stores/favorites.ts`
- Create: `src/stores/favorites.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/stores/favorites.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/favorites", () => ({
  listFavorites: vi.fn(),
  saveFavorite: vi.fn(),
  deleteFavorite: vi.fn(),
}));

import * as api from "@/api/favorites";
import { useFavoritesStore, type Favorite } from "./favorites";

function fav(over: Partial<Favorite> = {}): Favorite {
  return {
    id: "1",
    type: "project",
    deployType: "auto",
    envId: 1,
    envName: "测试环境",
    projectId: 10,
    projectName: "zz-cy-iptv",
    ...over,
  };
}

describe("favorites store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("load 拉取列表", async () => {
    vi.mocked(api.listFavorites).mockResolvedValue([fav()]);
    const s = useFavoritesStore();
    await s.load();
    expect(s.items).toHaveLength(1);
  });

  it("save 走 API 并把返回值并入列表", async () => {
    vi.mocked(api.saveFavorite).mockResolvedValue(fav({ id: "9" }));
    const s = useFavoritesStore();
    await s.save({ ...fav(), id: "" });
    expect(s.items.find((f) => f.id === "9")).toBeTruthy();
  });

  it("save 同一条（同 id）时替换而不是追加", async () => {
    vi.mocked(api.saveFavorite).mockResolvedValue(fav({ id: "1", branch: "main" }));
    const s = useFavoritesStore();
    s.items = [fav({ id: "1" })];
    await s.save(fav({ id: "1", branch: "main" }));
    expect(s.items).toHaveLength(1);
    expect(s.items[0].branch).toBe("main");
  });

  it("remove 从列表里删掉", async () => {
    vi.mocked(api.deleteFavorite).mockResolvedValue(undefined);
    const s = useFavoritesStore();
    s.items = [fav({ id: "1" }), fav({ id: "2" })];
    await s.remove("1");
    expect(s.items.map((f) => f.id)).toEqual(["2"]);
  });

  it("isFavorited 按 项目+环境+类型 判断，忽略分支", () => {
    const s = useFavoritesStore();
    s.items = [fav({ projectId: 10, envId: 1, deployType: "auto" })];
    expect(s.isFavorited(10, 1, "auto")).toBe(true);
    expect(s.isFavorited(10, 1, "docker")).toBe(false);
    expect(s.isFavorited(10, 2, "auto")).toBe(false);
    expect(s.isFavorited(99, 1, "auto")).toBe(false);
  });

  it("findByProject 返回匹配的那条，供星标取消收藏时取 id", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "7", projectId: 10, envId: 1, deployType: "auto" })];
    expect(s.findByProject(10, 1, "auto")?.id).toBe("7");
    expect(s.findByProject(10, 1, "docker")).toBeUndefined();
  });

  it("按环境与环境名回填，避免收藏里存了过期的环境名", () => {
    const s = useFavoritesStore();
    s.items = [fav({ id: "1", envName: "旧名字" })];
    s.refreshEnvNames([{ id: 1, name: "测试环境" }]);
    expect(s.items[0].envName).toBe("测试环境");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/favorites.test.ts 2>&1 | tail -6
```

预期：FAIL，找不到模块 `./favorites`

- [ ] **Step 3: 实现 API 封装**

创建 `src/api/favorites.ts`：

```ts
import { call } from "./ipc";

export interface Favorite {
  id: string;
  /** "project" 只记项目 | "config" 记项目 + 环境 + 分支 */
  type: "project" | "config";
  deployType: "auto" | "docker";
  envId: number;
  envName: string;
  projectId: number;
  projectName: string;
  branch?: string;
}

export function listFavorites(): Promise<Favorite[]> {
  return call<Favorite[]>("favorites_list");
}

export function saveFavorite(fav: Favorite): Promise<Favorite> {
  return call<Favorite>("favorites_save", { fav });
}

export function deleteFavorite(id: string): Promise<void> {
  return call<void>("favorites_delete", { id });
}
```

- [ ] **Step 4: 实现 store**

创建 `src/stores/favorites.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/api/favorites";
import type { Favorite } from "@/api/favorites";

export type { Favorite };

export const useFavoritesStore = defineStore("favorites", () => {
  const items = ref<Favorite[]>([]);
  const loaded = ref(false);

  async function load(): Promise<void> {
    items.value = await api.listFavorites();
    loaded.value = true;
  }

  /** 新增或更新。Rust 侧已做去重，这里只需按 id 合并 */
  async function save(fav: Favorite): Promise<Favorite> {
    const saved = await api.saveFavorite(fav);
    const idx = items.value.findIndex((f) => f.id === saved.id);
    if (idx >= 0) items.value[idx] = saved;
    else items.value.push(saved);
    return saved;
  }

  async function remove(id: string): Promise<void> {
    await api.deleteFavorite(id);
    items.value = items.value.filter((f) => f.id !== id);
  }

  /** 与 Rust 侧 dedupe_key 同口径：忽略分支 */
  function findByProject(
    projectId: number,
    envId: number,
    deployType: "auto" | "docker",
  ): Favorite | undefined {
    return items.value.find(
      (f) => f.projectId === projectId && f.envId === envId && f.deployType === deployType,
    );
  }

  function isFavorited(projectId: number, envId: number, deployType: "auto" | "docker"): boolean {
    return findByProject(projectId, envId, deployType) !== undefined;
  }

  /**
   * 用最新的环境列表刷新收藏里存的环境名。
   * 环境列表是硬编码的，改过名字之后老收藏会显示成旧名。
   */
  function refreshEnvNames(envs: { id: number; name: string }[]): void {
    const byId = new Map(envs.map((e) => [e.id, e.name]));
    items.value = items.value.map((f) => {
      const name = byId.get(f.envId);
      return name && name !== f.envName ? { ...f, envName: name } : f;
    });
  }

  return { items, loaded, load, save, remove, findByProject, isFavorited, refreshEnvNames };
});
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/favorites.test.ts 2>&1 | tail -8
```

预期：7 个测试全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 收藏的前端封装与 store"
```

---

## Task 4: 业务接口层 deploy.ts

**Files:**
- Create: `src/api/deploy.ts`
- Create: `src/api/deploy.test.ts`
- Modify: `src/api/http.ts`（加 `httpGetJson` 与 `isActionOk`）

- [ ] **Step 1: 给 http.ts 补两个工具**

在 `src/api/http.ts` 末尾（`export { ... }` 之前）插入：

```ts
/** GET 并解析 JSON。非 200 一律当失败——JSON 接口不会用 302 表达成功 */
export async function httpGetJson<T>(path: string, query?: Query): Promise<T> {
  const r = await httpGet(path, query);
  if (r.status !== 200) {
    throw toAppError({ kind: "server", message: `HTTP ${r.status}`, retryable: r.status >= 500 });
  }
  try {
    return JSON.parse(r.body) as T;
  } catch (e) {
    throw toAppError({
      kind: "parse",
      message: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      retryable: false,
    });
  }
}

/**
 * 上线 / 回滚 / 删除这类"触发动作"的成功判定。
 *
 * 插件里的写法是 `status === 302 || resp.ok`（`src/api/deploy.ts:79`），
 * 但它有个漏洞：会话过期时服务端也返回 302，只是指向 /login/，
 * 会被误判成成功。这里先排除登录跳转。
 */
export function isActionOk(r: HttpResult): boolean {
  if (isLoginRedirect(r)) return false;
  return r.status === 302 || (r.status >= 200 && r.status < 300);
}
```

- [ ] **Step 2: 写失败的测试**

创建 `src/api/deploy.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./http", async () => {
  const actual = await vi.importActual<typeof import("./http")>("./http");
  return {
    ...actual,
    httpGet: vi.fn(),
    httpPost: vi.fn(),
    httpGetJson: vi.fn(),
  };
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as http from "./http";
import {
  ENVS,
  deployPath,
  fetchProjects,
  fetchBranches,
  fetchCommits,
  submitDeploy,
  fetchTaskList,
  submitOnline,
  submitRollback,
  deleteTask,
  cleanProjectName,
} from "./deploy";

function res(status: number, location: string | null = null, body = ""): http.HttpResult {
  return { status, location, body };
}

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
function fixtureJson(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf-8"));
}

describe("deployPath", () => {
  it("自动化与 docker 走不同的前缀", () => {
    expect(deployPath("auto")).toBe("deployment/deploy");
    expect(deployPath("docker")).toBe("dockerdeploy/docker");
  });
});

describe("ENVS", () => {
  it("就是 spec 里那 9 个环境，顺序与 id 都不能变", () => {
    expect(ENVS.map((e) => e.id)).toEqual([1, 2, 4, 7, 8, 9, 11, 12, 14]);
    expect(ENVS[0]).toEqual({ id: 1, name: "测试环境" });
    expect(ENVS[8]).toEqual({ id: 14, name: "腾讯云" });
  });
});

describe("cleanProjectName", () => {
  it("去掉括号后缀", () => {
    expect(cleanProjectName("zz-cy-iptv（tke_node）")).toBe("zz-cy-iptv");
    expect(cleanProjectName("zz-vip-web(prod)")).toBe("zz-vip-web");
  });

  it("没有括号时原样返回（并 trim）", () => {
    expect(cleanProjectName("  zz-pay  ")).toBe("zz-pay");
  });
});

describe("fetchProjects", () => {
  beforeEach(() => vi.clearAllMocks());

  it("请求正确路径并解析出项目", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(
      res(200, null, '<a class="btn-info" href="/deployment/deploy/submit/42/">zz-proj</a>'),
    );
    const out = await fetchProjects("auto", 1);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/", { env: 1 });
    expect(out).toEqual([{ id: 42, name: "zz-proj" }]);
  });

  it("docker 走 docker 前缀", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200, null, ""));
    await fetchProjects("docker", 2);
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/submit/", { env: 2 });
  });
});

describe("fetchBranches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("请求项目页并解析 #branchtag option", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(
      res(200, null, '<select id="branchtag"><option value="main">main</option></select>'),
    );
    const out = await fetchBranches("auto", 42);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/42/");
    expect(out).toEqual(["main"]);
  });
});

describe("fetchCommits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("用清理过的项目名请求 devapi，并拆开 hash 与 message", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({
      msg: "success",
      data: [{ project: "zz-cy-iptv", commitids: ["abc123#-----#修复黑屏", "def456#-----#优化"] }],
    });
    const out = await fetchCommits("zz-cy-iptv（tke_node）", "main");
    expect(http.httpGetJson).toHaveBeenCalledWith("/devapi/projectcommit/", {
      project: "zz-cy-iptv",
      branch: "main",
    });
    expect(out).toEqual([
      { hash: "abc123", message: "修复黑屏", fullString: "abc123#-----#修复黑屏" },
      { hash: "def456", message: "优化", fullString: "def456#-----#优化" },
    ]);
  });

  it("msg 非 success 时返回空数组而不抛错", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({ msg: "fail", data: [] });
    expect(await fetchCommits("x", "main")).toEqual([]);
  });

  it("data 为空时返回空数组", async () => {
    vi.mocked(http.httpGetJson).mockResolvedValue({ msg: "success", data: [] });
    expect(await fetchCommits("x", "main")).toEqual([]);
  });

  it("真实样本能解析出 hash 与 message", () => {
    // 用抓取到的真实响应，锁住 #-----# 的拆解格式
    const sample = fixtureJson("commits_sample.json");
    vi.mocked(http.httpGetJson).mockResolvedValue(sample as never);
    return fetchCommits("supermagicstudio-net", "release/gaoshantec_com").then((out) => {
      expect(out.length).toBeGreaterThan(0);
      for (const c of out) {
        expect(c.hash).toMatch(/^[0-9a-f]{7,40}$/);
        expect(typeof c.message).toBe("string");
        expect(c.fullString).toContain("#-----#");
      }
    });
  });

  it("过滤掉不含分隔符的服务端警告（真实边界情况）", async () => {
    // devapi/projectcommit 在项目不存在或 git 配置异常时仍返回 msg="success"，
    // 却把一句中文警告塞进 commitids 数组（样本见 commits_warning_sample.json）。
    // 不处理的话，Commit 下拉里会出现 hash 为整句中文的假记录。
    const warning = fixtureJson("commits_warning_sample.json");
    vi.mocked(http.httpGetJson).mockResolvedValue(warning as never);
    const out = await fetchCommits("__nonexistent_project__", "release/x");
    expect(out).toEqual([]);
  });
});

describe("submitDeploy", () => {
  beforeEach(() => vi.clearAllMocks());

  it("自动化不带 branchtag", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/deployment/deploy/task/"));
    const ok = await submitDeploy("auto", 42, { title: "t", branchtag: "main", version: "v1" });
    expect(ok).toBe(true);
    const [path, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(path).toBe("/deployment/deploy/submit/task/42/");
    expect(form).not.toHaveProperty("branchtag");
  });

  it("docker 带 branchtag", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/dockerdeploy/docker/task/"));
    await submitDeploy("docker", 42, { title: "t", branchtag: "release/v1", version: "v1" });
    const [, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(form).toMatchObject({ branchtag: "release/v1" });
  });

  it("必须带上踩坑加上的三个字段", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/x/"));
    await submitDeploy("auto", 42, { title: "标题", branchtag: "main", version: "v1" });
    const [, form] = vi.mocked(http.httpPost).mock.calls[0];
    expect(form).toMatchObject({
      title: "标题",
      version: "v1",
      iteration_id: "0",
      serial: "1",
      destination_host: "",
    });
  });

  it("302 指向登录页时判为失败（不能误报成功）", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(302, "/login/?next=/x"));
    expect(await submitDeploy("auto", 42, { title: "t", branchtag: "b", version: "v" })).toBe(false);
  });

  it("500 判为失败", async () => {
    vi.mocked(http.httpPost).mockResolvedValue(res(500));
    expect(await submitDeploy("auto", 42, { title: "t", branchtag: "b", version: "v" })).toBe(false);
  });
});

describe("fetchTaskList", () => {
  beforeEach(() => vi.clearAllMocks());

  it("带 page 与 search 参数，并按类型解析", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200, null, "<html></html>"));
    const out = await fetchTaskList("docker", 3, "zz-pay");
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/task/", {
      page: 3,
      search: "zz-pay",
    });
    expect(out).toEqual({
      tasks: [],
      pageInfo: { currentPage: 1, totalPages: 1, hasPrev: false, hasNext: false },
    });
  });
});

describe("行内操作", () => {
  beforeEach(() => vi.clearAllMocks());

  it("上线走 /up/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/deployment/deploy/task/"));
    expect(await submitOnline("auto", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/task/7/up/");
  });

  it("回滚走 /roll/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/x/"));
    expect(await submitRollback("docker", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/dockerdeploy/docker/task/7/roll/");
  });

  it("删除走 /submit/task/{id}/", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/x/"));
    expect(await deleteTask("auto", 7)).toBe(true);
    expect(http.httpGet).toHaveBeenCalledWith("/deployment/deploy/submit/task/7/");
  });

  it("会话过期时三个操作都判为失败", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(302, "/login/"));
    expect(await submitOnline("auto", 7)).toBe(false);
    expect(await submitRollback("auto", 7)).toBe(false);
    expect(await deleteTask("auto", 7)).toBe(false);
  });

  it("200 也算成功（服务端有的动作直接返回页面）", async () => {
    vi.mocked(http.httpGet).mockResolvedValue(res(200));
    expect(await submitOnline("auto", 7)).toBe(true);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/api/deploy.test.ts 2>&1 | tail -6
```

预期：FAIL，找不到模块 `./deploy`

- [ ] **Step 4: 实现**

创建 `src/api/deploy.ts`：

```ts
import { httpGet, httpGetJson, httpPost, isSuccessRedirect, isActionOk } from "./http";
import { parseProjects, parseBranches, parseTaskList } from "./parser";
import type { Project, TaskListResult } from "./parser";

export type { Project, TaskListResult };

export type DeployType = "auto" | "docker";

/** commit 与 message 的分隔符，服务端原始值（5 个连字符） */
const COMMIT_SEPARATOR = "#-----#";

export interface CommitInfo {
  hash: string;
  message: string;
  fullString: string;
}

/**
 * 环境列表是硬编码的（spec §11 明确不做自定义环境列表）。
 * id 必须与服务端一致，顺序也不要动。
 */
export const ENVS: { id: number; name: string }[] = [
  { id: 1, name: "测试环境" },
  { id: 2, name: "正式环境" },
  { id: 4, name: "预发布环境" },
  { id: 7, name: "开发环境" },
  { id: 8, name: "测试环境2" },
  { id: 9, name: "UAT环境" },
  { id: 11, name: "测试环境3" },
  { id: 12, name: "谷歌云" },
  { id: 14, name: "腾讯云" },
];

/** 两种部署类型在服务端是两套完全不同的路由前缀 */
export function deployPath(type: DeployType): string {
  return type === "auto" ? "deployment/deploy" : "dockerdeploy/docker";
}

/**
 * 项目名可能带括号后缀，如 "zz-cy-iptv（tke_node）"，
 * 而 commit 接口只认括号前的主体。对应插件 src/api/deploy.ts:29。
 */
export function cleanProjectName(projectName: string): string {
  return projectName.replace(/[（(][^）)]*[）)]/g, "").trim();
}

export async function fetchProjects(type: DeployType, envId: number): Promise<Project[]> {
  const r = await httpGet(`/${deployPath(type)}/submit/`, { env: envId });
  return parseProjects(r.body);
}

export async function fetchBranches(type: DeployType, projectId: number): Promise<string[]> {
  const r = await httpGet(`/${deployPath(type)}/submit/${projectId}/`);
  return parseBranches(r.body);
}

export async function fetchCommits(projectName: string, branch: string): Promise<CommitInfo[]> {
  const data = await httpGetJson<{
    msg: string;
    data: Array<{ project: string; commitids: string[] }>;
  }>("/devapi/projectcommit/", { project: cleanProjectName(projectName), branch });

  if (data.msg !== "success" || !data.data.length) return [];

  return (
    data.data[0].commitids
      // 服务端在项目不存在或 git 配置异常时，仍返回 msg="success"，
      // 却把一句中文警告塞进 commitids（实例见 __fixtures__/commits_warning_sample.json）。
      // 正常 commit 一定含 "#-----#"，警告文本不含，据此过滤掉。
      // 插件没有这层过滤（src/api/deploy.ts:37），会显示假记录。
      .filter((raw) => raw.includes(COMMIT_SEPARATOR))
      .map((raw) => {
        const [hash, message] = raw.split(COMMIT_SEPARATOR);
        return { hash, message, fullString: raw };
      })
  );
}

export interface SubmitDeployParams {
  title: string;
  branchtag: string;
  version: string;
}

export async function submitDeploy(
  type: DeployType,
  projectId: number,
  params: SubmitDeployParams,
): Promise<boolean> {
  const body: Record<string, string> = {
    title: params.title,
    version: params.version,
    // 下面三个字段是踩坑补上的，删掉服务端会 500（插件 src/api/deploy.ts:48-57）
    iteration_id: "0",
    serial: "1",
    destination_host: "",
  };
  // 只有 docker 需要 branchtag
  if (type === "docker") {
    body.branchtag = params.branchtag;
  }
  const r = await httpPost(`/${deployPath(type)}/submit/task/${projectId}/`, body);
  return isSuccessRedirect(r);
}

export async function fetchTaskList(
  type: DeployType,
  page: number,
  search: string,
): Promise<TaskListResult> {
  const r = await httpGet(`/${deployPath(type)}/task/`, { page, search });
  return parseTaskList(r.body, type);
}

export async function submitOnline(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/task/${taskId}/up/`));
}

export async function submitRollback(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/task/${taskId}/roll/`));
}

export async function deleteTask(type: DeployType, taskId: number): Promise<boolean> {
  return isActionOk(await httpGet(`/${deployPath(type)}/submit/task/${taskId}/`));
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/api/deploy.test.ts 2>&1 | tail -8
```

预期：全部 PASS

- [ ] **Step 6: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A
git commit -m "feat: 业务接口层 deploy.ts（含 isActionOk 修掉插件误判成功的漏洞）"
```

---

## Task 5: 标签内容容器改造

现在 App.vue 只渲染当前激活标签的内容，切走就丢状态。向导需要"开了两个标签、各自保留已选的环境/项目"，
所以要改成**所有标签都挂载、非激活的用 v-show 隐藏**。

**Files:**
- Create: `src/components/TabHost.vue`
- Modify: `src/App.vue`

- [ ] **Step 1: 写 TabHost**

创建 `src/components/TabHost.vue`：

```vue
<script setup lang="ts">
import DeployWizard from "@/views/DeployWizard.vue";
import TaskListView from "@/views/TaskListView.vue";
import FavoritesView from "@/views/FavoritesView.vue";
import SettingsView from "@/views/SettingsView.vue";
import WipView from "@/views/WipView.vue";
import { useTabsStore } from "@/stores/tabs";

const tabs = useTabsStore();
</script>

<template>
  <!--
    所有标签同时挂载，非激活的用 v-show 隐藏。
    这样每个向导标签的已选环境/项目/分支都能保留，切换标签不会丢；
    日志标签（Plan 3）也需要这个特性才能在后台继续收 WebSocket。
  -->
  <div
    v-for="t in tabs.tabs"
    v-show="tabs.activeId === t.id"
    :key="t.id"
    class="h-full"
  >
    <DeployWizard v-if="t.kind === 'wizard'" />
    <TaskListView v-else-if="t.kind === 'list'" />
    <FavoritesView v-else-if="t.kind === 'favorites'" />
    <SettingsView v-else-if="t.kind === 'settings'" />
    <WipView v-else :title="tabs.titleOf(t)" />
  </div>
</template>
```

- [ ] **Step 2: 改造 App.vue 的 main 区域**

把 `src/App.vue` 里 `<main>` 的内容替换为：

```vue
        <main class="flex-1 min-h-0 overflow-auto">
          <TabHost v-if="tabs.tabs.length > 0" />
          <div v-else class="h-full flex items-center justify-center text-text-muted text-sm">
            从左侧导航打开一个页面
          </div>
        </main>
```

并在 import 区加入：

```ts
import TabHost from "./components/TabHost.vue";
```

同时删掉不再使用的 `WipView` 与 `SettingsView` 的 import 与 `activeTitle` computed
（它们已经移进 TabHost 内部）。

- [ ] **Step 3: 建三个占位视图**

先建最小可用版本，让 TabHost 能编译；后续 Task 逐个替换。

创建 `src/views/DeployWizard.vue`：

```vue
<template>
  <div class="p-6 text-text-muted text-sm">新建部署向导（Task 6 实现）</div>
</template>
```

创建 `src/views/TaskListView.vue`：

```vue
<template>
  <div class="p-6 text-text-muted text-sm">任务列表（Task 8 实现）</div>
</template>
```

创建 `src/views/FavoritesView.vue`：

```vue
<template>
  <div class="p-6 text-text-muted text-sm">收藏（Task 11 实现）</div>
</template>
```

- [ ] **Step 4: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Tests "
npm run build 2>&1 | tail -4
```

预期：测试全绿、构建通过

- [ ] **Step 5: 手工验证标签状态保留**

```bash
npm run tauri dev
```

开两个「新建部署」标签，在其中一个选个环境，切到另一个标签再切回来 —— 选择应该还在。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 标签内容容器改为全部挂载 + v-show，保留各标签状态"
```

---

## Task 6: 新建部署向导（选择部分）

**Files:**
- Create: `src/components/common/StatusBadge.vue`
- Create: `src/components/deploy/EnvPicker.vue`
- Create: `src/views/DeployWizard.vue`（替换占位版）
- Create: `src/stores/tasks.ts`（本 Task 只建骨架，Task 8 填充）

- [ ] **Step 1: 写状态标签组件**

创建 `src/components/common/StatusBadge.vue`：

```vue
<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ text: string; kind?: "auto" | "build" }>();

/** 状态文案里带「成功/失败/中」等关键字，服务端没给结构化状态，只能按文案判 */
const tone = computed(() => {
  const t = props.text ?? "";
  if (t.includes("成功")) return "success";
  if (t.includes("失败")) return "danger";
  if (t.includes("中") || t.includes("进行")) return "warning";
  return "neutral";
});

const classes = computed(() => {
  switch (tone.value) {
    case "success":
      return "bg-success/15 text-success border-success/30";
    case "danger":
      return "bg-danger/15 text-danger border-danger/30";
    case "warning":
      return "bg-warning/15 text-warning border-warning/30";
    default:
      return "bg-surface-2 text-text-muted border-border";
  }
});
</script>

<template>
  <span
    :class="[
      'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] whitespace-nowrap',
      classes,
    ]"
  >
    <span v-if="tone === 'warning'" class="size-1.5 rounded-full bg-current animate-pulse" />
    {{ text || "—" }}
  </span>
</template>
```

- [ ] **Step 2: 写环境选择器**

创建 `src/components/deploy/EnvPicker.vue`：

```vue
<script setup lang="ts">
import { ENVS } from "@/api/deploy";

defineProps<{ modelValue: number | null }>();
const emit = defineEmits<{ "update:modelValue": [number] }>();
</script>

<template>
  <div class="grid grid-cols-3 gap-2">
    <button
      v-for="e in ENVS"
      :key="e.id"
      type="button"
      :class="[
        'px-3 py-2 rounded-md border text-xs text-left transition-colors',
        modelValue === e.id
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-border bg-surface hover:bg-surface-2',
      ]"
      @click="emit('update:modelValue', e.id)"
    >
      {{ e.name }}
    </button>
  </div>
</template>
```

- [ ] **Step 3: 写向导主体（选择部分，先不接提交）**

替换 `src/views/DeployWizard.vue`：

```vue
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ENVS, fetchProjects, fetchBranches, fetchCommits } from "@/api/deploy";
import type { CommitInfo, DeployType, Project } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import EnvPicker from "@/components/deploy/EnvPicker.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/*
 * 状态全部放在组件本地：每个向导标签渲染一个独立实例，
 * 因此天然是"每个标签一份状态"，不需要额外的 store 或 id 映射。
 */
const deployType = ref<DeployType>("auto");
const envId = ref<number | null>(null);
const projects = ref<Project[] | null>(null);
const projectSearch = ref("");
const selectedProject = ref<Project | null>(null);
const branches = ref<string[]>([]);
const selectedBranch = ref("");
const commits = ref<CommitInfo[]>([]);
const selectedCommit = ref("");
const title = ref("");

const loading = ref({ projects: false, branches: false, commits: false });
const error = ref("");

const envName = computed(() => ENVS.find((e) => e.id === envId.value)?.name ?? "");

const filteredProjects = computed(() => {
  const q = projectSearch.value.trim().toLowerCase();
  const list = projects.value ?? [];
  return q ? list.filter((p) => p.name.toLowerCase().includes(q)) : list;
});

/** 换了部署类型或环境，后面所有选择都要清空——服务端两套路由的项目 id 不通用 */
watch([deployType, envId], async ([, env]) => {
  projects.value = null;
  selectedProject.value = null;
  resetAfterProject();
  error.value = "";
  if (!env) return;
  loading.value.projects = true;
  try {
    projects.value = await fetchProjects(deployType.value, env);
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    loading.value.projects = false;
  }
});

function resetAfterProject(): void {
  branches.value = [];
  selectedBranch.value = "";
  commits.value = [];
  selectedCommit.value = "";
}

async function pickProject(p: Project): Promise<void> {
  selectedProject.value = p;
  resetAfterProject();
  error.value = "";
  loading.value.branches = true;
  try {
    branches.value = await fetchBranches(deployType.value, p.id);
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    loading.value.branches = false;
  }
}

async function pickBranch(branch: string): Promise<void> {
  selectedBranch.value = branch;
  commits.value = [];
  selectedCommit.value = "";
  if (!selectedProject.value || !branch) return;
  error.value = "";
  loading.value.commits = true;
  try {
    commits.value = await fetchCommits(selectedProject.value.name, branch);
  } catch (e) {
    error.value = toUserMessage(e);
  } finally {
    loading.value.commits = false;
  }
}
</script>

<template>
  <div class="max-w-[860px] p-6 space-y-6">
    <h1 class="text-base font-semibold">新建部署</h1>

    <section class="space-y-2">
      <Label>部署类型</Label>
      <div class="flex gap-2">
        <Button
          v-for="t in (['auto', 'docker'] as const)"
          :key="t"
          :variant="deployType === t ? 'default' : 'outline'"
          size="sm"
          @click="deployType = t"
        >
          {{ t === "auto" ? "自动化部署" : "Docker 部署" }}
        </Button>
      </div>
    </section>

    <section class="space-y-2">
      <Label>环境</Label>
      <EnvPicker v-model="envId" />
    </section>

    <section v-if="loading.projects" class="text-xs text-text-muted">正在加载项目…</section>

    <section v-else-if="projects" class="space-y-2">
      <div class="flex items-center justify-between">
        <Label>项目（{{ filteredProjects.length }} / {{ projects.length }}）</Label>
        <Input v-model="projectSearch" placeholder="搜索项目…" class="w-56 h-8" />
      </div>
      <div v-if="projects.length === 0" class="text-xs text-text-muted">该环境下没有项目</div>
      <div v-else class="flex flex-wrap gap-2 max-h-[240px] overflow-auto p-1">
        <Button
          v-for="p in filteredProjects"
          :key="p.id"
          :variant="selectedProject?.id === p.id ? 'default' : 'secondary'"
          size="sm"
          class="text-xs"
          @click="pickProject(p)"
        >
          {{ p.name }}
        </Button>
      </div>
    </section>

    <section v-if="selectedProject" class="space-y-2">
      <Label>分支</Label>
      <div v-if="loading.branches" class="text-xs text-text-muted">正在加载分支…</div>
      <div v-else-if="branches.length === 0" class="text-xs text-text-muted">未找到分支</div>
      <div v-else class="flex flex-wrap gap-2 max-h-[180px] overflow-auto p-1">
        <Button
          v-for="b in branches"
          :key="b"
          :variant="selectedBranch === b ? 'default' : 'secondary'"
          size="sm"
          class="text-xs font-mono"
          @click="pickBranch(b)"
        >
          {{ b }}
        </Button>
      </div>
    </section>

    <section v-if="selectedBranch" class="space-y-2">
      <Label>Commit</Label>
      <div v-if="loading.commits" class="text-xs text-text-muted">正在加载 Commit…</div>
      <div v-else-if="commits.length === 0" class="text-xs text-text-muted">未找到 Commit 记录</div>
      <select
        v-else
        v-model="selectedCommit"
        class="w-full h-9 rounded-md border border-border bg-surface px-2 text-xs font-mono"
      >
        <option value="">-- 选择 Commit --</option>
        <option v-for="c in commits" :key="c.fullString" :value="c.fullString">
          {{ c.hash.slice(0, 8) }} {{ c.message }}
        </option>
      </select>
    </section>

    <p v-if="error" class="text-xs text-danger">{{ error }}</p>

    <!-- 提交流程在 Task 7 接上 -->
    <section v-if="selectedCommit" class="pt-2 border-t border-border space-y-2">
      <Label for="deploy-title">任务标题（留空则由服务端生成）</Label>
      <Input id="deploy-title" v-model="title" class="h-8" placeholder="可选" />
      <p class="text-xs text-text-muted">
        即将部署：{{ envName }} / {{ selectedProject?.name }} / {{ selectedBranch }}
      </p>
    </section>
  </div>
</template>
```

- [ ] **Step 4: 建 tasks store 骨架**

创建 `src/stores/tasks.ts`（Task 8 会填充）：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import type { DeployType } from "@/api/deploy";
import type { DeployTask, PageInfo } from "@/api/parser";

export const useTasksStore = defineStore("tasks", () => {
  const deployType = ref<DeployType>("auto");
  const page = ref(1);
  const search = ref("");
  const tasks = ref<DeployTask[]>([]);
  const pageInfo = ref<PageInfo>({
    currentPage: 1,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
  });
  const loading = ref(false);

  return { deployType, page, search, tasks, pageInfo, loading };
});
```

- [ ] **Step 5: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Tests "
npm run build 2>&1 | tail -4
```

- [ ] **Step 6: 手工验证**

```bash
npm run tauri dev
```

选环境 → 出现项目列表 → 搜索过滤 → 选项目 → 出现分支 → 选分支 → 出现 Commit 下拉。
切换部署类型应把所有后续选择清空。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat: 新建部署向导的选择部分（环境/项目/分支/Commit）"
```

---

## Task 7: 提交部署

**Files:**
- Create: `src/components/common/ConfirmDialog.vue`
- Modify: `src/views/DeployWizard.vue`

- [ ] **Step 1: 写确认对话框**

创建 `src/components/common/ConfirmDialog.vue`：

```vue
<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

const props = defineProps<{
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  loading?: boolean;
}>();

const emit = defineEmits<{ "update:open": [boolean]; confirm: []; cancel: [] }>();

function onOpenChange(v: boolean): void {
  emit("update:open", v);
  if (!v) emit("cancel");
}
</script>

<template>
  <Dialog :open="props.open" @update:open="onOpenChange">
    <DialogContent class="max-w-[380px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription v-if="description">{{ description }}</DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" :disabled="loading" @click="onOpenChange(false)">
          {{ cancelText ?? "取消" }}
        </Button>
        <Button
          :variant="danger ? 'destructive' : 'default'"
          :disabled="loading"
          @click="emit('confirm')"
        >
          {{ loading ? "处理中…" : (confirmText ?? "确认") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
```

- [ ] **Step 2: 给向导接上提交**

在 `src/views/DeployWizard.vue` 的 `<script setup>` 中追加 import 与状态：

```ts
import { submitDeploy } from "@/api/deploy";
import { saveFavorite } from "@/api/favorites";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { useTabsStore } from "@/stores/tabs";
import { useTasksStore } from "@/stores/tasks";

const tabs = useTabsStore();
const tasks = useTasksStore();

const submitting = ref(false);
const confirmOpen = ref(false);
const favPromptOpen = ref(false);
const flash = ref("");

function flashMsg(msg: string): void {
  flash.value = msg;
  setTimeout(() => (flash.value = ""), 3000);
}

async function doSubmit(): Promise<void> {
  if (!selectedProject.value || !selectedBranch.value || !selectedCommit.value) return;
  submitting.value = true;
  error.value = "";
  try {
    const ok = await submitDeploy(deployType.value, selectedProject.value.id, {
      title: title.value,
      branchtag: selectedBranch.value,
      version: selectedCommit.value,
    });
    confirmOpen.value = false;
    if (!ok) {
      error.value = "提交失败，请重试";
      return;
    }
    // 提交成功：记下类型，让任务列表切到对应页签，然后自动切过去
    const envLabel = envName.value;
    const projLabel = selectedProject.value.name;
    tasks.deployType = deployType.value;
    tasks.page = 1;
    tabs.open({ kind: "list" });
    tabs.closeByKind("wizard");
    void envLabel;
    void projLabel;
  } catch (e) {
    confirmOpen.value = false;
    error.value = toUserMessage(e);
  } finally {
    submitting.value = false;
  }
}
```

并在模板末尾（`<p v-if="error">` 之后）追加：

```vue
    <section v-if="selectedCommit" class="pt-2 border-t border-border space-y-3">
      <Label for="deploy-title">任务标题（留空则由服务端生成）</Label>
      <Input id="deploy-title" v-model="title" class="h-8" placeholder="可选" />
      <p class="text-xs text-text-muted">
        即将部署：{{ envName }} / {{ selectedProject?.name }} / {{ selectedBranch }}
      </p>
      <div class="flex gap-2">
        <Button :disabled="submitting" @click="confirmOpen = true">
          {{ submitting ? "提交中…" : "确认提交部署" }}
        </Button>
        <Button variant="outline" :disabled="submitting" @click="favPromptOpen = true">
          保存为收藏
        </Button>
      </div>
      <p v-if="flash" class="text-xs text-success">{{ flash }}</p>
    </section>

    <ConfirmDialog
      v-model:open="confirmOpen"
      title="确认提交部署？"
      :description="`${envName} / ${selectedProject?.name} / ${selectedBranch}`"
      confirm-text="提交"
      :loading="submitting"
      @confirm="doSubmit"
    />

    <ConfirmDialog
      v-model:open="favPromptOpen"
      title="保存为收藏？"
      description="将保存项目 + 环境 + 分支，之后可一键复用"
      confirm-text="保存"
      @confirm="onSaveFavorite"
    />
```

并把上面那段**原有的**占位 section 删掉（就是 Task 6 里那段带 `<!-- 提交流程在 Task 7 接上 -->` 的）：

```vue
    <!-- 提交流程在 Task 7 接上 -->
    <section v-if="selectedCommit" class="pt-2 border-t border-border space-y-2">
      <Label for="deploy-title">任务标题（留空则由服务端生成）</Label>
      <Input id="deploy-title" v-model="title" class="h-8" placeholder="可选" />
      <p class="text-xs text-text-muted">
        即将部署：{{ envName }} / {{ selectedProject?.name }} / {{ selectedBranch }}
      </p>
    </section>
```

再追加保存收藏的处理函数：

```ts
async function onSaveFavorite(): Promise<void> {
  if (!selectedProject.value || !selectedBranch.value || envId.value === null) return;
  await saveFavorite({
    id: "",
    type: "config",
    deployType: deployType.value,
    envId: envId.value,
    envName: envName.value,
    projectId: selectedProject.value.id,
    projectName: selectedProject.value.name,
    branch: selectedBranch.value,
  });
  favPromptOpen.value = false;
  flashMsg("已保存为收藏");
}
```

- [ ] **Step 3: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run build 2>&1 | tail -4
```

- [ ] **Step 4: 手工验证**

```bash
npm run tauri dev
```

走完整流程：环境 → 项目 → 分支 → Commit → 确认提交。
预期：弹出确认框 → 提交后向导标签自动关闭 → 自动切到「任务列表」标签。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 提交部署与保存收藏（提交成功后向导标签自毁并跳转任务列表）"
```

---

## Task 8: 任务列表

**Files:**
- Modify: `src/stores/tasks.ts`（填充实现）
- Modify: `src/views/TaskListView.vue`
- Create: `src/stores/tasks.test.ts`

- [ ] **Step 1: 写失败的测试**

创建 `src/stores/tasks.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { setActivePinia, createPinia } from "pinia";

vi.mock("@/api/deploy", () => ({
  fetchTaskList: vi.fn(),
}));

import * as deployApi from "@/api/deploy";
import { useTasksStore } from "./tasks";
import type { DeployTask } from "@/api/parser";

function task(id: number, over: Partial<DeployTask> = {}): DeployTask {
  return {
    taskId: id,
    title: `任务${id}`,
    projectName: "zz-x",
    envName: "测试环境",
    cluster: "",
    deployType: "",
    branch: "main",
    version: "v1",
    onlineStatus: "-",
    buildStatus: "构建中",
    submitTime: "2026-10-13 10:00:00",
    submitter: "zhangsan",
    canUp: true,
    canRoll: false,
    canDelete: true,
    ...over,
  };
}

const PAGE = {
  tasks: [task(1), task(2)],
  pageInfo: { currentPage: 1, totalPages: 5, hasPrev: false, hasNext: true },
};

describe("tasks store", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it("refresh 拉取并填充", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    await s.refresh();
    expect(s.tasks).toHaveLength(2);
    expect(s.pageInfo.totalPages).toBe(5);
    expect(s.loading).toBe(false);
  });

  it("请求时带上当前的 类型/页码/搜索词", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.deployType = "docker";
    s.page = 3;
    s.search = "zz-pay";
    await s.refresh();
    expect(deployApi.fetchTaskList).toHaveBeenCalledWith("docker", 3, "zz-pay");
  });

  it("发起请求期间 loading 为 true", async () => {
    let resolve!: (v: typeof PAGE) => void;
    vi.mocked(deployApi.fetchTaskList).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const s = useTasksStore();
    const p = s.refresh();
    expect(s.loading).toBe(true);
    resolve(PAGE);
    await p;
    expect(s.loading).toBe(false);
  });

  it("失败时记录错误并停止 loading，不抛给调用方", async () => {
    vi.mocked(deployApi.fetchTaskList).mockRejectedValue({ kind: "network", message: "x" });
    const s = useTasksStore();
    await s.refresh();
    expect(s.error).toContain("网络");
    expect(s.loading).toBe(false);
  });

  it("切换部署类型会重置到第 1 页", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.page = 4;
    await s.setDeployType("docker");
    expect(s.deployType).toBe("docker");
    expect(s.page).toBe(1);
  });

  it("提交搜索会重置到第 1 页", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.page = 4;
    await s.applySearch("zz-pay");
    expect(s.search).toBe("zz-pay");
    expect(s.page).toBe(1);
  });

  it("goPage 越界时不发请求", async () => {
    vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 5, hasPrev: false, hasNext: true };
    await s.goPage(0);
    await s.goPage(99);
    expect(deployApi.fetchTaskList).not.toHaveBeenCalled();
  });

  it("removeLocal 把删掉的任务从列表里去掉", () => {
    const s = useTasksStore();
    s.tasks = [task(1), task(2), task(3)];
    s.removeLocal(2);
    expect(s.tasks.map((t) => t.taskId)).toEqual([1, 3]);
  });

  it("pageWindow 给出当前页附近的页码且不越界", () => {
    const s = useTasksStore();
    s.pageInfo = { currentPage: 1, totalPages: 3, hasPrev: false, hasNext: true };
    expect(s.pageWindow()).toEqual([1, 2, 3]);

    s.pageInfo = { currentPage: 9, totalPages: 20, hasPrev: true, hasNext: true };
    expect(s.pageWindow()).toEqual([7, 8, 9, 10, 11]);

    s.pageInfo = { currentPage: 20, totalPages: 20, hasPrev: true, hasNext: false };
    expect(s.pageWindow()).toEqual([18, 19, 20]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tasks.test.ts 2>&1 | tail -6
```

预期：FAIL（store 里还没有 refresh 等方法）

- [ ] **Step 3: 实现 tasks store**

用下面内容整体替换 `src/stores/tasks.ts`：

```ts
import { defineStore } from "pinia";
import { ref } from "vue";
import { fetchTaskList } from "@/api/deploy";
import type { DeployType } from "@/api/deploy";
import type { DeployTask, PageInfo } from "@/api/parser";
import { toUserMessage } from "@/api/http";

export const useTasksStore = defineStore("tasks", () => {
  const deployType = ref<DeployType>("auto");
  const page = ref(1);
  const search = ref("");
  const tasks = ref<DeployTask[]>([]);
  const pageInfo = ref<PageInfo>({
    currentPage: 1,
    totalPages: 1,
    hasPrev: false,
    hasNext: false,
  });
  const loading = ref(false);
  const error = ref("");

  /** 拉取当前条件下的列表。失败只记录到 error，不抛给调用方——
   * 它被轮询和按钮两处调用，抛异常会变成未捕获的 rejection。 */
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const r = await fetchTaskList(deployType.value, page.value, search.value);
      tasks.value = r.tasks;
      pageInfo.value = r.pageInfo;
    } catch (e) {
      error.value = toUserMessage(e);
    } finally {
      loading.value = false;
    }
  }

  async function setDeployType(t: DeployType): Promise<void> {
    if (deployType.value === t) return;
    deployType.value = t;
    page.value = 1;
    await refresh();
  }

  async function applySearch(q: string): Promise<void> {
    search.value = q;
    page.value = 1;
    await refresh();
  }

  async function goPage(p: number): Promise<void> {
    if (p < 1 || p > pageInfo.value.totalPages || p === page.value) return;
    page.value = p;
    await refresh();
  }

  /** 删除成功后本地移除，避免为了刷新多打一次请求（列表随后会被轮询刷新） */
  function removeLocal(taskId: number): void {
    tasks.value = tasks.value.filter((t) => t.taskId !== taskId);
  }

  /** 当前页 ±2 的页码窗口，已按上下界裁剪 */
  function pageWindow(): number[] {
    const { currentPage, totalPages } = pageInfo.value;
    const from = Math.max(1, currentPage - 2);
    const to = Math.min(totalPages, currentPage + 2);
    const out: number[] = [];
    for (let i = from; i <= to; i++) out.push(i);
    return out;
  }

  return {
    deployType,
    page,
    search,
    tasks,
    pageInfo,
    loading,
    error,
    refresh,
    setDeployType,
    applySearch,
    goPage,
    removeLocal,
    pageWindow,
  };
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tasks.test.ts 2>&1 | tail -8
```

预期：9 个测试全部 PASS

- [ ] **Step 5: 写任务列表视图**

替换 `src/views/TaskListView.vue`：

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useTasksStore } from "@/stores/tasks";
import StatusBadge from "@/components/common/StatusBadge.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const tasks = useTasksStore();
const searchDraft = ref(tasks.search);

onMounted(async () => {
  if (tasks.tasks.length === 0) await tasks.refresh();
});

const lastRefresh = ref("");
async function doRefresh(): Promise<void> {
  await tasks.refresh();
  lastRefresh.value = new Date().toLocaleTimeString("zh-CN");
}

const projectLabel = computed(() => (tasks.deployType === "auto" ? "自动化" : "Docker"));
</script>

<template>
  <div class="p-6 space-y-4">
    <div class="flex items-center gap-3 flex-wrap">
      <h1 class="text-base font-semibold">任务列表</h1>
      <div class="flex gap-1">
        <Button
          v-for="t in (['auto', 'docker'] as const)"
          :key="t"
          :variant="tasks.deployType === t ? 'default' : 'outline'"
          size="sm"
          @click="tasks.setDeployType(t)"
        >
          {{ t === "auto" ? "自动化" : "Docker" }}
        </Button>
      </div>
      <Input
        v-model="searchDraft"
        placeholder="搜索标题 / 项目 / 提交人…"
        class="w-64 h-8"
        @keyup.enter="tasks.applySearch(searchDraft)"
      />
      <Button variant="outline" size="sm" :disabled="tasks.loading" @click="doRefresh">
        {{ tasks.loading ? "刷新中…" : "刷新" }}
      </Button>
      <span v-if="lastRefresh" class="text-[11px] text-text-muted">
        {{ projectLabel }} · 最后刷新 {{ lastRefresh }}
      </span>
    </div>

    <p v-if="tasks.error" class="text-xs text-danger">{{ tasks.error }}</p>

    <div v-if="tasks.tasks.length === 0 && !tasks.loading" class="text-xs text-text-muted py-8 text-center">
      暂无数据，点「刷新」加载
    </div>

    <div v-else class="overflow-x-auto rounded-md border border-border">
      <table class="w-full text-xs border-collapse">
        <thead>
          <tr class="bg-surface-2 text-text-muted">
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">标题</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">项目</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">环境</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">分支</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">版本</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">上线状态</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">构建状态</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">提交人</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">时间</th>
            <th class="text-left font-medium px-3 py-2 whitespace-nowrap">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="t in tasks.tasks"
            :key="t.taskId"
            class="border-t border-border hover:bg-surface-2"
          >
            <td class="px-3 py-2 max-w-[220px] truncate" :title="t.title">{{ t.title }}</td>
            <td class="px-3 py-2 font-mono text-[11px] max-w-[180px] truncate" :title="t.projectName">
              {{ t.projectName }}
            </td>
            <td class="px-3 py-2 whitespace-nowrap">{{ t.envName }}</td>
            <td class="px-3 py-2 font-mono text-[11px] max-w-[160px] truncate" :title="t.branch">
              {{ t.branch }}
            </td>
            <td class="px-3 py-2 font-mono text-[11px]">{{ t.version.slice(0, 8) }}</td>
            <td class="px-3 py-2"><StatusBadge :text="t.onlineStatus" /></td>
            <td class="px-3 py-2"><StatusBadge :text="t.buildStatus" kind="build" /></td>
            <td class="px-3 py-2 whitespace-nowrap">{{ t.submitter }}</td>
            <td class="px-3 py-2 whitespace-nowrap text-text-muted">{{ t.submitTime.slice(5) }}</td>
            <td class="px-3 py-2">
              <!-- 行内操作在 Task 9 接上 -->
              <span class="text-text-muted">—</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="tasks.pageInfo.totalPages > 1" class="flex items-center gap-1 flex-wrap">
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasPrev"
        @click="tasks.goPage(1)"
      >
        首页
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasPrev"
        @click="tasks.goPage(tasks.pageInfo.currentPage - 1)"
      >
        «
      </Button>
      <Button
        v-for="p in tasks.pageWindow()"
        :key="p"
        :variant="p === tasks.pageInfo.currentPage ? 'default' : 'outline'"
        size="sm"
        class="min-w-8"
        @click="tasks.goPage(p)"
      >
        {{ p }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasNext"
        @click="tasks.goPage(tasks.pageInfo.currentPage + 1)"
      >
        »
      </Button>
      <Button
        variant="outline"
        size="sm"
        :disabled="!tasks.pageInfo.hasNext"
        @click="tasks.goPage(tasks.pageInfo.totalPages)"
      >
        尾页
      </Button>
      <span class="text-[11px] text-text-muted ml-2">
        共 {{ tasks.pageInfo.totalPages }} 页
      </span>
    </div>
  </div>
</template>
```

- [ ] **Step 6: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Tests "
npm run build 2>&1 | tail -4
```

- [ ] **Step 7: 手工验证**

```bash
npm run tauri dev
```

点左侧「任务列表」→ 出现真实任务表格；切自动化/Docker 应看到不同数据；搜索、翻页、刷新都正常。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: 任务列表（表格/分页/搜索/刷新）"
```

---

## Task 9: 行内操作（上线 / 回滚 / 删除）

**Files:**
- Modify: `src/views/TaskListView.vue`

- [ ] **Step 1: 接上行内操作**

在 `src/views/TaskListView.vue` 的 `<script setup>` 里追加：

```ts
import { submitOnline, submitRollback, deleteTask } from "@/api/deploy";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import type { DeployTask } from "@/api/parser";

type PendingAction = { kind: "online" | "rollback" | "delete"; task: DeployTask };

const pending = ref<PendingAction | null>(null);
const actionBusy = ref(false);
const flash = ref("");

const ACTION_TEXT: Record<PendingAction["kind"], { title: string; confirm: string; danger: boolean }> = {
  online: { title: "确认上线？", confirm: "上线", danger: false },
  rollback: { title: "确认回滚？", confirm: "回滚", danger: false },
  delete: { title: "确认删除？", confirm: "删除", danger: true },
};

function ask(kind: PendingAction["kind"], task: DeployTask): void {
  pending.value = { kind, task };
}

async function runAction(): Promise<void> {
  const p = pending.value;
  if (!p) return;
  actionBusy.value = true;
  try {
    const fn =
      p.kind === "online" ? submitOnline : p.kind === "rollback" ? submitRollback : deleteTask;
    const ok = await fn(tasks.deployType, p.task.taskId);
    if (!ok) {
      flash.value = "操作失败，请重试";
      return;
    }
    flash.value =
      p.kind === "online" ? "已触发上线" : p.kind === "rollback" ? "已触发回滚" : "已删除";
    if (p.kind === "delete") tasks.removeLocal(p.task.taskId);
    pending.value = null;
    await tasks.refresh();
  } catch (e) {
    flash.value = toUserMessage(e);
  } finally {
    actionBusy.value = false;
    setTimeout(() => (flash.value = ""), 3000);
  }
}
```

同时在文件顶部 import 区补上 `toUserMessage`：

```ts
import { toUserMessage } from "@/api/http";
```

- [ ] **Step 2: 替换操作列**

把表格里操作列的占位内容：

```vue
            <td class="px-3 py-2">
              <!-- 行内操作在 Task 9 接上 -->
              <span class="text-text-muted">—</span>
            </td>
```

替换为：

```vue
            <td class="px-3 py-2">
              <div class="flex items-center gap-1">
                <Button
                  v-if="t.canUp"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="ask('online', t)"
                >
                  上线
                </Button>
                <Button
                  v-if="t.canRoll"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="ask('rollback', t)"
                >
                  回滚
                </Button>
                <Button
                  v-if="t.canDelete"
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px] text-danger hover:text-danger"
                  @click="ask('delete', t)"
                >
                  删除
                </Button>
                <span v-if="!t.canUp && !t.canRoll && !t.canDelete" class="text-text-muted">—</span>
              </div>
            </td>
```

- [ ] **Step 3: 在模板末尾加确认框与提示**

在 `</div>`（最外层）之前追加：

```vue
    <ConfirmDialog
      :open="pending !== null"
      :title="pending ? ACTION_TEXT[pending.kind].title : ''"
      :description="pending ? `${pending.task.projectName} · ${pending.task.envName}` : ''"
      :confirm-text="pending ? ACTION_TEXT[pending.kind].confirm : '确认'"
      :danger="pending ? ACTION_TEXT[pending.kind].danger : false"
      :loading="actionBusy"
      @update:open="(v: boolean) => { if (!v) pending = null; }"
      @confirm="runAction"
    />

    <p v-if="flash" class="text-xs text-success">{{ flash }}</p>
```

- [ ] **Step 4: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run build 2>&1 | tail -4
```

- [ ] **Step 5: 手工验证**

```bash
npm run tauri dev
```

用一个构建已完成、且 `canUp` 为真（页面显示「上线」按钮）的任务试：
点「上线」→ 出确认框 → 确认后列表刷新，该行操作列变化。
删除用一个可删的任务试（**会真的删掉，注意挑无关紧要的**）。

- [ ] **Step 6: 提交**

```bash
git add -A
git commit -m "feat: 任务列表的行内操作（上线/回滚/删除）与确认框"
```

---

## Task 10: 自动轮询

**Files:**
- Modify: `src/stores/tasks.ts`
- Modify: `src/views/TaskListView.vue`
- Modify: `src/stores/tasks.test.ts`（补轮询测试）

- [ ] **Step 1: 写失败的测试**

在 `src/stores/tasks.test.ts` 末尾追加（放在最外层 `describe` 内）：

```ts
  describe("轮询", () => {
    it("startPolling 到点会刷新", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();

      s.startPolling(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(2);

      s.stopPolling();
      vi.useRealTimers();
    });

    it("stopPolling 之后不再刷新", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      s.startPolling(1000);
      s.stopPolling();
      await vi.advanceTimersByTimeAsync(5000);
      expect(deployApi.fetchTaskList).not.toHaveBeenCalled();
      vi.useRealTimers();
    });

    it("重复 startPolling 不会叠加多个定时器", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockResolvedValue(PAGE);
      const s = useTasksStore();
      s.startPolling(1000);
      s.startPolling(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(deployApi.fetchTaskList).toHaveBeenCalledTimes(1);
      s.stopPolling();
      vi.useRealTimers();
    });

    it("连续失败 3 次后自动停止轮询（避免离线时一直打服务端）", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList).mockRejectedValue({ kind: "network", message: "down" });
      const s = useTasksStore();
      s.startPolling(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      const callsAfterThree = vi.mocked(deployApi.fetchTaskList).mock.calls.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(vi.mocked(deployApi.fetchTaskList).mock.calls.length).toBe(callsAfterThree);
      expect(s.offline).toBe(true);
      s.stopPolling();
      vi.useRealTimers();
    });

    it("成功后清零失败计数", async () => {
      vi.useFakeTimers();
      vi.mocked(deployApi.fetchTaskList)
        .mockRejectedValueOnce({ kind: "network", message: "x" })
        .mockResolvedValue(PAGE)
        .mockRejectedValueOnce({ kind: "network", message: "x" });
      const s = useTasksStore();
      s.startPolling(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.offline).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.offline).toBe(false);
      s.stopPolling();
      vi.useRealTimers();
    });
  });
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tasks.test.ts 2>&1 | tail -6
```

预期：FAIL，`s.startPolling is not a function`

- [ ] **Step 3: 实现轮询**

在 `src/stores/tasks.ts` 里追加状态与函数：

```ts
  const offline = ref(false);
  const pollIntervalSecs = ref(60);
  let timer: ReturnType<typeof setInterval> | undefined;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 3;
```

`refresh()` 改为在成功/失败时维护计数（替换原来的 `refresh`）：

```ts
  async function refresh(): Promise<void> {
    loading.value = true;
    error.value = "";
    try {
      const r = await fetchTaskList(deployType.value, page.value, search.value);
      tasks.value = r.tasks;
      pageInfo.value = r.pageInfo;
      consecutiveFailures = 0;
      offline.value = false;
    } catch (e) {
      error.value = toUserMessage(e);
      consecutiveFailures += 1;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        offline.value = true;
        // 离线时停掉轮询，避免一直无效打服务端；恢复由用户手动刷新触发
        stopPolling();
      }
    } finally {
      loading.value = false;
    }
  }

  /** 启动轮询。重复调用不会叠加定时器 */
  function startPolling(intervalSecs: number): void {
    pollIntervalSecs.value = intervalSecs;
    stopPolling();
    timer = setInterval(() => {
      void refresh();
    }, intervalSecs * 1000);
  }

  function stopPolling(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }
```

并把 `startPolling` / `stopPolling` / `offline` / `pollIntervalSecs` 加进 `return { ... }`。

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/stores/tasks.test.ts 2>&1 | tail -10
```

预期：14 个测试全部 PASS

> 注意：`stopPolling` 在 `refresh` 之前定义会被提升（函数声明），但 `timer` 是 `let`
> 声明在模块作用域内、`defineStore` 回调里——确保 `timer` 的声明在 `refresh` 之前，
> 否则运行时报 TDZ 错误。

- [ ] **Step 5: 让视图管理轮询生命周期**

在 `src/views/TaskListView.vue` 的 `<script setup>` 中：

**(a)** 把顶部已有的 vue import 扩展为（不要另起一行 import，保持 import 都在文件顶部）：

```ts
import { computed, onMounted, ref, watch } from "vue";
```

**(b)** 在 import 区追加：

```ts
import { useSettingsStore } from "@/stores/settings";
import { useTabsStore } from "@/stores/tabs";
```

**(c)** 在 `const tasks = useTasksStore();` 之后追加：

```ts
const settings = useSettingsStore();
const tabs = useTabsStore();

/** 只有"当前激活的标签就是任务列表"时才轮询，切走就停 */
function syncPolling(): void {
  const active = tabs.activeTab?.kind === "list";
  if (active) tasks.startPolling(settings.pollIntervalSecs);
  else tasks.stopPolling();
}

onMounted(syncPolling);
// TabHost 用 v-show 隐藏非激活标签，不会触发 activated/deactivated，
// 因此还要直接监听 activeId 的变化
watch(() => tabs.activeId, syncPolling);
```

> 不需要 onActivated / onDeactivated：TabHost 用的是 v-show 而非 `<KeepAlive>`，
> 组件不会被 deactivate，监听 activeId 才是有效手段。

并在模板顶部加离线提示：

```vue
    <p v-if="tasks.offline" class="text-xs text-warning">
      连续多次请求失败，已停止自动刷新。请检查内网连接后点「刷新」重试。
    </p>
```

- [ ] **Step 6: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Tests "
npm run build 2>&1 | tail -4
```

- [ ] **Step 7: 手工验证**

```bash
npm run tauri dev
```

打开任务列表标签，等 60 秒（或在设置页把轮询间隔改成 10 秒）→ 应看到表格自动更新、「最后刷新」时间变化。
切到别的标签 → 轮询应停止（可在控制台看请求次数）。

- [ ] **Step 8: 提交**

```bash
git add -A
git commit -m "feat: 任务列表自动轮询（切标签暂停、连续失败 3 次转离线）"
```

---

## Task 11: 收藏页与快速部署

**Files:**
- Modify: `src/views/FavoritesView.vue`

- [ ] **Step 1: 写收藏页**

替换 `src/views/FavoritesView.vue`：

```vue
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchBranches, fetchCommits, submitDeploy } from "@/api/deploy";
import { toUserMessage } from "@/api/http";
import { useFavoritesStore } from "@/stores/favorites";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";

const favorites = useFavoritesStore();
const tasks = useTasksStore();
const tabs = useTabsStore();

const expandedId = ref<string | null>(null);
/** 每个展开项的临时状态：分支列表 / commit 列表 / 选择 / 加载 / 错误 */
const drafts = ref<
  Record<
    string,
    {
      branches: string[];
      commits: { hash: string; message: string; fullString: string }[];
      branch: string;
      commit: string;
      loadingBranches: boolean;
      loadingCommits: boolean;
      submitting: boolean;
      error: string;
    }
  >
>({});

const pendingDelete = ref<string | null>(null);

function draft(id: string) {
  if (!drafts.value[id]) {
    drafts.value[id] = {
      branches: [],
      commits: [],
      branch: "",
      commit: "",
      loadingBranches: false,
      loadingCommits: false,
      submitting: false,
      error: "",
    };
  }
  return drafts.value[id];
}

const deleteTarget = computed(() =>
  pendingDelete.value ? favorites.items.find((f) => f.id === pendingDelete.value) : undefined,
);

onMounted(async () => {
  if (!favorites.loaded) await favorites.load();
});

async function toggle(id: string): Promise<void> {
  if (expandedId.value === id) {
    expandedId.value = null;
    return;
  }
  expandedId.value = id;
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  d.error = "";
  if (fav.branch) {
    d.branch = fav.branch;
    await loadCommits(id);
  } else {
    await loadBranches(id);
  }
}

async function loadBranches(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  d.loadingBranches = true;
  d.error = "";
  try {
    d.branches = await fetchBranches(fav.deployType, fav.projectId);
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.loadingBranches = false;
  }
}

async function loadCommits(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  if (!d.branch) return;
  d.loadingCommits = true;
  d.error = "";
  try {
    d.commits = await fetchCommits(fav.projectName, d.branch);
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.loadingCommits = false;
  }
}

async function pickBranch(id: string, branch: string): Promise<void> {
  const d = draft(id);
  d.branch = branch;
  d.commit = "";
  d.commits = [];
  if (branch) await loadCommits(id);
}

async function quickDeploy(id: string): Promise<void> {
  const fav = favorites.items.find((f) => f.id === id);
  if (!fav) return;
  const d = draft(id);
  if (!d.branch || !d.commit) return;
  d.submitting = true;
  d.error = "";
  try {
    const ok = await submitDeploy(fav.deployType, fav.projectId, {
      title: "",
      branchtag: d.branch,
      version: d.commit,
    });
    if (!ok) {
      d.error = "提交失败，请重试";
      return;
    }
    // 与向导保持一致：切到对应类型的任务列表
    tasks.deployType = fav.deployType;
    tasks.page = 1;
    tabs.open({ kind: "list" });
    expandedId.value = null;
  } catch (e) {
    d.error = toUserMessage(e);
  } finally {
    d.submitting = false;
  }
}

async function confirmDelete(): Promise<void> {
  if (!pendingDelete.value) return;
  await favorites.remove(pendingDelete.value);
  if (expandedId.value === pendingDelete.value) expandedId.value = null;
  pendingDelete.value = null;
}
</script>

<template>
  <div class="p-6 space-y-4">
    <h1 class="text-base font-semibold">收藏</h1>

    <div v-if="favorites.items.length === 0" class="text-xs text-text-muted py-8 text-center">
      暂无收藏。在「新建部署」里选好项目后点「保存为收藏」。
    </div>

    <div v-else class="space-y-2">
      <div
        v-for="f in favorites.items"
        :key="f.id"
        :class="[
          'rounded-md border bg-surface overflow-hidden',
          expandedId === f.id ? 'border-primary' : 'border-border',
        ]"
      >
        <div class="flex items-center gap-3 px-4 py-3">
          <div class="flex-1 min-w-0">
            <div class="text-sm truncate">{{ f.projectName }}</div>
            <div class="text-[11px] text-text-muted truncate">
              {{ f.envName }} · {{ f.deployType === "auto" ? "自动化" : "Docker" }}
              <template v-if="f.branch"> · {{ f.branch }}</template>
            </div>
          </div>
          <Button size="sm" variant="outline" @click="toggle(f.id)">
            {{ expandedId === f.id ? "收起" : "快速部署" }}
          </Button>
          <Button
            size="sm"
            variant="outline"
            class="text-danger hover:text-danger"
            @click="pendingDelete = f.id"
          >
            删除
          </Button>
        </div>

        <div v-if="expandedId === f.id" class="border-t border-border bg-surface-2 px-4 py-3 space-y-3">
          <div v-if="!f.branch" class="space-y-1.5">
            <div class="text-[11px] text-text-muted">
              分支{{ draft(f.id).loadingBranches ? "（加载中…）" : "" }}
            </div>
            <div class="flex flex-wrap gap-1.5">
              <Button
                v-for="b in draft(f.id).branches"
                :key="b"
                size="sm"
                :variant="draft(f.id).branch === b ? 'default' : 'secondary'"
                class="text-[11px] font-mono h-6 px-2"
                @click="pickBranch(f.id, b)"
              >
                {{ b }}
              </Button>
            </div>
          </div>

          <div v-if="draft(f.id).branch" class="space-y-1.5">
            <div class="text-[11px] text-text-muted">
              Commit{{ draft(f.id).loadingCommits ? "（加载中…）" : "" }}
            </div>
            <select
              v-model="draft(f.id).commit"
              class="w-full h-8 rounded-md border border-border bg-surface px-2 text-[11px] font-mono"
            >
              <option value="">-- 选择 Commit --</option>
              <option v-for="c in draft(f.id).commits" :key="c.fullString" :value="c.fullString">
                {{ c.hash.slice(0, 8) }} {{ c.message }}
              </option>
            </select>
          </div>

          <p v-if="draft(f.id).error" class="text-[11px] text-danger">
            {{ draft(f.id).error }}
          </p>

          <Button
            size="sm"
            :disabled="!draft(f.id).branch || !draft(f.id).commit || draft(f.id).submitting"
            @click="quickDeploy(f.id)"
          >
            {{ draft(f.id).submitting ? "提交中…" : "提交部署" }}
          </Button>
        </div>
      </div>
    </div>

    <ConfirmDialog
      :open="pendingDelete !== null"
      title="确认删除收藏？"
      :description="deleteTarget ? deleteTarget.projectName : ''"
      confirm-text="删除"
      danger
      @update:open="(v: boolean) => { if (!v) pendingDelete = null; }"
      @confirm="confirmDelete"
    />
  </div>
</template>
```

- [ ] **Step 2: 让收藏 store 在应用启动时就加载**

在 `src/App.vue` 的 `onMounted` 里追加：

```ts
  await useFavoritesStore().load();
  useFavoritesStore().refreshEnvNames(ENVS);
```

并在 import 区加入：

```ts
import { useFavoritesStore } from "./stores/favorites";
import { ENVS } from "./api/deploy";
```

- [ ] **Step 3: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Tests "
npm run build 2>&1 | tail -4
```

- [ ] **Step 4: 手工验证**

```bash
npm run tauri dev
```

先在向导里保存一个收藏 → 切到「收藏」标签 → 点「快速部署」→ 选分支 → 选 Commit → 提交 →
应自动跳到任务列表并看到新任务。删除收藏也应生效。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat: 收藏页与快速部署"
```

---

## Task 12: 里程碑验证

**Files:** 无新增

- [ ] **Step 1: 全量测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
echo "--- 前端 ---"
npm test 2>&1 | grep -E "Test Files|Tests "
echo "--- Rust ---"
cd src-tauri && cargo test 2>&1 | grep -E "^test result"
cd .. && echo "--- 类型检查 ---" && npx vue-tsc --noEmit && echo "无类型错误 ✓"
```

预期：
- 前端：47（Plan 1）+ parser 10 + favorites 7 + deploy 20 + tasks 14 ≈ **98 passed**
- Rust：56（Plan 1）+ favorites 9 = **65 passed**，另 2 个 ignored（钥匙串探测、真实环境 e2e）
- `vue-tsc --noEmit` 无类型错误

- [ ] **Step 2: 与插件功能逐项对照**

| 能力 | 插件 | 桌面端 | 验证方式 |
|---|---|---|---|
| 登录 / 会话维持 | ✅ | ✅ | Plan 1 已验证 |
| 自动化部署建单 | ✅ | ⬜ | 手工走一遍 |
| Docker 部署建单 | ✅ | ⬜ | 手工走一遍 |
| 项目搜索 | ✅ | ⬜ | 向导里输入关键字 |
| Commit 列表 | ✅ | ⬜ | 选分支后出现下拉 |
| 任务列表（分页/搜索） | ✅ | ⬜ | 切页、搜索 |
| 上线 / 回滚 / 删除 | ✅ | ⬜ | 各点一次（删除挑无关任务） |
| 收藏（项目级 / 配置级） | ✅ | ⬜ | 保存、快速部署、删除 |
| 自动刷新 | ✅ 60s | ⬜ | 等一个周期 |
| 构建日志 | ✅ | ❌ | **Plan 3** |

逐项打勾，任一项不通过就先修再继续。

- [ ] **Step 3: release 构建**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri build -- --no-bundle 2>&1 | tail -4
```

预期：构建通过。

- [ ] **Step 4: 提交里程碑**

```bash
git add -A
git commit -m "chore: Plan 2 里程碑验证通过（功能与 VSCode 插件 1:1 对齐）" --allow-empty
git log --oneline | head -15
```

---

## Plan 2 完成标准

- [ ] 前端测试全绿（含 parser 的 fixture 快照测试）
- [ ] Rust 测试全绿（含 favorites 的 9 个）
- [ ] `vue-tsc --noEmit` 无类型错误
- [ ] release 构建通过
- [ ] 自动化部署与 Docker 部署各成功建单一次
- [ ] 任务列表能翻页、搜索、上线、回滚、删除
- [ ] 收藏可保存、快速部署、删除
- [ ] 自动刷新生效且切标签会暂停
- [ ] 与插件功能对照表全部打勾（构建日志除外，属 Plan 3）

**下一计划：** Plan 3（P4 构建日志）——Rust WebSocket + 日志标签页 + ANSI 处理 + 进度行原地更新。
