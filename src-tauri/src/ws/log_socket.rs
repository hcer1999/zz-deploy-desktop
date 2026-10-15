//! 构建日志 WebSocket 客户端。
//!
//! 放在 Rust 而非前端：握手需要带 `Cookie` 头，浏览器的 WebSocket API
//! 不允许设置自定义请求头。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use crate::error::AppError;

/// 一次订阅的结束方式
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamEnd {
    /// 回调判定日志已写完（见 `log_is_complete`），调用方报「已完成」并停止
    Complete,
    /// 对端把连接断开了。**注意服务端在推完一份快照后会直接 reset**，
    /// 所以这既可能是「构建结束」也可能是「中途断开」，由调用方按内容判断
    Closed,
    /// 服务端用 `code=0` 明确拒绝，msg 是它的原话（实测：构建已结束且服务端
    /// 不再持有该日志时回 `数据格式错误`）。重连没有意义
    Rejected(String),
}

/// 日志是否已经写到收尾。
///
/// 服务端**不给结构化的结束信号**（它在推完快照后直接 reset），只能按内容判定。
/// 下面这些标记都是构建结束时才会出现的收尾行（实测三种构建）：
/// - docker 成功：`构建成功` 之后 ITSM 自己写的 `{"code": 0}更新构建状态成功`
/// - docker 失败：`构建失败！！`
/// - Jenkins（自动化部署）：`Finished: SUCCESS` / `Finished: FAILURE`
const DONE_MARKERS: &[&str] = &[
    "更新构建状态成功",
    "构建失败！！",
    "Finished: SUCCESS",
    "Finished: FAILURE",
];

pub fn log_is_complete(snapshot: &str) -> bool {
    DONE_MARKERS.iter().any(|m| snapshot.contains(m))
}

/// 连接日志 WebSocket 并把快照推给回调，直到日志写完 / 连接断开 / 被拒。
///
/// 为什么必须放在 Rust：握手要带 `Cookie` 头，而浏览器的 WebSocket API
/// 不允许设置自定义请求头。
///
/// `submittype` 的拼写（`delpoyment` / `dockerdelpoy`）是**服务端原始值**，
/// 含拼写错误也必须照发，否则服务端认不出。对应插件 `src/ws/logSocket.ts:52`。
///
/// **推送语义（依据 ITSM 页面自己的 `build_log.js` + 实测原始帧）**：
/// - `code == 0` → 拒绝/终止，`msg` 是服务端原话（例：`数据格式错误`）
/// - `code == 1` → 一份新的**全量日志快照**，不是「日志结束」。
///   页面那边就是 `$("#build_log").text(data["build_log"])` 直接覆盖，
///   并靠反复收到 `code == 1` 来刷新。所以快照交给回调，由回调自己取增量：
///   回 `true` = 继续订阅，回 `false` = 日志已完整、停止订阅。
/// - 服务端在一份快照之后可能**直接 reset 连接**（没有 Close 帧），这时返回 `Closed`。
pub async fn connect_and_stream<F>(
    url: &str,
    cookie: &str,
    task_id: i64,
    deploy_type: &str,
    mut on_snapshot: F,
) -> Result<StreamEnd, AppError>
where
    F: FnMut(&str) -> bool,
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
    req.headers_mut().insert(
        "Origin",
        HeaderValue::from_str(&origin_of(url))
            .map_err(|e| AppError::config(format!("Origin 头非法：{e}")))?,
    );

    let (mut ws, _resp) = tokio_tungstenite::connect_async(req)
        .await
        .map_err(|e| AppError::network(format!("连接日志服务失败：{e}")))?;

    // 认证帧
    let session_key = session_key_of(cookie);
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
            // 服务端推完快照会直接 reset → 这里会是协议错误；按「连接被断开」上报，
            // 让调用方按内容判断是「构建结束」还是「中途掉线」
            Err(e) => return Err(AppError::network(format!("日志连接中断：{e}"))),
        };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            // 服务端主动关闭
            Message::Close(_) => return Ok(StreamEnd::Closed),
            _ => continue,
        };
        // 非 JSON 帧忽略而不是中断——服务端偶尔会发保活之类的裸内容
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        // code=0：服务端明确拒绝（实测：构建已结束且服务端不再持有日志时），重连无意义
        if v.get("code").and_then(|x| x.as_i64()) == Some(0) {
            let msg = v
                .get("msg")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let _ = ws.close(None).await;
            return Ok(StreamEnd::Rejected(msg));
        }

        // code=1 + build_log：一份新的全量快照。**绝不能在这里结束订阅**，
        // 否则就只看到打开那一刻的一帧——这正是「日志不实时更新」的根因。
        if let Some(log) = v.get("build_log").and_then(|x| x.as_str()) {
            if !on_snapshot(log) {
                let _ = ws.close(None).await;
                return Ok(StreamEnd::Complete);
            }
        }
    }

    Ok(StreamEnd::Closed)
}

