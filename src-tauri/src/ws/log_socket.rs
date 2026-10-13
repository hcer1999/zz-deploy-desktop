//! 构建日志 WebSocket 客户端。
//!
//! 放在 Rust 而非前端：握手需要带 `Cookie` 头，浏览器的 WebSocket API
//! 不允许设置自定义请求头。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

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
///
/// 返回值语义（spec §4.3）：
/// - `Ok(())` 且 `on_end(Finished)`：收到 code=1，调用方**不要重连**
/// - `Ok(())` 且 `on_end(Disconnected)`：连接被正常关闭但日志未结束，调用方应重连
/// - `Err(..)`：连接出错，调用方应重连
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
            Err(e) => {
                on_end(LogEnd::Disconnected);
                return Err(AppError::network(format!("日志连接中断：{e}")));
            }
        };
        let text = match msg {
            Message::Text(t) => t.to_string(),
            // 服务端主动关闭但没有 code=1：日志没写完，交给调用方重连
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
    async fn sends_auth_frame_then_forwards_build_log() {
        let (url, received) =
            spawn_ws_server(vec![r#"{"build_log":"hello\n"}"#, r#"{"build_log":"world\n"}"#]).await;

        let chunks = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let c = chunks.clone();
        let finished = Arc::new(AtomicUsize::new(0));
        let f = finished.clone();
        let disconnected = Arc::new(AtomicUsize::new(0));
        let d = disconnected.clone();

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
            move |state| match state {
                LogEnd::Finished => {
                    f.fetch_add(1, Ordering::SeqCst);
                }
                LogEnd::Disconnected => {
                    d.fetch_add(1, Ordering::SeqCst);
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
        // 没收到 code=1 就被关闭 → 视为异常断开（spec §4.3：调用方应重连），
        // 因此这里报的是 Disconnected 而不是 Finished。
        // Finished 只留给 code=1，见 code_1_means_finished。
        assert_eq!(finished.load(Ordering::SeqCst), 0);
        assert_eq!(disconnected.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn docker_uses_service_typo_submittype() {
        let (url, received) = spawn_ws_server(vec![r#"{"code":1}"#]).await;
        connect_and_stream(&url, "s=1", 7, "docker", |_| {}, |_| {})
            .await
            .unwrap();
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
        connect_and_stream(
            &url,
            "s=1",
            1,
            "auto",
            |_| {},
            move |st| {
                if st == LogEnd::Finished {
                    f.fetch_add(1, Ordering::SeqCst);
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(finished.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn ignores_non_json_messages() {
        let (url, _) = spawn_ws_server(vec!["not json at all", r#"{"build_log":"ok"}"#]).await;
        let chunks = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let c = chunks.clone();
        connect_and_stream(
            &url,
            "s=1",
            1,
            "auto",
            move |ch| {
                c.try_lock().unwrap().push(ch);
            },
            |_| {},
        )
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
