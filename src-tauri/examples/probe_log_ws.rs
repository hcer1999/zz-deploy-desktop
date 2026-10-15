//! 诊断工具：直接连 ITSM 的日志 WebSocket，把服务端**原始帧**按时间打出来。
//!
//!   cd src-tauri
//!   cargo run --example probe_log_ws -- <taskId> [auto|docker] [观察秒数=30]
//!
//! 其中「C. 模拟修复后的应用」就是应用现在真实的处理方式：把每帧当全量快照、只取增量、
//! 按收尾行判定结束；不写任何文件。
//!
//! 用来判断「日志不实时更新」卡在哪一段：
//!   * 一个 `build_log` 帧都没有，只有 `msg`     → 认证/订阅没被服务端接受（看 msg 内容）
//!   * 第一波之后就静默                          → 服务端只在构建写日志时推，确认构建是否还在跑
//!   * 帧持续不断但界面不动                      → 问题在前端事件链路，不在这侧
//!
//! 还会交叉验证一个关键假设：**页面里的 `var session_key` 与 cookie 里的 `sessionid` 是否同一个值**。
//! 两者不一致时 HTTP 一切正常、WebSocket 却永远收不到数据（订阅被服务端拒绝），
//! 而应用界面只会一直显示「已连接」——这是最难靠猜定位的形态。
//!
//! 只打印 cookie 的**名字与长度**，不打印凭据本身。

use std::error::Error;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

use zz_deploy_desktop_lib::commands::auth::login_flow;
use zz_deploy_desktop_lib::net::client::HttpClient;
use zz_deploy_desktop_lib::secure::store_from_app_data_dir;
use zz_deploy_desktop_lib::ws::log_socket::{StreamEnd, connect_and_stream, ensure_tls_provider, log_is_complete};

/// 取 cookie 头里某个名字的值（不打印值，只用来交叉比对）
fn cookie_value(header: &str, name: &str) -> Option<String> {
    header.split(';').find_map(|p| {
        let p = p.trim();
        p.strip_prefix(&format!("{name}=")).map(|v| v.to_string())
    })
}

/// 从页面 HTML 里抠出 `var session_key = '…'`（不引入 regex 依赖，手写扫描）
fn page_session_key(html: &str) -> Option<String> {
    let at = html.find("session_key")?;
    let rest = &html[at..];
    let q = rest.find(['\'', '"'])?;
    let quote = rest.as_bytes()[q] as char;
    let after = &rest[q + 1..];
    let end = after.find(quote)?;
    let v = &after[..end];
    if v.is_empty() { None } else { Some(v.to_string()) }
}

/// 只描述不泄密：长度 + 前 6 位
fn fingerprint(v: &str) -> String {
    format!("len={} head={}", v.len(), &v[..v.len().min(6)])
}

fn preview(s: &str) -> String {
    let s = s.replace('\r', "\\r").replace('\n', "\\n");
    s.chars().take(160).collect()
}

/// 取末尾 n 个字符（按字符切，避免切坏 UTF-8）
fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