/// 从 Cookie 头里取出 sessionid 的值。插件用 `sessionid=([^;]+)` 正则，等价。
fn session_key_of(cookie: &str) -> String {
    cookie
        .split(';')
        .find_map(|p| p.trim().strip_prefix("sessionid="))
        .unwrap_or("")
        .to_string()
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
    Duration::from_millis(3000 * 2u64.pow(attempt.min(3)))
}

/// 安装进程级默认加密后端（幂等）。
///
/// **必须在任何 `wss://` 连接之前调用**：tokio-tungstenite 在 TLS 握手时会构造
/// `rustls::ClientConfig`，而 rustls 0.23 若拿不到默认 `CryptoProvider` 就直接 panic
/// （tokio-tungstenite 的 rustls 特性不带 provider）。本项目的 release 配置是
/// `panic = "abort"`，所以那个 panic 的表现是**整个应用瞬间退出**——
/// 见测试 `wss_path_can_build_a_tls_config`。
///
/// 这里不依赖 rustls 的"按 crate feature 自动挑选"：一旦将来有别的依赖也启用
/// 另一种 provider，自动挑选会变成 "multiple CryptoProviders" panic。
pub fn ensure_tls_provider() {
    // 已经装过时返回 Err，属正常情况
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
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
                if ws
                    .send(tokio_tungstenite::tungstenite::Message::text(m))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            // 推完发一个正常的 Close 帧，再保持连接片刻等客户端收完
            let _ = ws.close(None).await;
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        });

        (format!("ws://{addr}/wssapp/"), received)
    }

    #[tokio::test]
    async fn sends_auth_frame_then_forwards_snapshots() {
        let (url, received) = spawn_ws_server(vec![
            r#"{"code":1,"build_log":"hello\n"}"#,
            r#"{"code":1,"build_log":"hello\nworld\n"}"#,
        ])
        .await;

        let snapshots = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let s = snapshots.clone();

        let end = connect_and_stream(&url, "sessionid=abc", 42, "auto", move |snapshot| {
            // 回调是同步的，用 try_lock 收集即可（测试里不会争用）
            s.try_lock().unwrap().push(snapshot.to_string());
            true
        })
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

        // 两帧都被送到回调；服务端随后发了 Close 帧 → Closed
        let got = snapshots.lock().await;
        assert_eq!(got.len(), 2, "code=1 是快照而不是结束，两帧都要拿到");
        assert_eq!(got[1], "hello\nworld\n");
        assert_eq!(end, StreamEnd::Closed);
    }

    /// 回归：code=1 **不是**「日志结束」。旧实现收到它就 return，
    /// 于是只拿到打开那一刻的一帧——这正是用户报的「日志不实时更新」。
    #[tokio::test]
    async fn code_1_is_a_snapshot_not_the_end() {
        let (url, _) = spawn_ws_server(vec![
            r#"{"code":1,"build_log":"a"}"#,
            r#"{"code":1,"build_log":"ab"}"#,
            r#"{"code":1,"build_log":"abc"}"#,
        ])
        .await;

        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let end = connect_and_stream(&url, "s=1", 1, "auto", move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            true
        })
        .await
        .unwrap();

        assert_eq!(count.load(Ordering::SeqCst), 3, "三帧快照都要收到");
        assert_eq!(end, StreamEnd::Closed);
    }

    /// 回调返回 false（日志已完整）→ 立刻停止订阅，返回 Complete
    #[tokio::test]
    async fn callback_can_stop_the_stream() {
        let (url, _) = spawn_ws_server(vec![
            r#"{"code":1,"build_log":"x"}"#,
            r#"{"code":1,"build_log":"xy"}"#,
        ])
        .await;

        let count = Arc::new(AtomicUsize::new(0));
        let c = count.clone();
        let end = connect_and_stream(&url, "s=1", 1, "auto", move |_| {
            c.fetch_add(1, Ordering::SeqCst);
            false // 比如快照里已经出现「更新构建状态成功」
        })
        .await
        .unwrap();

        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(end, StreamEnd::Complete);
    }

    /// code=0 是服务端明确拒绝（实测：构建已结束且服务端不再持有该日志时回
    /// {"code":0,"msg":"数据格式错误"}）→ 把 msg 原话带出去，重连无意义
    #[tokio::test]
    async fn code_0_is_a_rejection_with_msg() {
        let (url, _) = spawn_ws_server(vec![r#"{"code":0,"msg":"数据格式错误"}"#]).await;
        let end = connect_and_stream(&url, "s=1", 1, "auto", |_| true).await.unwrap();
        assert_eq!(end, StreamEnd::Rejected("数据格式错误".to_string()));
    }

    #[test]
    fn completion_markers() {
        assert!(log_is_complete("...\n构建成功\n{\"code\": 0}更新构建状态成功\ntest2\n"));
        assert!(log_is_complete("构建失败！！\n{\"code\": 0}"));
        assert!(log_is_complete("[Pipeline] End of Pipeline\nFinished: SUCCESS"));
        assert!(log_is_complete("Finished: FAILURE"));
        // 构建中途的普通内容不能被误判成结束
        assert!(!log_is_complete("[Pipeline] End of Pipeline 即将开始\n"));
        assert!(!log_is_complete("change workspace to /data/itsm-build/workspace/x"));
        assert!(!log_is_complete(""));
    }

    #[tokio::test]
    async fn docker_uses_service_typo_submittype() {
        let (url, received) = spawn_ws_server(vec![r#"{"code":1,"build_log":"x"}"#]).await;
        connect_and_stream(&url, "s=1", 7, "docker", |_| true)
            .await
            .unwrap();
        let sent = received.lock().await;
        let v: serde_json::Value = serde_json::from_str(&sent[0]).unwrap();
        // 服务端的原始拼写错误，必须原样保持
        assert_eq!(v["submittype"], "dockerdelpoy");
    }

    #[tokio::test]
    async fn connect_failure_returns_error() {
        // 端口没人监听
        let err = connect_and_stream("ws://127.0.0.1:1/wssapp/", "s=1", 1, "auto", |_| true)
            .await
            .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Network);
    }

    /// 真实服务端是 `wss://`，而本文件其它测试用的是本地 `ws://`——
    /// 所以 TLS 分支一直没被测到：rustls 拿不到默认 `CryptoProvider` 时会 panic，
    /// 配上 release 的 `panic = "abort"`，表现就是"点一下 Log 应用直接消失"。
    ///
    /// 这里用一个"接受连接但不是 TLS"的本地服务端：
    /// TCP 连得上 → tokio-tungstenite 会执行 ClientConfig 构造（panic 点）
    /// → 握手失败返回错误。因此只要 provider 缺失，本用例就会 panic 报错。
    #[tokio::test]
    async fn wss_connect_builds_tls_config_without_panicking() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                // 立即断开，让 TLS 握手快速失败，而不是把测试挂在那里
                drop(stream);
            }
        });

        let err = connect_and_stream(
            &format!("wss://{addr}/wssapp/"),
            "s=1",
            1,
            "auto",
            |_| true,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Network);
    }

    /// 显式安装默认 CryptoProvider，避免依赖 rustls 的"按 feature 自动挑选"：
    /// 一旦将来有别的依赖也启用另一种 provider，自动挑选会变成 panic。
    #[test]
    fn tls_provider_is_installed_explicitly() {
        ensure_tls_provider();
        assert!(rustls::crypto::CryptoProvider::get_default().is_some());
        // 重复调用不应出错（run() 与测试可能都会调）
        ensure_tls_provider();
    }
}
