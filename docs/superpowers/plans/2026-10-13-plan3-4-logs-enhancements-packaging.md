# Plan 3+4：构建日志 · 客户端增强 · 打包分发

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补上插件的最后一块功能（WebSocket 实时构建日志），然后把桌面客户端特有的体验做完（托盘、通知、日志留存、快捷键），最后产出可分发安装包。

**Architecture:** Rust 侧新增 WebSocket 能力（`tokio-tungstenite`，握手带 Cookie 头——浏览器的 WebSocket API 做不到这点，这是它必须放在 Rust 的原因）。日志以**事件流**推给前端而非 invoke 返回，前端按 `session_id` 分发到对应日志标签页。托盘/通知用 Tauri 2 内置能力与官方插件。

**Tech Stack:** 新增 `tokio-tungstenite`、`tauri-plugin-notification`；前端复用现有栈

**依据 spec:** `docs/superpowers/specs/2026-10-13-zz-deploy-desktop-design.md`（覆盖 P4 + P6 + P7）

---

## 前置条件

Plan 1、Plan 2 已完成。当前状态：前端 127 测试 / Rust 75 测试全绿，功能与 VSCode 插件对齐（构建日志除外）。

---

## 与 spec 的一处偏离（有意）

spec §6.3 说日志留存文件是「纯文本，ANSI 已剥离」。

**实际做法：留存的原始 chunk 不剥离 ANSI，在显示时剥离。**

理由：留存是**原始记录**，剥离是不可逆的。将来若要给日志加颜色渲染、或做关键词高亮，原始数据还在。剥离开销转移到读取端，而读取端的剥离开销本来就要付（实时日志也需要）。

历史日志页复用同一个前端剥离函数，用户看不到差别。

---

## 文件结构

```
src-tauri/src/
├── ws/
│   ├── mod.rs
│   └── log_socket.rs          单条日志连接的完整生命周期（可独立单测）
├── logs/
│   ├── mod.rs
│   └── store.rs               日志落盘、索引、保留策略
└── commands/
    ├── log.rs                 log_open / log_close
    ├── history.rs             history_list / history_read / history_delete
    └── notify.rs              当前任务列表快照（供前端 diff 出状态变化）

src/
├── api/log.ts                 log_open / log_close 的 invoke 封装
├── api/history.ts             history_* 封装
├── stores/logs.ts             日志会话与缓冲
├── stores/history.ts
├── lib/ansi.ts                ANSI 剥离 + 按行切分 + 进度行合并（纯函数，重点单测）
├── views/LogView.vue          日志标签页
├── views/HistoryView.vue      历史日志
└── composables/useShortcuts.ts
```

---

## Task 1: Rust —— 日志 WebSocket 客户端

**Files:**
- Create: `src-tauri/src/ws/mod.rs`、`src-tauri/src/ws/log_socket.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: 依赖**

```toml
# src-tauri/Cargo.toml [dependencies]
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-native-roots"] }
futures-util = "0.3"
```

`rustls-tls-native-roots` 而非 `native-tls`：避免平台 OpenSSL 差异，三端行为一致。
`futures-util` 用于 `StreamExt` / `SinkExt`。

- [ ] **Step 2: 写失败的测试**

创建 `src-tauri/src/ws/log_socket.rs`，先只写测试。测试用一个**本地 WS 服务端**（`tokio_tungstenite::accept_async`），不需要额外依赖：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tokio::net::TcpListener;

    /// 起一个本地 WS 服务端，按脚本逐条推送消息。
    /// 返回 (ws_url, 收到的客户端首帧)
    async fn spawn_ws_server(
        messages: Vec<&'static str>,
    ) -> (String, Arc<tokio::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let received = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let received_clone = received.clone();

        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();

            // 先收客户端发来的认证帧
            use futures_util::StreamExt;
            if let Some(Ok(msg)) = ws.next().await {
                received_clone.lock().await.push(msg.to_string());
            }

            use futures_util::SinkExt;
            for m in messages {
                if ws.send(tokio_tungstenite::tungstenite::Message::text(m)).await.is_err() {
                    break;
                }
            }
            // 推完就保持连接，等客户端自己关
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        });

        (format!("ws://{addr}/wssapp/"), received)
    }

    #[tokio::test]
    async fn sends_auth_frame_then_forwards_build_log() {
        let (url, received) =
            spawn_ws_server(vec![r#"{"build_log":"hello\n"}"#, r#"{"build_log":"world\n"}"#]).await;

        let chunks = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let c = chunks.clone();
        let finished = Arc::new(AtomicUsize::new(0));
        let f = finished.clone();

        connect_and_stream(
            &url,
            "sessionid=abc",
            42,
            "auto",
            move |chunk| {
                let c = c.clone();
                // 回调是同步的，用 try_lock 收集即可（测试里不会争用）
                c.try_lock().unwrap().push(chunk);
            },
            move |state| {
                if state == LogEnd::Finished {
                    f.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await
        .unwrap();

        // 认证帧：拼写必须与服务端原值一致（delpoyment 是服务端的拼写错误）
        let sent = received.lock().await;
        assert_eq!(sent.len(), 1, "应先发一帧认证消息");
        let v: serde_json::Value = serde_json::from_str(&sent[0]).unwrap();
        assert_eq!(v["sock_type"], "BuildLog");
        assert_eq!(v["session_key"], "abc");
        assert_eq!(v["id"], "42");
        assert_eq!(v["submittype"], "delpoyment");

        let got = chunks.lock().await;
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], "hello\n");
        // 连接自然结束后应报一次 Finished
        assert_eq!(finished.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn docker_uses_service_typo_submittype() {
        let (url, received) = spawn_ws_server(vec![r#"{"code":1}"#]).await;
        connect_and_stream(&url, "s=1", 7, "docker", |_| {}, |_| {}).await.unwrap();
        let sent = received.lock().await;
        let v: serde_json::Value = serde_json::from_str(&sent[0]).unwrap();
        // 服务端的原始拼写错误，必须原样保持
        assert_eq!(v["submittype"], "dockerdelpoy");
    }

    #[tokio::test]
    async fn code_1_means_finished() {
        let (url, _) = spawn_ws_server(vec![r#"{"build_log":"x"}"#, r#"{"code":1}"#]).await;
        let finished = Arc::new(AtomicUsize::new(0));
        let f = finished.clone();
        connect_and_stream(&url, "s=1", 1, "auto", |_| {}, move |st| {
            if st == LogEnd::Finished {
                f.fetch_add(1, Ordering::SeqCst);
            }
        })
        .await
        .unwrap();
        assert_eq!(finished.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ignores_non_json_messages() {
        let (url, _) = spawn_ws_server(vec!["not json at all", r#"{"build_log":"ok"}"#]).await;
        let chunks = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let c = chunks.clone();
        connect_and_stream(&url, "s=1", 1, "auto", move |ch| {
            c.try_lock().unwrap().push(ch);
        }, |_| {})
        .await
        .unwrap();
        assert_eq!(chunks.lock().await.len(), 1, "非 JSON 帧应被忽略而不是中断流");
    }

    #[tokio::test]
    async fn connect_failure_returns_error() {
        // 端口没人监听
        let err = connect_and_stream("ws://127.0.0.1:1/wssapp/", "s=1", 1, "auto", |_| {}, |_| {})
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Network);
    }
}
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib log_socket 2>&1 | grep -E "^error" | head -3
```

预期：找不到 `connect_and_stream`、`LogEnd`

- [ ] **Step 4: 实现**

在测试模块**之前**插入：