async fn dump_frames(
    label: &str,
    url: &str,
    cookie: &str,
    task_id: i64,
    deploy_type: &str,
    session_key: &str,
    seconds: u64,
) -> Result<(), Box<dyn Error>> {
    println!("\n=== {label}：用 session_key({}) 订阅 ===", fingerprint(session_key));

    let mut req = url.into_client_request()?;
    // 与应用一致：Cookie 头走完整 cookie 串；session_key 从 cookie 的 sessionid 提取
    req.headers_mut()
        .insert("Cookie", HeaderValue::from_str(cookie)?);
    req.headers_mut().insert(
        "Origin",
        HeaderValue::from_str(&format!(
            "https://{}",
            url.trim_start_matches("wss://")
                .trim_start_matches("ws://")
                .split('/')
                .next()
                .unwrap_or("")
        ))?,
    );

    let (mut ws, _resp) = match tokio_tungstenite::connect_async(req).await {
        Ok(x) => x,
        Err(e) => {
            println!("连接失败：{e}");
            return Ok(());
        }
    };
    println!("已连上，发送认证帧…");

    let submittype = if deploy_type == "docker" { "dockerdelpoy" } else { "delpoyment" };
    let auth = serde_json::json!({
        "sock_type": "BuildLog",
        "session_key": session_key,
        "id": task_id.to_string(),
        "submittype": submittype,
    })
    .to_string();
    ws.send(Message::text(auth)).await?;

    let started = tokio::time::Instant::now();
    let deadline = started + Duration::from_secs(seconds);
    let mut frames = 0usize;
    let mut bytes = 0usize;
    let mut log_frames = 0usize;

    loop {
        let next = tokio::time::timeout_at(deadline, ws.next()).await;
        let elapsed = started.elapsed().as_secs_f32();
        match next {
            Err(_) => {
                println!(
                    "[{elapsed:>6.1}s] 观察结束：共 {frames} 帧 / {bytes} 字节，其中 build_log 帧 {log_frames} 个"
                );
                break;
            }
            Ok(None) => {
                println!("[{elapsed:>6.1}s] 对端关闭了连接（没有 Close 帧细节）");
                break;
            }
            Ok(Some(Err(e))) => {
                println!("[{elapsed:>6.1}s] 读取出错：{e}");
                break;
            }
            Ok(Some(Ok(msg))) => match msg {
                Message::Text(t) => {
                    let text = t.to_string();
                    frames += 1;
                    bytes += text.len();
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
                        println!("[{elapsed:>6.1}s] #{frames} 非 JSON：{}", preview(&text));
                        continue;
                    };
                    let keys = v
                        .as_object()
                        .map(|o| o.keys().cloned().collect::<Vec<_>>())
                        .unwrap_or_default();
                    let log = v.get("build_log").and_then(|x| x.as_str());
                    if log.is_some() {
                        log_frames += 1;
                    }
                    println!(
                        "[{elapsed:>6.1}s] #{frames} keys={keys:?} build_log={}B code={:?} msg={:?}",
                        log.map(|s| s.len()).unwrap_or(0),
                        v.get("code").and_then(|c| c.as_i64()),
                        v.get("msg").and_then(|m| m.as_str()).unwrap_or("")
                    );
                    if let Some(s) = log {
                        println!("         尾部：{}", preview(&tail(s, 200)));
                    }
                    if v.get("code").and_then(|c| c.as_i64()) == Some(1) {
                        // code=1 **不是**「日志结束」，而是「这是一份新的全量日志快照」
                        // （页面端直接 .text() 覆盖）。旧实现把这里当成结束，
                        // 于是收到第一帧就断开——这就是「日志不更新」的根因。
                        // 所以这里**不** break，继续观察真实的推送节奏与关闭时机。
                    }
                }
                Message::Close(c) => {
                    println!("[{elapsed:>6.1}s] Close 帧：{c:?}");
                    break;
                }
                other => println!("[{elapsed:>6.1}s] 非文本帧：{other:?}"),
            },
        }
    }
    let _ = ws.close(None).await;
    Ok(())
}

/// 模拟**修复后**的应用逻辑：把每帧当全量快照、只取增量、按收尾行判定结束。
/// 不会写任何文件，纯计算 + 打印。
async fn simulate(
    url: &str,
    cookie: &str,
    task_id: i64,
    deploy_type: &str,
) -> Result<(), Box<dyn Error>> {
    println!("\n=== C. 模拟修复后的应用（全量快照 → 增量，按收尾行结束）===");
    // 模拟「前端/留存里已有内容」；修复后它 = 上一次快照
    let mut known = String::new();

    for round in 1..=5 {
        let mut snap_len = 0usize;
        let mut delta_len = 0usize;
        let mut complete = false;
        let seen = &mut known;
        let out = connect_and_stream(url, cookie, task_id, deploy_type, |snapshot| {
            snap_len = snapshot.len();
            delta_len = if snapshot.starts_with(seen.as_str()) {
                snapshot.len() - seen.len()
            } else {
                snapshot.len()
            };
            complete = log_is_complete(snapshot);
            *seen = snapshot.to_string();
            !complete
        })
        .await;

        match out {
            Ok(StreamEnd::Complete) => {
                println!("第 {round} 轮：快照 {snap_len}B，新增 {delta_len}B，含收尾行 → 报「已完成」并停止订阅");
                return Ok(());
            }
            Ok(StreamEnd::Rejected(msg)) => {
                println!("第 {round} 轮：服务端拒绝：{msg}（此前是否拿到过内容：{}）", !known.is_empty());
                return Ok(());
            }
            Ok(StreamEnd::Closed) => {
                println!("第 {round} 轮：快照 {snap_len}B，新增 {delta_len}B，连接被 reset");
            }
            Err(e) => println!("第 {round} 轮：连接出错：{e}"),
        }

        if delta_len == 0 {
            println!("   （没有新增内容 → 应用会退避并计入重试，不再重复落盘/推送）");
            return Ok(());
        }
    }
    Ok(())
}