```rust
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;

use crate::error::AppError;

/// 日志流结束的原因
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LogEnd {
    /// 服务端发来 code=1，日志已写完，不要再重连
    Finished,
    /// 连接异常断开
    Disconnected,
}

/// 连接日志 WebSocket 并把内容推给回调，直到流结束或出错。
///
/// 为什么必须放在 Rust：握手要带 `Cookie` 头，而浏览器的 WebSocket API
/// 不允许设置自定义请求头。
///
/// `submittype` 的拼写（`delpoyment` / `dockerdelpoy`）是**服务端原始值**，
/// 含拼写错误也必须照发，否则服务端认不出。对应插件 `src/ws/logSocket.ts:52`。
pub async fn connect_and_stream<F, G>(
    url: &str,
    cookie: &str,
    task_id: i64,
    deploy_type: &str,
    mut on_chunk: F,
    mut on_end: G,
) -> Result<(), AppError>
where
    F: FnMut(String),
    G: FnMut(LogEnd),
{
    let mut req = url
        .into_client_request()
        .map_err(|e| AppError::config(format!("WebSocket URL 非法：{e}")))?;
    req.headers_mut().insert(
        "Cookie",
        HeaderValue::from_str(cookie)
            .map_err(|e| AppError::config(format!("Cookie 头非法：{e}")))?,
    );
    // 与服务端同源，部分网关会校验
    req.headers_mut()
        .insert("Origin", HeaderValue::from_str(origin_of(url).as_str()).unwrap_or(HeaderValue::from_static("")));

    let (mut ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| AppError::network(format!("连接日志服务失败：{e}")))?;

    // 认证帧
    let session_key = cookie
        .split(';')
        .find_map(|p| p.trim().strip_prefix("sessionid="))
        .unwrap_or("")
        .to_string();
    let submittype = if deploy_type == "docker" {
        "dockerdelpoy"
    } else {
        "delpoyment"
    };
    let auth = serde_json::json!({
        "sock_type": "BuildLog",
        "session_key": session_key,
        "id": task_id.to_string(),
        "submittype": submittype,
    })
    .to_string();
    ws.send(Message::text(auth))
        .await
        .map_err(|e| AppError::network(format!("发送日志认证帧失败：{e}")))?;

    while let Some(msg) = ws.next().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                on_end(LogEnd::Disconnected);
                return Err(AppError::network(format!("日志连接中断：{e}")));
            }
        };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        // 非 JSON 帧忽略而不是中断——服务端偶尔会发保活之类的裸内容
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if let Some(log) = v.get("build_log").and_then(|x| x.as_str()) {
            on_chunk(log.to_string());
        }
        if v.get("code").and_then(|x| x.as_i64()) == Some(1) {
            on_end(LogEnd::Finished);
            let _ = ws.close(None).await;
            return Ok(());
        }
    }

    on_end(LogEnd::Disconnected);
    Ok(())
}

/// 从 wss://host/path 里取出 https://host 作为 Origin
fn origin_of(url: &str) -> String {
    let rest = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .unwrap_or(url);
    let host = rest.split('/').next().unwrap_or("");
    format!("https://{host}")
}

/// 重连策略：指数退避，最多 3 次（与插件一致）
pub fn backoff_delay(attempt: u32) -> Duration {
    Duration::from_millis(3000 * 2u64.pow(attempt.min(3)) as u64)
}
```

- [ ] **Step 5: 声明模块**

`src-tauri/src/ws/mod.rs`：

```rust
pub mod log_socket;
```

`src-tauri/src/lib.rs` 加 `pub mod ws;`

- [ ] **Step 6: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib log_socket 2>&1 | tail -12
```

预期：5 个测试 PASS

- [ ] **Step 7: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A && git commit -m "feat(rust): 构建日志 WebSocket 客户端（含本地 WS 服务端的单测）"
```

---

## Task 2: Rust —— 日志会话管理、事件推送与落盘

**Files:**
- Create: `src-tauri/src/commands/log.rs`
- Create: `src-tauri/src/logs/mod.rs`、`src-tauri/src/logs/store.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 写失败的测试**

创建 `src-tauri/src/logs/store.rs`，先只写测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(dir: &TempDir) -> LogStore {
        LogStore::new(dir.path().join("logs"))
    }

    #[test]
    fn append_creates_file_and_returns_size() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.append("auto", 42, "line1\n").unwrap();
        s.append("auto", 42, "line2\n").unwrap();
        let text = s.read("auto", 42).unwrap();
        assert_eq!(text, "line1\nline2\n");
    }

    #[test]
    fn keeps_deploy_types_separate() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.append("auto", 1, "A").unwrap();
        s.append("docker", 1, "D").unwrap();
        assert_eq!(s.read("auto", 1).unwrap(), "A");
        assert_eq!(s.read("docker", 1).unwrap(), "D");
    }

    #[test]
    fn read_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(store(&dir).read("auto", 999).unwrap().is_none());
    }

    #[test]
    fn index_records_metadata() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.note_open("auto", 42, "zz-cy-iptv", "测试环境").unwrap();
        s.append("auto", 42, "x").unwrap();
        let list = s.list().unwrap();
        let e = list.iter().find(|e| e.task_id == 42).unwrap();
        assert_eq!(e.project_name, "zz-cy-iptv");
        assert_eq!(e.env_name, "测试环境");
        assert!(e.size > 0);
    }

    #[test]
    fn index_survives_reload() {
        let dir = TempDir::new().unwrap();
        {
            let s = store(&dir);
            s.note_open("auto", 7, "p", "e").unwrap();
        }
        // 新实例应能读到之前的索引
        let s2 = store(&dir);
        assert!(s2.list().unwrap().iter().any(|e| e.task_id == 7));
    }

    #[test]
    fn retention_drops_entries_beyond_max_count() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..5 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
        }
        // 只留最近 3 条
        let removed = s.apply_retention(&Retention { max_days: 3650, max_entries: 3 }).unwrap();
        assert_eq!(removed, 2);
        assert_eq!(s.list().unwrap().len(), 3);
    }

    #[test]
    fn retention_keeps_newest_entries() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..5 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
            // 拉开时间戳，保证"最新"可判定
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        s.apply_retention(&Retention { max_days: 3650, max_entries: 2 }).unwrap();
        let ids: Vec<i64> = s.list().unwrap().iter().map(|e| e.task_id).collect();
        assert!(ids.contains(&4), "应保留最新的 task 4，实际 {ids:?}");
        assert!(ids.contains(&3));
    }

    #[test]
    fn retention_removes_log_file_too() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..3 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
        }
        s.apply_retention(&Retention { max_days: 3650, max_entries: 1 }).unwrap();
        // 被淘汰的日志正文文件也应删除，否则磁盘会一直涨
        let remaining = s.list().unwrap();
        assert_eq!(remaining.len(), 1);
        let kept = remaining[0].task_id;
        assert!(s.read("auto", kept).unwrap().is_some());
        let files = std::fs::read_dir(dir.path().join("logs").join("auto")).unwrap().count();
        assert_eq!(files, 1, "目录里应只剩 1 个日志文件");
    }

    #[test]
    fn delete_removes_entry_and_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.note_open("auto", 5, "p", "e").unwrap();
        s.append("auto", 5, "x").unwrap();
        s.delete("auto", 5).unwrap();
        assert!(s.list().unwrap().is_empty());
        assert!(s.read("auto", 5).unwrap().is_none());
    }

    #[test]
    fn index_with_corrupt_json_is_treated_as_empty_not_fatal() {
        // 索引文件损坏不应该让整个功能不可用
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("logs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.json"), b"{ not json").unwrap();
        let s = LogStore::new(root);
        assert!(s.list().unwrap().is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib logs:: 2>&1 | grep -E "^error" | head -3
```

预期：找不到 `LogStore`

- [ ] **Step 3: 实现**

在测试模块**之前**插入：

```rust
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub task_id: i64,
    /// "auto" | "docker"
    pub deploy_type: String,
    pub project_name: String,
    pub env_name: String,
    /// 首次订阅的毫秒时间戳
    pub started_at: u128,
    pub size: u64,
}

/// 保留策略。默认 30 天 / 500 条（spec §6.3）
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub max_days: u64,
    pub max_entries: usize,
}

impl Default for Retention {
    fn default() -> Self {
        Self { max_days: 30, max_entries: 500 }
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 日志落盘 + 索引 + 保留策略。
///
/// 目录布局：
///   <root>/index.json               元数据索引
///   <root>/<deployType>/<taskId>.log 日志正文（原始 chunk，未剥离 ANSI）
pub struct LogStore {
    root: PathBuf,
}

impl LogStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn file_path(&self, deploy_type: &str, task_id: i64) -> PathBuf {
        self.root.join(deploy_type).join(format!("{task_id}.log"))
    }

    /// 索引损坏时返回空表而不是报错——日志留存是辅助功能，
    /// 不该因为一个坏掉的 json 让整个应用不可用。
    fn load_index(&self) -> BTreeMap<String, HistoryEntry> {
        std::fs::read(self.index_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, HistoryEntry>>(&b).ok())
            .unwrap_or_default()
    }

    fn save_index(&self, idx: &BTreeMap<String, HistoryEntry>) -> Result<(), AppError> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| AppError::io(format!("创建日志目录失败：{e}")))?;
        let body = serde_json::to_vec_pretty(idx)
            .map_err(|e| AppError::io(format!("序列化日志索引失败：{e}")))?;
        std::fs::write(self.index_path(), body)
            .map_err(|e| AppError::io(format!("写入日志索引失败：{e}")))
    }

    fn key(deploy_type: &str, task_id: i64) -> String {
        format!("{deploy_type}_{task_id}")
    }

    /// 记录"用户主动打开了这条日志"。只有被打开过的任务才会留存，
    /// 避免把全站日志都拉下来（spec §6.3）。
    pub fn note_open(
        &self,
        deploy_type: &str,
        task_id: i64,
        project_name: &str,
        env_name: &str,
    ) -> Result<(), AppError> {
        let mut idx = self.load_index();
        let k = Self::key(deploy_type, task_id);
        idx.entry(k)
            .and_modify(|e| {
                e.project_name = project_name.to_string();
                e.env_name = env_name.to_string();
            })
            .or_insert_with(|| HistoryEntry {
                task_id,
                deploy_type: deploy_type.to_string(),
                project_name: project_name.to_string(),
                env_name: env_name.to_string(),
                started_at: now_ms(),
                size: 0,
            });
        self.save_index(&idx)
    }

    /// 追加日志块（原始内容，不剥离 ANSI）
    pub fn append(&self, deploy_type: &str, task_id: i64, chunk: &str) -> Result<(), AppError> {
        use std::io::Write;
        let path = self.file_path(deploy_type, task_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建日志目录失败：{e}")))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| AppError::io(format!("打开日志文件失败：{e}")))?;
        f.write_all(chunk.as_bytes())
            .map_err(|e| AppError::io(format!("写入日志失败：{e}")))?;

        let mut idx = self.load_index();
        let k = Self::key(deploy_type, task_id);
        if let Some(e) = idx.get_mut(&k) {
            e.size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(e.size);
        }
        self.save_index(&idx)
    }

    pub fn read(&self, deploy_type: &str, task_id: i64) -> Result<Option<String>, AppError> {
        match std::fs::read_to_string(self.file_path(deploy_type, task_id)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::io(format!("读取日志失败：{e}"))),
        }
    }

    /// 按开始时间倒序返回（最新的在前）
    pub fn list(&self) -> Result<Vec<HistoryEntry>, AppError> {
        let mut v: Vec<HistoryEntry> = self.load_index().into_values().collect();
        v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(v)
    }

    pub fn delete(&self, deploy_type: &str, task_id: i64) -> Result<(), AppError> {
        let _ = std::fs::remove_file(self.file_path(deploy_type, task_id));
        let mut idx = self.load_index();
        idx.remove(&Self::key(deploy_type, task_id));
        self.save_index(&idx)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        for e in self.list()? {
            let _ = std::fs::remove_file(self.file_path(&e.deploy_type, e.task_id));
        }
        let empty: BTreeMap<String, HistoryEntry> = BTreeMap::new();
        self.save_index(&empty)
    }

    /// 应用保留策略，返回被淘汰的条数。
    /// **同时删除日志正文文件**，否则索引清了但磁盘还在涨。
    pub fn apply_retention(&self, r: &Retention) -> Result<usize, AppError> {
        let mut all = self.list()?; // 已是"最新在前"
        let cutoff = now_ms().saturating_sub(r.max_days as u128 * 24 * 3600 * 1000);

        let mut keep = Vec::new();
        let mut drop = Vec::new();
        for (i, e) in all.drain(..).enumerate() {
            if i < r.max_entries && e.started_at >= cutoff {
                keep.push(e);
            } else {
                drop.push(e);
            }
        }

        for e in &drop {
            let _ = std::fs::remove_file(self.file_path(&e.deploy_type, e.task_id));
        }
        let idx: BTreeMap<String, HistoryEntry> = keep
            .into_iter()
            .map(|e| (Self::key(&e.deploy_type, e.task_id), e))
            .collect();
        self.save_index(&idx)?;
        Ok(drop.len())
    }

    /// 全部日志占用的字节数，供设置页展示
    pub fn total_size(&self) -> Result<u64, AppError> {
        Ok(self.list()?.iter().map(|e| e.size).sum())
    }
}

/// 供测试与调用方拼路径用
pub fn logs_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test --lib logs:: 2>&1 | tail -14
```

预期：10 个测试 PASS

- [ ] **Step 5: 写会话管理命令**

创建 `src-tauri/src/commands/log.rs`：

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::error::AppError;
use crate::logs::store::LogStore;
use crate::session::SessionState;
use crate::ws::log_socket::{connect_and_stream, LogEnd};

/// 一条日志会话（一个打开的日志标签页对应一条）
pub struct LogSession {
    pub task_id: i64,
    handle: JoinHandle<()>,
}

/// 所有活跃日志会话。用 Arc<Mutex<..>> 包起来以便 spawn 的任务持有它。
#[derive(Default)]
pub struct LogSessions {
    inner: Arc<Mutex<HashMap<String, LogSession>>>,
    next_id: Arc<AtomicU64>,
}

impl LogSessions {
    pub fn new() -> Self {
        Self::default()
    }

    fn alloc_id(&self) -> String {
        format!("log-{}", self.next_id.fetch_add(1, Ordering::SeqCst))
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogData {
    session_id: String,
    chunk: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogStatus {
    session_id: String,
    state: &'static str,
}

/// 打开一条日志流。立即返回 session_id，数据通过 `log://data` 事件推送。
///
/// 为什么用事件而不是 invoke 返回：日志是长连接推送，没有"返回"这一说。
#[tauri::command]
pub async fn log_open<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
    sessions: State<'_, LogSessions>,
    store: State<'_, LogStore>,
    task_id: i64,
    deploy_type: String,
    project_name: String,
    env_name: String,
) -> Result<String, AppError> {
    let session_id = sessions.alloc_id();

    // 只有被主动打开过的任务才落盘
    store.note_open(&deploy_type, task_id, &project_name, &env_name)?;

    let cookie = session
        .client()
        .await
        .cookie_header()
        .await
        .ok_or_else(|| AppError::auth("没有可用会话，请重新登录"))?;

    let base_url = session.client().await.base_url().to_string();
    let url = format!(
        "{}/wssapp/",
        base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );

    let app_for_task = app.clone();
    let sid = session_id.clone();
    let store_path = store.clone_for_task();
    let dt = deploy_type.clone();

    let handle = tauri::async_runtime::spawn(async move {
        let sid_c = sid.clone();
        let store_c = store_path.clone();
        let dt_c = dt.clone();
        let app_c = app_for_task.clone();

        let mut attempt = 0u32;
        loop {
            let sid_i = sid_c.clone();
            let store_i = store_c.clone();
            let dt_i = dt_c.clone();
            let app_i = app_c.clone();

            let result = connect_and_stream(
                &url,
                &cookie,
                task_id,
                &dt,
                move |chunk| {
                    // 落盘保留原始内容（未剥离 ANSI），显示时才剥离
                    let _ = store_i.append(&dt_i, task_id, &chunk);
                    let _ = app_i.emit(
                        "log://data",
                        LogData { session_id: sid_i.clone(), chunk },
                    );
                },
                {
                    let app_end = app_c.clone();
                    let sid_end = sid_c.clone();
                    move |end| {
                        let state = match end {
                            LogEnd::Finished => "finished",
                            LogEnd::Disconnected => "disconnected",
                        };
                        let _ = app_end.emit(
                            "log://status",
                            LogStatus { session_id: sid_end.clone(), state },
                        );
                    }
                },
            )
            .await;

            match result {
                Ok(()) => {
                    // 正常结束（收到 code=1），不再重连
                    let _ = app_for_task.emit(
                        "log://status",
                        LogStatus { session_id: sid.clone(), state: "finished" },
                    );
                    break;
                }
                Err(_) if attempt < 3 => {
                    attempt += 1;
                    tokio::time::sleep(crate::ws::log_socket::backoff_delay(attempt)).await;
                }
                Err(e) => {
                    let _ = app_for_task.emit(
                        "log://status",
                        LogStatus { session_id: sid.clone(), state: "error" },
                    );
                    eprintln!("日志连接最终失败：{e}");
                    break;
                }
            }
        }

        sessions.inner.lock().await.remove(&sid);
    });

    sessions
        .inner
        .lock()
        .await
        .insert(session_id.clone(), LogSession { task_id, handle });
    Ok(session_id)
}

/// 关闭日志标签页时调用：中止后台任务，停止落盘
#[tauri::command]
pub async fn log_close(sessions: State<'_, LogSessions>, session_id: String) -> Result<(), AppError> {
    if let Some(s) = sessions.inner.lock().await.remove(&session_id) {
        s.handle.abort();
    }
    Ok(())
}
```

> `LogStore` 需要可被 spawn 的任务持有，因此实现 `Clone`（内部只包一个 `PathBuf`），
> 并提供 `clone_for_task()`。在 `logs/store.rs` 里加：
> ```rust
> impl Clone for LogStore {
>     fn clone(&self) -> Self { Self { root: self.root.clone() } }
> }
> impl LogStore {
>     pub fn clone_for_task(&self) -> LogStore { self.clone() }
> }
> ```

- [ ] **Step 6: 注册**

`src-tauri/src/logs/mod.rs`：
```rust
pub mod store;
```

`src-tauri/src/lib.rs`：
```rust
pub mod logs;
pub mod ws;
```
在 `setup` 里注册状态：
```rust
app.manage(crate::logs::store::LogStore::new(
    crate::logs::store::logs_root(&app_data_dir),
));
app.manage(crate::commands::log::LogSessions::new());
```
在 `generate_handler!` 中追加：
```rust
            commands::log::log_open,
            commands::log::log_close,
```

- [ ] **Step 7: 编译并跑全量测试**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop/src-tauri
cargo test 2>&1 | grep -E "^test result" | head -1
cargo build 2>&1 | grep -c "^warning" | xargs -I{} echo "警告数: {}"
```

预期：约 90 个测试通过，零警告

- [ ] **Step 8: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A && git commit -m "feat(rust): 日志会话管理、事件推送与本地留存（含保留策略）"
```

---

## Task 3: 前端 —— ANSI 处理与进度行合并

这是日志页最容易出错、也最值得单测的部分，所以单独成任务。

**Files:**
- Create: `src/lib/ansi.ts`
- Create: `src/lib/ansi.test.ts`

- [ ] **Step 1: 写测试**

创建 `src/lib/ansi.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { stripAnsi, ingest, createLogBuffer } from "./ansi";

describe("stripAnsi", () => {
  it("去掉 SGR 颜色码", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
  });

  it("去掉光标移动与清屏码", () => {
    expect(stripAnsi("\u001b[2K\u001b[1Ahello")).toBe("hello");
  });

  it("去掉 OSC 序列（如设置终端标题）", () => {
    expect(stripAnsi("\u001b]0;title\u0007text")).toBe("text");
  });

  it("没有转义码时原样返回", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});

describe("ingest - 基本追加", () => {
  it("按行切分并追加", () => {
    const b = createLogBuffer();
    ingest(b, "line1\nline2\n");
    expect(b.lines.map((l) => l.text)).toEqual(["line1", "line2"]);
  });

  it("跨 chunk 的不完整行会拼接", () => {
    const b = createLogBuffer();
    ingest(b, "par");
    ingest(b, "tial\n");
    expect(b.lines.map((l) => l.text)).toEqual(["partial"]);
  });

  it("\\r\\n 与单独的 \\r 都算换行", () => {
    const b = createLogBuffer();
    ingest(b, "a\r\nb\rc");
    expect(b.lines.map((l) => l.text)).toEqual(["a", "b", "c"]);
  });

  it("忽略空行", () => {
    const b = createLogBuffer();
    ingest(b, "a\n\n\nb\n");
    expect(b.lines.map((l) => l.text)).toEqual(["a", "b"]);
  });
});

describe("ingest - 进度行原地更新", () => {
  it("同一层的进度行覆盖而不是新增", () => {
    // docker build 的典型输出：同一层反复推进度百分比
    const b = createLogBuffer();
    ingest(b, "a1b2c3d4: Pushing   [==>   ] 10%\n");
    ingest(b, "a1b2c3d4: Pushing   [====> ] 50%\n");
    ingest(b, "a1b2c3d4: Pushing   [======] 100%\n");
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0].text).toContain("100%");
  });

  it("不同层的进度行各自独立", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "bbbb: Pushing 20%\n");
    ingest(b, "aaaa: Pushing 90%\n");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[0].text).toContain("90%");
    expect(b.lines[1].text).toContain("20%");
  });

  it("进度行结束后再出现的普通行正常追加", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 100%\n");
    ingest(b, "Successfully built abc123\n");
    expect(b.lines).toHaveLength(2);
    expect(b.lines[1].text).toBe("Successfully built abc123");
  });

  it("Pulling / Downloading / Extracting 等也按进度行处理", () => {
    for (const verb of ["Pulling", "Downloading", "Extracting", "Waiting", "Preparing"]) {
      const b = createLogBuffer();
      ingest(b, `ffff: ${verb} 10%\n`);
      ingest(b, `ffff: ${verb} 80%\n`);
      expect(b.lines).toHaveLength(1);
      expect(b.lines[0].text).toContain("80%");
    }
  });

  it("被覆盖的行记录更新次数，便于 UI 做高亮", () => {
    const b = createLogBuffer();
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "aaaa: Pushing 20%\n");
    ingest(b, "aaaa: Pushing 30%\n");
    expect(b.lines[0].updates).toBe(3);
  });
});