#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    ensure_tls_provider();

    let mut args = std::env::args().skip(1);
    let Some(task_id) = args.next().and_then(|s| s.parse::<i64>().ok()) else {
        return Err("用法：cargo run --example probe_log_ws -- <taskId> [auto|docker] [秒数]".into());
    };
    let deploy_type = args.next().unwrap_or_else(|| "auto".to_string());
    let seconds: u64 = args.next().and_then(|s| s.parse().ok()).unwrap_or(30);

    // 用应用里保存的凭据登录（与应用同一套凭据文件）
    let credentials = store_from_app_data_dir()?;
    let (user, pass) = credentials
        .load()?
        .ok_or("没有已保存的凭据：请先在应用里登录并勾选「记住密码」")?;
    let base_url = std::env::var("ZZ_ITSM_BASE_URL")
        .unwrap_or_else(|_| "https://itsm.zhizhengroup.com".to_string());

    let client = HttpClient::new(&base_url);
    login_flow(&client, &user, &pass).await?;
    let cookie = client
        .cookie_header()
        .await
        .ok_or("登录后没有 cookie，无法订阅日志")?;

    println!("目标 {base_url}，任务 {task_id}（{deploy_type}），用户 {user}");
    println!(
        "cookie: {}",
        cookie
            .split(';')
            .map(|p| {
                let p = p.trim();
                match p.split_once('=') {
                    Some((k, v)) => format!("{k}(len={})", v.len()),
                    None => p.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    );

    let cookie_key = cookie_value(&cookie, "sessionid").unwrap_or_default();
    println!("cookie 里的 sessionid: {}", fingerprint(&cookie_key));

    // 页面里的 session_key：这才是服务端脚本 `BuildLogbutton` 会用的那个值
    let page = client.get("/deployment/deploy/task/", &[]).await?;
    let page_key = page_session_key(&page.body).unwrap_or_default();
    println!("页面里的 session_key: {}", fingerprint(&page_key));

    if page_key.is_empty() {
        println!(">>> 页面里没找到 session_key（页面结构可能变了），跳过交叉验证");
    } else if page_key == cookie_key {
        println!(">>> 两者一致：认证帧用 cookie 里的 sessionid 没问题");
    } else {
        println!(">>> ⚠️ 两者**不一致**：认证帧若用 cookie 里的值，服务端会拒绝订阅");
    }

    let url = format!(
        "{}/wssapp/",
        base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );

    dump_frames(
        "A. 原始帧观察（订阅后服务端会推什么、什么时候断）",
        &url,
        &cookie,
        task_id,
        &deploy_type,
        &cookie_key,
        seconds,
    )
    .await?;

    // 模拟修复后的应用逻辑（对已结束的任务最直观：应恰好一次快照后结束）
    simulate(&url, &cookie, task_id, &deploy_type).await?;

    if !page_key.is_empty() && page_key != cookie_key {
        dump_frames(
            "B. 改用页面里的 session_key",
            &url,
            &cookie,
            task_id,
            &deploy_type,
            &page_key,
            seconds,
        )
        .await?;
    }

    Ok(())
}