describe("ingest - 上限保护", () => {
  it("超过上限时丢弃最旧的行，避免长时间构建把内存吃满", () => {
    const b = createLogBuffer({ maxLines: 10 });
    for (let i = 0; i < 25; i++) ingest(b, `line ${i}\n`);
    expect(b.lines).toHaveLength(10);
    expect(b.lines[0].text).toBe("line 15");
    expect(b.lines[9].text).toBe("line 24");
  });

  it("超限时保留进度行索引的正确性（被丢弃的进度行要重新追加）", () => {
    const b = createLogBuffer({ maxLines: 3 });
    ingest(b, "aaaa: Pushing 10%\n");
    ingest(b, "x\n");
    ingest(b, "y\n");
    ingest(b, "z\n");
    // aaaa 那行已被挤出窗口，此时再来一条 aaaa 进度应作为新行追加
    ingest(b, "aaaa: Pushing 90%\n");
    expect(b.lines.filter((l) => l.text.includes("aaaa")).length).toBe(1);
    expect(b.lines[b.lines.length - 1].text).toContain("90%");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/lib/ansi.test.ts 2>&1 | tail -5
```

预期：找不到模块 `./ansi`

- [ ] **Step 3: 实现**

创建 `src/lib/ansi.ts`：

```ts
export interface LogLine {
  /** 稳定 id，供 v-for 的 key 使用（行内容会原地变化，不能用内容做 key） */
  id: number;
  text: string;
  /** 被原地覆盖的次数。>1 说明是进度行 */
  updates: number;
}

export interface LogBuffer {
  lines: LogLine[];
  /** 未以换行结尾的残留片段，等下一个 chunk 拼接 */
  pending: string;
  /** 进度行 key → lines 下标 */
  progressIndex: Map<string, number>;
  maxLines: number;
  nextId: number;
}

const DEFAULT_MAX_LINES = 5000;

export function createLogBuffer(opts?: { maxLines?: number }): LogBuffer {
  return {
    lines: [],
    pending: "",
    progressIndex: new Map(),
    maxLines: opts?.maxLines ?? DEFAULT_MAX_LINES,
    nextId: 1,
  };
}

/**
 * 剥离 ANSI 转义序列。
 * 覆盖三类：CSI（颜色/光标）、OSC（终端标题，以 BEL 或 ST 结尾）、
 * 以及单字符转义（如 ESC ( B 这类字符集切换）。
 */
export function stripAnsi(input: string): string {
  return input
    // CSI: ESC [ 参数 中间字节 终止字节
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // OSC: ESC ] ... (BEL | ESC \)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    // 其余单字符转义（字符集切换等）
    .replace(/\u001b[()][AB012]/g, "")
    // 兜底：任何漏网的 ESC 序列
    .replace(/\u001b[@-Z\\-_]/g, "");
}

/**
 * 进度行前缀，例如 "a1b2c3d4: Pushing"。
 * 必须与服务端 docker build 的输出格式一致（插件 src/media/log.js 同款判定）。
 */
const PROGRESS_RE = /^([0-9a-f]+: (?:Pushing|Pulling|Downloading|Extracting|Waiting|Preparing))/;

/**
 * 把一个日志 chunk 并入缓冲区。
 *
 * 处理三件事：
 * 1. 剥离 ANSI
 * 2. 按 \r\n | \n | \r 切分，跨 chunk 的不完整行留在 pending 里
 * 3. 进度行（同一层同一动作）**原地覆盖**而不是不断新增——
 *    docker build 每推进一次进度都会重新打印整行，不合并会刷出几千行
 */
export function ingest(buf: LogBuffer, chunk: string): void {
  // \r 统一按换行处理；进度行正是靠 \r 原地刷新，这里会先把它们分成多行，
  // 再由下面的进度行合并逻辑收敛回一行
  const text = stripAnsi(buf.pending + chunk);
  const parts = text.split(/\r\n|\n|\r/);
  // 最后一个片段可能是不完整的行
  buf.pending = parts.pop() ?? "";

  for (const raw of parts) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    pushLine(buf, line);
  }
}

/** 流结束时把残留片段作为最后一行收尾 */
export function flush(buf: LogBuffer): void {
  const rest = buf.pending.trim();
  buf.pending = "";
  if (rest) pushLine(buf, rest);
}

function pushLine(buf: LogBuffer, line: string): void {
  const m = line.match(PROGRESS_RE);
  if (m) {
    const key = m[1];
    const idx = buf.progressIndex.get(key);
    if (idx !== undefined && idx < buf.lines.length && buf.lines[idx].text.startsWith(key)) {
      buf.lines[idx].text = line;
      buf.lines[idx].updates += 1;
      return;
    }
  }
  buf.lines.push({ id: buf.nextId++, text: line, updates: 1 });
  if (m) buf.progressIndex.set(m[1], buf.lines.length - 1);
  trimIfNeeded(buf);
}

/**
 * 超出上限时从头部丢弃，并重建进度行索引。
 *
 * 必须重建索引：被丢弃的进度行如果还留在 map 里，
 * 下次同名进度会去找一个已经不存在（或被别的行占用）的下标，
 * 导致覆盖到错误的行。
 */
function trimIfNeeded(buf: LogBuffer): void {
  if (buf.lines.length <= buf.maxLines) return;
  const overflow = buf.lines.length - buf.maxLines;
  buf.lines.splice(0, overflow);
  buf.progressIndex.clear();
  buf.lines.forEach((l, i) => {
    const m = l.text.match(PROGRESS_RE);
    if (m) buf.progressIndex.set(m[1], i);
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test -- src/lib/ansi.test.ts 2>&1 | tail -8
```

预期：全部 PASS

- [ ] **Step 5: 提交**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
git add -A && git commit -m "feat: ANSI 处理与日志行缓冲（含进度行原地合并与上限保护）"
```


---

## Task 4: 前端 —— 日志 store 与日志标签页

**Files:**
- Create: `src/api/log.ts`、`src/stores/logs.ts`
- Create: `src/views/LogView.vue`
- Modify: `src/components/TabHost.vue`

- [ ] **Step 1: API 封装**

创建 `src/api/log.ts`：

```ts
import { call } from "./ipc";

export function logOpen(params: {
  taskId: number;
  deployType: "auto" | "docker";
  projectName: string;
  envName: string;
}): Promise<string> {
  return call<string>("log_open", params);
}

export function logClose(sessionId: string): Promise<void> {
  return call<void>("log_close", { sessionId });
}

export interface LogDataEvent {
  sessionId: string;
  chunk: string;
}

export interface LogStatusEvent {
  sessionId: string;
  state: "connected" | "disconnected" | "finished" | "error";
}
```

- [ ] **Step 2: 日志 store**

创建 `src/stores/logs.ts`：

```ts
import { defineStore } from "pinia";
import { reactive } from "vue";
import * as api from "@/api/log";
import { createLogBuffer, ingest, flush, type LogBuffer } from "@/lib/ansi";

export type LogState = "connecting" | "connected" | "disconnected" | "finished" | "error";

interface Session {
  sessionId: string;
  taskId: number;
  projectName: string;
  envName: string;
  buffer: LogBuffer;
  state: LogState;
  /** 最近一次收到数据的时间，用于"T 秒无输出"提示 */
  lastDataAt: number;
}

/**
 * 日志会话表：sessionId → 会话。
 *
 * 用 reactive 而不是 ref<Record>：日志是高频率更新（每秒可能几十条），
 * 整体替换对象会让 Vue 追踪整棵子树；reactive 的细粒度依赖更省。
 * buffer 里的 lines 数组是原地 push/patch，配合 LogView 的 key 复用，
 * 不会每来一行就重绘整个列表。
 */
export const useLogsStore = defineStore("logs", () => {
  const sessions = reactive<Record<string, Session>>({});

  async function open(params: {
    taskId: number;
    deployType: "auto" | "docker";
    projectName: string;
    envName: string;
  }): Promise<string> {
    const sessionId = await api.logOpen(params);
    sessions[sessionId] = {
      sessionId,
      taskId: params.taskId,
      projectName: params.projectName,
      envName: params.envName,
      buffer: createLogBuffer(),
      state: "connecting",
      lastDataAt: Date.now(),
    };
    return sessionId;
  }

  /** 由 App.vue 的事件监听调用 */
  function onData(e: api.LogDataEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return; // 会话已关闭，事件还在路上，正常丢弃
    ingest(s.buffer, e.chunk);
    s.lastDataAt = Date.now();
    if (s.state === "connecting") s.state = "connected";
  }

  function onStatus(e: api.LogStatusEvent): void {
    const s = sessions[e.sessionId];
    if (!s) return;
    s.state = e.state === "finished" ? "finished" : e.state;
    if (e.state === "finished") flush(s.buffer);
  }

  async function close(sessionId: string): Promise<void> {
    delete sessions[sessionId];
    await api.logClose(sessionId);
  }

  async function closeByTask(taskId: number): Promise<void> {
    for (const s of Object.values(sessions)) {
      if (s.taskId === taskId) await close(s.sessionId);
    }
  }

  return { sessions, open, onData, onStatus, close, closeByTask };
});
```

- [ ] **Step 3: 日志标签页**

创建 `src/views/LogView.vue`：

```vue
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { openLog } from "@/stores/tabPayload";
import { useLogsStore } from "@/stores/logs";
import { Button } from "@/components/ui/button";

const props = defineProps<{ tabId: string }>();

const logs = useLogsStore();
const outputRef = ref<HTMLElement | null>(null);
const autoScroll = ref(true);
const sessionId = ref("");
const error = ref("");

/** 由标签栏上的 loading 状态驱动 */
const session = computed(() => (sessionId.value ? logs.sessions[sessionId.value] : undefined));

onMounted(async () => {
  const payload = openLog(props.tabId);
  if (!payload) {
    error.value = "日志标签缺少任务信息";
    return;
  }
  try {
    sessionId.value = await logs.open(payload);
  } catch (e) {
    error.value = String(e);
  }
});

// 自动滚动到底部（关闭时保留用户位置）
watch(
  () => session.value?.buffer.lines.length,
  async () => {
    if (!autoScroll.value) return;
    await nextTick();
    const el = outputRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
);

const STATE_TEXT: Record<string, string> = {
  connecting: "连接中…",
  connected: "已连接",
  disconnected: "已断开",
  finished: "已完成",
  error: "连接错误",
};

function clear(): void {
  const s = session.value;
  if (!s) return;
  s.buffer.lines.splice(0, s.buffer.lines.length);
  s.buffer.progressIndex.clear();
}

function copyAll(): void {
  const text = session.value?.buffer.lines.map((l) => l.text).join("\n") ?? "";
  void navigator.clipboard.writeText(text);
}
</script>

<template>
  <div class="h-full flex flex-col bg-[#0b0d12] text-[#d4d4d4]">
    <!-- 日志区用等宽深色，对应 spec §5 里 mockup 的日志风格 -->
    <div class="flex items-center gap-3 px-4 py-2 border-b border-white/10 shrink-0">
      <span class="text-sm font-medium">
        构建日志 · {{ session?.projectName ?? "…" }}
      </span>
      <span v-if="session?.envName" class="text-[11px] text-white/50">{{ session.envName }}</span>
      <span class="flex-1" />
      <span
        :class="[
          'text-[11px] px-2 py-0.5 rounded-full',
          session?.state === 'connected' ? 'bg-emerald-500/15 text-emerald-400' : '',
          session?.state === 'finished' ? 'bg-emerald-500/15 text-emerald-400' : '',
          session?.state === 'error' ? 'bg-red-500/15 text-red-400' : '',
          session?.state === 'disconnected' ? 'bg-amber-500/15 text-amber-400' : '',
          session?.state === 'connecting' ? 'bg-white/10 text-white/60' : '',
        ]"
      >
        {{ STATE_TEXT[session?.state ?? "connecting"] }}
      </span>
      <label class="flex items-center gap-1.5 text-[11px] text-white/60">
        <input v-model="autoScroll" type="checkbox" />
        自动滚动
      </label>
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="clear">清空</Button>
      <Button variant="outline" size="sm" class="h-6 px-2 text-[11px]" @click="copyAll">
        复制
      </Button>
    </div>

    <p v-if="error" class="px-4 py-2 text-xs text-red-400">{{ error }}</p>

    <div
      ref="outputRef"
      class="flex-1 min-h-0 overflow-auto px-4 py-3 font-mono text-[12px] leading-relaxed"
    >
      <div
        v-for="l in session?.buffer.lines ?? []"
        :key="l.id"
        :class="l.updates > 1 ? 'opacity-80' : ''"
        class="whitespace-pre-wrap break-all"
      >
        {{ l.text }}
      </div>
      <div v-if="!session?.buffer.lines.length && !error" class="text-white/40">
        等待日志输出…
      </div>
    </div>
  </div>
</template>
```

> `openLog(tabId)` 是一个极薄的模块（`src/stores/tabPayload.ts`），
> 用来把"某个标签页携带的参数"存起来供其组件读取。Tag 参数不宜直接塞进
> TabHost 的 props（会重复渲染），也不宜放 store 里反复变更：
> ```ts
> const payloads = new Map<string, { taskId: number; deployType: "auto" | "docker"; projectName: string; envName: string }>();
> export function setOpenLog(tabId: string, p: NonNullable<ReturnType<typeof openLog>>) { payloads.set(tabId, p); }
> export function openLog(tabId: string) { return payloads.get(tabId); }
> export function clearTab(tabId: string) { payloads.delete(tabId); }
> ```

- [ ] **Step 4: 接进 TabHost**

`src/components/TabHost.vue` 里，把原本落到 `WipView` 的 log 分支换成：

```vue
    <LogView v-else-if="t.kind === 'log'" :tab-id="t.id" />
```

并在 import 区加 `import LogView from "@/views/LogView.vue";`

同时 `src/App.vue` 的 `onMounted` 里接上日志事件：

```ts
  const logs = useLogsStore();
  await listen<api.LogDataEvent>("log://data", (e) => logs.onData(e.payload));
  await listen<api.LogStatusEvent>("log://status", (e) => logs.onStatus(e.payload));
```

（`import type * as api from "@/api/log";`）

- [ ] **Step 5: 标签关闭时释放会话**

`src/stores/tabs.ts` 的 `close()` 里，在从数组里移除后追加：

```ts
    // 日志标签关闭时要通知 Rust 释放连接与落盘句柄
    if (target.kind === "log" && target.taskId !== undefined) {
      void useLogsStore().closeByTask(target.taskId);
    }
```

注意需在 `close()` 开头保存 `const target = tabs.value[idx];`（当前实现直接用下标，需补这一步）。

- [ ] **Step 6: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run build 2>&1 | tail -3
npm test 2>&1 | grep -E "Tests "
```

- [ ] **Step 7: 手工验证**

```bash
npm run tauri dev
```

在任务列表里挑一条**构建中**的任务，点「Log」（需要先接上按钮 —— 见 Task 5）或先在控制台调用。
预期：标签打开、日志流式滚动、docker 的进度行**原地跳动**而不是刷屏。

- [ ] **Step 8: 提交**

```bash
git add -A && git commit -m "feat: 日志 store 与日志标签页（等宽深色、进度行原地更新）"
```

---

## Task 5: 前端 —— 接线：Log 按钮与标签生命周期

**Files:**
- Modify: `src/views/TaskListView.vue`
- Modify: `src/components/layout/TabBar.vue`

- [ ] **Step 1: 任务列表加 Log 按钮**

在 `src/views/TaskListView.vue` 的操作列，`<div class="flex items-center gap-1">` 内追加：

```vue
                <Button
                  variant="outline"
                  size="sm"
                  class="h-6 px-2 text-[11px]"
                  @click="openLogTab(t)"
                >
                  Log
                </Button>
```

script 里加：

```ts
import { setOpenLog } from "@/stores/tabPayload";

/** 每个 taskId 一个日志标签；已存在则聚焦（tabs.open 的 log 分支按 taskId 去重） */
function openLogTab(t: DeployTask): void {
  const id = tabs.open({ kind: "log", taskId: t.taskId, deployType: tasks.deployType });
  setOpenLog(id, {
    taskId: t.taskId,
    deployType: tasks.deployType,
    projectName: t.projectName,
    envName: t.envName,
  });
}
```

- [ ] **Step 2: 标签标题显示项目名**

`tabs.titleOf` 对 log 分支已有 `构建日志 · <projectName>` 的逻辑，但 `projectName` 需在 `open()` 时传入。把 Task 5 Step 1 的调用改为：

```ts
  const id = tabs.open({
    kind: "log",
    taskId: t.taskId,
    deployType: tasks.deployType,
    projectName: t.projectName,
  });
```

- [ ] **Step 3: 关闭日志标签时二次确认（仅连接中）**

spec §5.2 要求：日志处于 `connected` 时关闭需确认。

在 `TabBar.vue` 的关闭按钮上改为调用本地 `requestClose(t)`，新增：

```ts
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { useLogsStore } from "@/stores/logs";
import { ref } from "vue";

const logs = useLogsStore();
const pendingClose = ref<string | null>(null);

function isStreaming(tabId: string): boolean {
  // 该标签对应的会话是否还在收数据
  const t = tabs.tabs.find((x) => x.id === tabId);
  if (!t || t.kind !== "log" || t.taskId === undefined) return false;
  return Object.values(logs.sessions).some(
    (s) => s.taskId === t.taskId && (s.state === "connected" || s.state === "connecting"),
  );
}

function requestClose(tabId: string): void {
  if (isStreaming(tabId)) {
    pendingClose.value = tabId;
    return;
  }
  tabs.close(tabId);
}
```

模板里把 `@click.stop="tabs.close(t.id)"` 改成 `@click.stop="requestClose(t.id)"`，
并在末尾加：

```vue
  <ConfirmDialog
    :open="pendingClose !== null"
    title="日志仍在输出中，确认关闭？"
    description="关闭后将停止接收该任务的构建日志"
    confirm-text="关闭"
    danger
    @update:open="(v: boolean) => { if (!v) pendingClose = null; }"
    @confirm="() => { if (pendingClose) { tabs.close(pendingClose); pendingClose = null; } }"
  />
```

- [ ] **Step 4: 验证**

```bash
npm run build 2>&1 | tail -3
```

手工：任务列表点 Log → 打开日志标签；再点同一任务的 Log → **聚焦而不是新开**；
关掉 → 二次确认（若在输出中）；打开另一任务的 Log → 新标签。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 任务列表 Log 按钮与日志标签生命周期（连接中关闭需确认）"
```

---

## Task 6: 里程碑验证 —— 构建日志

- [ ] **Step 1: 真实构建日志验证**

1. 在测试环境提交一次部署（走向导）
2. 任务列表点该任务的「Log」
3. 预期
   - 日志**流式滚动**，标签状态从「连接中…」变「已连接」
   - docker 构建的进度行**原地跳动**（同一层不重复刷行）
   - 构建结束 → 状态变「已完成」，**不再重连**
   - 关掉标签 → 打开别的 → 再打开该任务 → 日志**从头重放**（因为落盘了）

- [ ] **Step 2: 确认落盘**

```bash
ls -la ~/Library/Application\ Support/com.zhizhengroup.deploy/logs/
echo "--- 索引 ---"
cat ~/Library/Application\ Support/com.zhizhengroup.deploy/logs/index.json | head -20
echo "--- 正文前几行（应含 ANSI 原始码）---"
head -c 300 ~/Library/Application\ Support/com.zhizhengroup.deploy/logs/*/*.log | cat -v | head -10
```

预期：有 `index.json` 与 `<deployType>/<taskId>.log`；正文是原始内容。

- [ ] **Step 3: 提交里程碑**

```bash
git add -A && git commit -m "chore: Plan 3 里程碑验证通过（构建日志）" --allow-empty
```

---

## Task 7: 系统托盘与关闭行为

**Files:**
- Create: `src-tauri/src/tray.rs`
- Modify: `src-tauri/src/lib.rs`、`src-tauri/capabilities/default.json`、`src-tauri/Cargo.toml`

- [ ] **Step 1: 依赖与权限**

```toml
# Cargo.toml
tauri = { version = "2", features = ["tray-icon"] }
```

`capabilities/default.json` 的 `permissions` 追加：
```json
    "core:tray:default",
    "core:menu:default",
    "core:window:allow-show",
    "core:window:allow-hide",
    "core:window:allow-set-focus"
```

- [ ] **Step 2: 实现托盘**

创建 `src-tauri/src/tray.rs`：

```rust
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::AppError;

/// 创建常驻托盘。
///
/// 菜单项通过**事件**通知前端，而不是在 Rust 里直接操作 UI——
/// Rust 不知道"标签""向导"这些概念（见 spec §1 的分层原则）。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;
    let new_deploy = MenuItem::with_id(app, "new_deploy", "新建部署", true, None::<&str>)
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;
    let task_list = MenuItem::with_id(app, "task_list", "任务列表", true, None::<&str>)
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;
    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::config(format!("创建分隔线失败：{e}")))?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;

    let menu = Menu::with_items(app, &[&show, &new_deploy, &task_list, &sep, &quit])
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;

    let handle = app.clone();
    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            AppError::config("缺少应用图标，无法创建托盘".to_string())
        })?)
        .tooltip("至真部署")
        .menu(&menu)
        // 左键点击托盘图标显示主窗口（macOS 上习惯用右键出菜单）
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let id = event.id().as_ref();
            match id {
                "quit" => app.exit(0),
                "show" => reveal_main(app),
                // 这两项交给前端开对应标签
                "new_deploy" => {
                    reveal_main(app);
                    let _ = app.emit("tray://command", "new_deploy");
                }
                "task_list" => {
                    reveal_main(app);
                    let _ = app.emit("tray://command", "task_list");
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（非 macOS 上常见）：显示窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| AppError::config(format!("创建托盘失败：{e}")))?;

    let _ = handle;
    Ok(())
}

/// 显示并聚焦主窗口（可能被隐藏在托盘里）
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
```

- [ ] **Step 3: 关闭行为**

在 `lib.rs` 的 `setup` 末尾加：

```rust
    crate::tray::setup(app.handle())?;
```

并在 `setup` 里注册窗口关闭拦截（要点：**默认关闭到托盘而不是退出**，与设置页的 `closeBehavior` 一致）：

```rust
    let cfg_for_close = commands::config::load(app.handle())?;
    let close_handle = app.handle().clone();
    if let Some(window) = app.get_webview_window("main") {
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 每次关闭时重新读取配置，用户改了设置立即生效
                let behavior = commands::config::load(&close_handle)
                    .map(|c| c.close_behavior)
                    .unwrap_or_else(|_| cfg_for_close.close_behavior.clone());
                if behavior == "tray" {
                    // 阻止默认关闭，改为隐藏
                    api.prevent_close();
                    if let Some(w) = close_handle.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
        });
    }
```

- [ ] **Step 4: 前端响应托盘命令**

`src/App.vue` 的 `onMounted` 里加：

```ts
  await listen<string>("tray://command", (e) => {
    if (e.payload === "new_deploy") tabs.open({ kind: "wizard" });
    else if (e.payload === "task_list") tabs.open({ kind: "list" });
  });
```

- [ ] **Step 5: 验证**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
cd src-tauri && cargo build 2>&1 | grep -c "^warning" | xargs -I{} echo "警告: {}"
cd .. && npm run tauri dev
```

预期：托盘出现图标；关闭窗口**不退出**（应用留在托盘）；点托盘图标/菜单能唤回窗口；
菜单「新建部署」能开向导；「退出」能真正退出。

- [ ] **Step 6: 提交**

```bash
git add -A && git commit -m "feat: 系统托盘与关闭到托盘（含托盘菜单命令）"
```

---

## Task 8: 构建完成通知（含去重）

**Files:**
- Create: `src/composables/useBuildNotifications.ts`
- Modify: `src/App.vue`、`src-tauri/capabilities/default.json`、`package.json`

- [ ] **Step 1: 依赖**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri add notification
```

- [ ] **Step 2: 实现**

创建 `src/composables/useBuildNotifications.ts`：

```ts
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTasksStore } from "@/stores/tasks";
import { useTabsStore } from "@/stores/tabs";
import type { DeployTask } from "@/api/parser";

/** 已经通知过的 (taskId, 终态) —— 去重，避免两个触发点重复弹窗 */
const notified = new Set<string>();

async function ensurePermission(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** 服务端只给文案，没有结构化状态，只能按关键字判定终态 */
function terminalState(t: DeployTask): "success" | "failed" | null {
  if (t.buildStatus.includes("成功")) return "success";
  if (t.buildStatus.includes("失败")) return "failed";
  return null;
}

/**
 * 构建完成通知。
 *
 * spec §6.2 要求两个触发点都用，但**必须去重**：
 * 1. 日志流收到 finished（用户正开着日志标签）
 * 2. 任务列表轮询时发现某任务从"构建中"跃迁到终态
 *
 * 两条都会命中同一个任务，靠 notified 集合按 (taskId, 终态) 去重。
 */
export function useBuildNotifications() {
  const tasks = useTasksStore();
  const tabs = useTabsStore();

  /** 记录上一次轮询看到的构建状态，用于 diff */
  let lastSeen = new Map<number, string>();

  function notifyOnce(t: DeployTask, state: "success" | "failed"): void {
    const key = `${t.taskId}_${state}`;
    if (notified.has(key)) return;
    notified.add(key);

    void (async () => {
      if (!(await ensurePermission())) return;
      const focused = await getCurrentWindow().isFocused();
      // 默认仅窗口失焦时通知（spec §6.2），避免你正看着界面还被弹
      if (focused) return;
      sendNotification({
        title: state === "success" ? "构建成功" : "构建失败",
        body: `${t.projectName} · ${t.envName}\n${t.title}`,
      });
    })();
  }

  /** 触发点 1：日志流结束 */
  function onLogFinished(taskId: number): void {
    const t = tasks.tasks.find((x) => x.taskId === taskId);
    if (!t) return;
    const state = terminalState(t);
    if (state) notifyOnce(t, state);
  }

  /** 触发点 2：轮询后对比状态跃迁 */
  function diffAfterRefresh(): void {
    const next = new Map<number, string>();
    for (const t of tasks.tasks) {
      next.set(t.taskId, t.buildStatus);
      const before = lastSeen.get(t.taskId);
      // 只在"从非终态变为终态"时通知，避免启动时把历史任务全弹一遍
      if (before !== undefined && before !== t.buildStatus) {
        const wasBuilding = before.includes("中") || before.includes("等待");
        const state = terminalState(t);
        if (wasBuilding && state) notifyOnce(t, state);
      }
    }
    lastSeen = next;
  }

  /** 点通知后跳到该任务 */
  function focusTask(taskId: number): void {
    const t = tasks.tasks.find((x) => x.taskId === taskId);
    if (!t) return;
    tabs.open({ kind: "log", taskId, deployType: tasks.deployType, projectName: t.projectName });
  }

  return { onLogFinished, diffAfterRefresh, focusTask };
}
```

- [ ] **Step 3: 接线**

`src/App.vue`：

```ts
  const notify = useBuildNotifications();
  // 触发点 1：日志流结束
  await listen<{ sessionId: string }>("log://status", (e) => {
    logs.onStatus(e.payload as never);
  });
```

> `log://status` 已在 Task 4 接过 `logs.onStatus`，这里再叠加通知逻辑：
> 在 `logs.onStatus` 里拿到 session 后，若 `state === "finished"` 则调用
> `notify.onLogFinished(session.taskId)`。为避免两处都 subscribe 同一事件，
> 建议把这段逻辑放在一个统一的事件入口里（`src/composables/useLogEvents.ts`），
> 由它分发给 `logs.onStatus` 与 `notify.onLogFinished`。

`TaskListView.vue` 的 `syncVisibility` 里，`await tasks.refresh()` 之后调用
`notify.diffAfterRefresh()`。

- [ ] **Step 4: 验证**

```bash
npm run build 2>&1 | tail -3
npm run tauri dev
```

手工：提交一次测试环境部署 → 把窗口切到后台（点别的应用）→ 构建完成后应收到系统通知。
**关键**：只应收到**一条**（去重生效）。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 构建完成通知（双触发点 + 按 taskId/终态去重）"
```

---

## Task 9: 历史日志（保留策略与回看）

**Files:**
- Create: `src-tauri/src/commands/history.rs`
- Create: `src/api/history.ts`、`src/stores/history.ts`、`src/views/HistoryView.vue`
- Modify: `src-tauri/src/lib.rs`、`src/components/TabHost.vue`、`src/views/SettingsView.vue`

- [ ] **Step 1: Rust 命令**

创建 `src-tauri/src/commands/history.rs`：

```rust
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::error::AppError;
use crate::logs::store::{HistoryEntry, LogStore, Retention};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOverview {
    pub entries: Vec<HistoryEntry>,
    pub total_size: u64,
}

#[tauri::command]
pub async fn history_list(store: State<'_, LogStore>) -> Result<HistoryOverview, AppError> {
    Ok(HistoryOverview {
        entries: store.list()?,
        total_size: store.total_size()?,
    })
}

#[tauri::command]
pub async fn history_read(
    store: State<'_, LogStore>,
    deploy_type: String,
    task_id: i64,
) -> Result<Option<String>, AppError> {
    store.read(&deploy_type, task_id)
}

#[tauri::command]
pub async fn history_delete(
    store: State<'_, LogStore>,
    deploy_type: String,
    task_id: i64,
) -> Result<(), AppError> {
    store.delete(&deploy_type, task_id)
}

#[tauri::command]
pub async fn history_clear(store: State<'_, LogStore>) -> Result<(), AppError> {
    store.clear()
}

/// 应用保留策略。启动时与设置页改动后各调一次。
#[tauri::command]
pub async fn history_apply_retention<R: Runtime>(
    app: AppHandle<R>,
    store: State<'_, LogStore>,
) -> Result<usize, AppError> {
    let cfg = crate::commands::config::load(&app)?;
    store.apply_retention(&Retention {
        max_days: cfg.log_retention_days,
        max_entries: cfg.log_retention_entries,
    })
}
```

> 需要在 `commands/config.rs` 的 `AppConfig` 里新增两个字段
> `log_retention_days: u64`（默认 30）与 `log_retention_entries: usize`（默认 500），
> 并在 `load`/`save` 里读写，字段名 `logRetentionDays` / `logRetentionEntries`。

注册：`commands/mod.rs` 加 `pub mod history;`，`lib.rs` 的 handler 列表追加五个命令。

- [ ] **Step 2: 前端**

`src/api/history.ts`：`history_list` / `history_read` / `history_delete` / `history_clear` 四个 invoke 封装（照 `api/favorites.ts` 的写法）。

`src/stores/history.ts`：`entries` / `totalSize` / `load()` / `readOne(deployType, taskId)` / `remove()` / `clear()`。

`src/views/HistoryView.vue`：
- 顶部显示条数与占用空间
- 列表按时间倒序（Rust 已排好），点击展开读取正文
- 正文用与 LogView 相同的等宽深色样式，**读取后先经 `stripAnsi` 再渲染**
- 每行有「导出」（用 `@tauri-apps/plugin-dialog` 选路径后写文件）与「删除」
- 顶部有「清空全部」（确认框）

`TabHost.vue` 里把 `history` 分支接上 `HistoryView`。
`SettingsView.vue` 的「日志留存」分组加：保留天数、最大条数两个输入 + 「清空全部日志」按钮 + 当前占用空间显示。

- [ ] **Step 3: 启动时应用策略**

`lib.rs` 的 `setup` 里 spawn 一次：

```rust
    let retention_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let store = retention_handle.state::<crate::logs::store::LogStore>();
        let cfg = match commands::config::load(&retention_handle) {
            Ok(c) => c,
            Err(_) => return,
        };
        let _ = store.apply_retention(&crate::logs::store::Retention {
            max_days: cfg.log_retention_days,
            max_entries: cfg.log_retention_entries,
        });
    });
```

- [ ] **Step 4: 验证**

```bash
npm run build 2>&1 | tail -3
```

手工：打开过几条日志后 → 历史日志页应能列出、展开、导出、删除；
把「最大条数」改成 1 → 应只保留最近一条（且文件也被删掉）。

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "feat: 历史日志回看、导出与保留策略"
```

---

## Task 10: 键盘快捷键

**Files:**
- Create: `src/composables/useShortcuts.ts`
- Modify: `src/App.vue`、`src/views/SettingsView.vue`

- [ ] **Step 1: 实现**

创建 `src/composables/useShortcuts.ts`：

```ts
import { onMounted, onUnmounted } from "vue";
import { useTabsStore } from "@/stores/tabs";
import type { TabKind } from "@/stores/tabs";

const FIXED_ORDER: TabKind[] = ["wizard", "favorites", "list", "history", "settings"];

/**
 * 应用级快捷键（spec §6.4）。
 *
 * 用 DOM keydown 而非 Tauri 的全局快捷键：这些都是"应用内"快捷键，
 * 不该在应用失焦时抢占系统按键。
 */
export function useShortcuts() {
  const tabs = useTabsStore();

  function onKeydown(e: KeyboardEvent): void {
    const meta = e.metaKey || e.ctrlKey;
    if (!meta) return;

    // 输入框里不劫持按键（否则在搜索框按 Cmd+W 想删词都会关标签）
    const el = e.target as HTMLElement | null;
    const typing =
      el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
    if (typing && e.key !== ",") return;

    switch (e.key.toLowerCase()) {
      case "n":
        e.preventDefault();
        tabs.open({ kind: "wizard" });
        break;
      case "r":
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("app://refresh"));
        break;
      case "w": {
        e.preventDefault();
        if (tabs.activeId) tabs.close(tabs.activeId);
        break;
      }
      case ",":
        e.preventDefault();
        tabs.open({ kind: "settings" });
        break;
      default: {
        // Cmd+1..5 切换固定顺序里的标签
        const n = Number(e.key);
        if (Number.isInteger(n) && n >= 1 && n <= 5) {
          e.preventDefault();
          tabs.open({ kind: FIXED_ORDER[n - 1] });
        }
      }
    }
  }

  onMounted(() => window.addEventListener("keydown", onKeydown));
  onUnmounted(() => window.removeEventListener("keydown", onKeydown));
}
```

`src/App.vue` 里调用 `useShortcuts();`

任务列表与收藏页监听 `app://refresh` 事件，重新拉取：

```ts
onMounted(() => window.addEventListener("app://refresh", () => void tasks.refresh()));
```

- [ ] **Step 2: 设置页展示快捷键**

`SettingsView.vue` 的「关于」分组（新建）里加一张快捷键表：

| 快捷键 | 动作 |
|---|---|
| ⌘/Ctrl + N | 新建部署 |
| ⌘/Ctrl + R | 刷新当前标签 |
| ⌘/Ctrl + W | 关闭当前标签 |
| ⌘/Ctrl + 1…5 | 切换到第 N 个标签 |
| ⌘/Ctrl + , | 打开设置 |

- [ ] **Step 3: 验证**

```bash
npm run build 2>&1 | tail -3
```

手工逐个试一遍；重点试**在搜索框里输入时**不应触发快捷键（除了 Cmd+,）。

- [ ] **Step 4: 提交**

```bash
git add -A && git commit -m "feat: 键盘快捷键与设置页快捷键说明"
```

---

## Task 11: 打包配置与三端产物

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`package.json`
- Create: `src-tauri/icons/*`（由 `tauri icon` 生成）

- [ ] **Step 1: 准备应用图标**

准备一张 **1024×1024 PNG**（带透明通道）放到仓库根，例如 `assets/app-icon.png`，然后：

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm run tauri icon assets/app-icon.png
```

预期：`src-tauri/icons/` 下生成全套（含 `icon.icns` / `icon.ico` / 各尺寸 png）。

> 如果没有现成图标，先临时用现有 `media/icon.png`（插件里的）转成 1024×1024 应急，
> 正式图标后续替换。**注意**：图标是分发给同事的门面，不要长期用占位图。

- [ ] **Step 2: 打包配置**

`src-tauri/tauri.conf.json` 的 `bundle` 段补充：

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "category": "DeveloperTool",
    "shortDescription": "至真内部运维平台部署工具",
    "longDescription": "至真部署 - ITSM 部署桌面客户端，支持自动化部署与 Docker 部署、实时构建日志、收藏快速部署。",
    "macOS": {
      "minimumSystemVersion": "10.15"
    },
    "linux": {
      "deb": { "depends": [] }
    }
  }
```

- [ ] **Step 3: 三端构建**

在各自平台上执行（**必须在对应平台上做，不能交叉编译**）：

```bash
# macOS：默认产出 arm64；要同时支持 Intel 需 universal
npm run tauri build
# 或
npm run tauri build -- --target universal-apple-darwin
```

```bash
# Windows / Linux：在对应机器上
npm run tauri build
```

预期产物：
| 平台 | 产物 |
|---|---|
| macOS | `target/release/bundle/dmg/*.dmg`、`macos/*.app` |
| Windows | `target/release/bundle/msi/*.msi`、`nsis/*.exe` |
| Linux | `target/release/bundle/appimage/*.AppImage`、`deb/*.deb` |

- [ ] **Step 4: 未签名分发的说明文档**

创建 `docs/install-unsigned.md`，写清首次打开的放行步骤：

````markdown
# 未签名版本安装说明

当前构建**未做代码签名**，系统会提示来源不明。按下面步骤放行即可。

## macOS
1. 打开 `.dmg`，把 App 拖进「应用程序」
2. 首次打开会提示「无法验证开发者」→ 点「完成」
3. 到「系统设置 → 隐私与安全性」，在底部找到刚被拦下的项目 → 点「仍要打开」
4. 之后每次双击即可正常打开

若提示「已损坏，无法打开」（下载后被加了隔离属性），在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/至真部署.app"
```

## Windows
1. 双击 `.msi` 安装
2. 若出现 SmartScreen 提示 → 点「更多信息」→「仍要运行」
3. 安装完成后从开始菜单启动

## Linux

```bash
chmod +x 至真部署_*.AppImage
./至真部署_*.AppImage
```
````

- [ ] **Step 5: 提交**

```bash
git add -A && git commit -m "chore: 打包配置、应用图标与未签名安装说明"
```

---

## Task 12: 里程碑验证 —— 增强功能与分发

- [ ] **Step 1: 全量自动化**

```bash
cd ~/code/company/tool-demo/zz-deploy-desktop
npm test 2>&1 | grep -E "Test Files|Tests "
cd src-tauri && cargo test 2>&1 | grep -E "^test result" | head -1
cd .. && npx vue-tsc --noEmit && echo "无类型错误 ✓"
```

- [ ] **Step 2: spec P6 增强项逐项对照**

| spec §6 要求 | 验证方式 |
|---|---|
| 系统托盘常驻 + 菜单 | 托盘图标存在；菜单四项可用 |
| 关闭窗口最小化到托盘 | 关窗口不退出；设置里改为「退出」后关窗口应退出 |
| 构建完成桌面通知 | 失焦时收到；**只收到一条**（去重） |
| 日志本地留存与回看 | 历史日志页可列出/展开/导出/删除 |
| 保留策略 | 改「最大条数」后淘汰生效，且文件一并删除 |
| 键盘快捷键 | 5 个快捷键逐个试；输入框内不劫持 |
| 深浅色跟随系统 | 设置里切「跟随系统」，改系统外观应实时跟随 |
| GET 自动重试 / POST 不重试 | 已由 Plan 1 单测覆盖 |

- [ ] **Step 3: 三端构建验证**

三个平台各跑一次 `npm run tauri build`，产物按 Task 11 的表格核对。
**这一步必须在对应物理机/虚拟机上做**。

- [ ] **Step 4: 提交里程碑**

```bash
git add -A && git commit -m "chore: Plan 3+4 里程碑验证通过（构建日志 + 客户端增强 + 分发）" --allow-empty
```

---

## 完成标准

- [ ] Rust 测试全绿（预计约 100 个）
- [ ] 前端测试全绿（预计约 145 个，含 ansi 的 15 条）
- [ ] `vue-tsc --noEmit` 无类型错误
- [ ] 真实构建日志能流式显示，docker 进度行原地更新
- [ ] 日志落盘且可在历史页回看
- [ ] 托盘常驻、关闭到托盘、菜单可用
- [ ] 构建完成通知（失焦时、去重后一条）
- [ ] 5 个快捷键生效且不干扰输入
- [ ] 三端各自产出安装包，未签名放行步骤有文档

**至此功能上**完全覆盖并超出** VSCode 插件**（多出：拖动排序、本地日志留存、托盘与通知、快捷键、深浅主题）。

---

## 交付后建议

1. **补 ESLint**：把「视图不得直接 import `api/*` 的写操作」变成 `no-restricted-imports` 机械约束（Plan 2 遗留）
2. **代码签名**：拿到 Apple Developer 账号与 Windows 代码签名证书后，可去掉未签名分发的麻烦
3. **Plan 5 候选**（都是 spec §11 明确"不做"的，需要重新立项）：
   自定义环境列表、多账号、部署审批、批量部署、`/devapi/` 新接口探测
4. **共用 fixture 巡检**：ITSM 改版时，桌面端与插件的 parser 都要跟着改。
   建议定期跑一次 `cargo run --example capture_fixtures` 刷新 fixture，
   若解析测试报红就能立刻定位是哪张表变了。
