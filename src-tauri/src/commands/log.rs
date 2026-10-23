//! 构建日志会话：打开长连接、把日志块以事件推给前端、同时落盘留存。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::error::AppError;
use crate::logs::store::LogStore;
use crate::session::SessionState;
use crate::ws::log_socket::{StreamEnd, backoff_delay, connect_and_stream};

/// 与插件一致：初次连接失败后最多再重连 3 次（spec §4.3）
const MAX_RETRIES: u32 = 3;

/// 一条活跃的日志会话（一个打开的日志标签页对应一条）
struct LogSession {
    /// 用 AbortHandle 而不是 JoinHandle：JoinHandle 交给回收任务 await，
    /// 这里只需要"能取消"这一个能力。
    handle: AbortHandle,
}

/// 所有活跃日志会话。用 Arc 包一层，方便 spawn 出去的任务持有同一份。
#[derive(Default, Clone)]
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
    /// 服务端换了窗口（快照不再包含前端已有内容）→ 前端先清空再追加
    reset: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogStatus {
    session_id: String,
    state: &'static str,
    /// 失败时服务端的原话（例：`数据格式错误`），前端直接展示，不再把错误吞掉
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

fn emit_status<R: Runtime>(
    app: &AppHandle<R>,
    session_id: &str,
    state: &'static str,
    detail: Option<String>,
) {
    let _ = app.emit(
        "log://status",
        LogStatus {
            session_id: session_id.to_string(),
            state,
            detail,
        },
    );
}

/// 服务端推的是**全量快照**，所以只需取「比已知内容多出来的那段」。
///
/// - 快照以旧内容为前缀（最常见：日志在增长）→ 尾部增量
/// - 旧内容反而是快照的前缀（本地留存更长）→ 没有新内容
/// - 两者对不上（服务端换了窗口）→ 整段当新内容，并标记 `reset`
fn snapshot_delta<'a>(known: &str, snapshot: &'a str) -> (&'a str, bool) {
    if let Some(rest) = snapshot.strip_prefix(known) {
        (rest, false)
    } else if known.starts_with(snapshot) {
        ("", false)
    } else {
        (snapshot, true)
    }
}

/// 单次 `log://data` 事件的目标大小。
///
/// 服务端一份快照可能是几十 MB（老任务的完整日志）。整段塞进一个事件，
/// WebView 要在主线程一次性接住并解析，界面会直接卡住；拆成小块后，
/// 每块都小到可以在一帧内处理完，前端还能在两块之间渲染。
const EMIT_SLICE: usize = 64 * 1024;

/// 按 UTF-8 字符边界切一刀（不能把中文/emoji 切成半个）
fn split_utf8_at(s: &str, max: usize) -> (&str, &str) {
    if s.len() <= max {
        return (s, "");
    }
    let mut cut = max;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    (&s[..cut], &s[cut..])
}

/// 把增量拆片后依次发事件；`reset` 只跟着第一片。
fn emit_data<R: Runtime>(app: &AppHandle<R>, session_id: &str, chunk: &str, reset: bool) {
    if chunk.is_empty() {
        if reset {
            let _ = app.emit(
                "log://data",
                LogData {
                    session_id: session_id.to_string(),
                    chunk: String::new(),
                    reset: true,
                },
            );
        }
        return;
    }

    let mut rest = chunk;
    let mut first = true;
    loop {
        let (piece, tail) = split_utf8_at(rest, EMIT_SLICE);
        let _ = app.emit(
            "log://data",
            LogData {
                session_id: session_id.to_string(),
                chunk: piece.to_string(),
                reset: reset && first,
            },
        );
        first = false;
        if tail.is_empty() {
            break;
        }
        rest = tail;
    }
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
    // 先确认会话可用再落索引：否则未登录时的失败调用也会在历史里
    // 留下一条 size=0 的空记录
    let client = session.client().await;
    let cookie = client
        .cookie_header()
        .await
        .ok_or_else(|| AppError::auth("没有可用会话，请重新登录"))?;
    let base_url = client.base_url().to_string();
    drop(client);

    // 只有被主动打开过的任务才落盘
    store.note_open(&deploy_type, task_id, &project_name, &env_name)?;

    let url = format!(
        "{}/wssapp/",
        base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://")
    );

    let session_id = sessions.alloc_id();
    let sid = session_id.clone();
    let app_for_task = app.clone();
    let store_for_task = store.clone_for_task();
    let dt = deploy_type.clone();
    let sessions_inner = sessions.inner.clone();

    let handle = tauri::async_runtime::spawn(async move {
        // 落盘增量与「推给前端的增量」分开维护：
        // 文件里可能已经有上一次订阅留下的内容（同一任务再打开一次），不能再追加一遍；
        // 而前端会话总是从空开始（重开标签就是新的 buffer）。
        // 两者的对比基准都是「服务端上一次推的全量快照」。
        let mut file_last = store_for_task
            .read(&dt, task_id)
            .ok()
            .flatten()
            .unwrap_or_default();
        let mut ui_last = String::new();
        let mut got_any = false;
        let mut attempt = 0u32;
        let mut last_error = String::new();

        loop {
            let mut new_this_attempt = false;

            let on_snapshot = {
                let app = app_for_task.clone();
                let sid = sid.clone();
                let store = store_for_task.clone();
                let dt = dt.clone();
                let file_last = &mut file_last;
                let ui_last = &mut ui_last;
                let got_any = &mut got_any;
                let new_this_attempt = &mut new_this_attempt;
                move |snapshot: &str| -> bool {
                    *got_any = true;

                    // 落盘：只追加新增那一段（快照是全量，直接 append 会把同一段日志写很多遍）
                    let (file_chunk, _) = snapshot_delta(file_last, snapshot);
                    if !file_chunk.is_empty() {
                        let _ = store.append(&dt, task_id, file_chunk);
                    }

                    // 推给前端：同样只发增量，并告知是否需要先清空（服务端换窗口时）
                    let (chunk, reset) = snapshot_delta(ui_last, snapshot);
                    if !chunk.is_empty() || reset {
                        *new_this_attempt = true;
                        emit_data(&app, &sid, chunk, reset);
                    }

                    *file_last = snapshot.to_string();
                    *ui_last = snapshot.to_string();

                    // 快照里已经有收尾行 → 日志写完，停止订阅（返回 false）
                    !crate::ws::log_socket::log_is_complete(snapshot)
                }
            };

            let outcome =
                connect_and_stream(&url, &cookie, task_id, &dt, on_snapshot).await;

            match outcome {
                // 日志已写完
                Ok(StreamEnd::Complete) => {
                    emit_status(&app_for_task, &sid, "finished", None);
                    break;
                }
                // 服务端明确拒绝：重连没有意义
                Ok(StreamEnd::Rejected(msg)) => {
                    if got_any {
                        // 已经拿到快照（只是它没含收尾行）→ 当结束处理，不报错
                        emit_status(&app_for_task, &sid, "finished", None);
                    } else {
                        // 实测：构建已结束且服务端不再持有该日志时，回的就是
                        // {"code":0,"msg":"数据格式错误"}——把原话透给用户
                        emit_status(&app_for_task, &sid, "error", Some(msg));
                    }
                    break;
                }
                Ok(StreamEnd::Closed) => {
                    // 服务端推完快照会直接 reset，所以这里不代表出错。
                    // 只要这次拿到了新内容就说明它在持续输出，重连继续跟（上限另算）
                }
                Err(e) => last_error = e.message,
            }

            // 有新内容 → 把重试计数归零，长时间构建偶尔断线也能接着跟；
            // 什么都没新增（例如订阅一个已结束的任务）才计数，避免无限重连
            if new_this_attempt {
                attempt = 0;
            } else {
                attempt += 1;
            }

            if attempt > MAX_RETRIES {
                if got_any {
                    // 内容已经不长了，也没报错，就当它结束（比假报错合理）
                    emit_status(&app_for_task, &sid, "finished", None);
                } else {
                    let detail = if last_error.is_empty() { None } else { Some(last_error) };
                    emit_status(&app_for_task, &sid, "error", detail);
                }
                break;
            }

            emit_status(&app_for_task, &sid, "disconnected", None);
            // 有新内容说明构建还在输出，只是这条连接被服务端 reset 了：
            // 立刻重连继续跟（重连是幂等的：快照会被比对掉，不会重复推送/落盘）；
            // 没新内容则是真的没得可读，走退避并计入重试次数。
            let delay = if new_this_attempt {
                Duration::from_millis(500)
            } else {
                backoff_delay(attempt)
            };
            tokio::time::sleep(delay).await;
        }
    });

    // 先注册再等：注册必须在 spawn 之后（handle 来自 spawn），
    // 但清理不能写在任务体内——任务可能在注册完成前就结束，
    // 那样 remove 会落空、留下永远清不掉的死会话。
    // 所以交给下面的独立回收任务在 JoinHandle 结束后清理。
    // `tauri::async_runtime::JoinHandle` 只暴露 `inner()`/`abort()`，
    // 而 JoinHandle 本身要交给回收任务 await，所以取它的 AbortHandle 存进表里。
    let abort = handle.inner().abort_handle();
    let active = {
        let mut map = sessions.inner.lock().await;
        map.insert(session_id.clone(), LogSession { handle: abort });
        map.len()
    };
    // 托盘上显示进行中的构建数（spec §6.1）；放到锁外调用，避免持锁做 UI 操作
    crate::tray::set_active_builds(&app, active);

    let reaper = sessions_inner;
    let sid_for_reaper = session_id.clone();
    let app_for_reaper = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = handle.await;
        let active = {
            let mut map = reaper.lock().await;
            map.remove(&sid_for_reaper);
            map.len()
        };
        crate::tray::set_active_builds(&app_for_reaper, active);
    });

    Ok(session_id)
}

/// 关闭日志标签页时调用：中止后台任务，停止落盘
#[tauri::command]
pub async fn log_close<R: Runtime>(
    app: AppHandle<R>,
    sessions: State<'_, LogSessions>,
    session_id: String,
) -> Result<(), AppError> {
    // 先把要 abort 的取出来，避免把锁带进后面的 lock()（tokio 的 Mutex 不可重入）
    let removed = sessions.inner.lock().await.remove(&session_id);
    if let Some(s) = removed {
        s.handle.abort();
    }
    let active = sessions.inner.lock().await.len();
    crate::tray::set_active_builds(&app, active);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{snapshot_delta, split_utf8_at};

    /// 服务端每次推全量快照，落盘/推前端只能取增量。
    /// 没有这层，重复订阅（重试、重开标签）会把同一段日志写很多遍——
    /// 实测留痕文件里就有同一份 86KB 日志被写了 4 遍。
    #[test]
    fn delta_is_the_tail_when_snapshot_grows() {
        let (chunk, reset) = snapshot_delta("line1\n", "line1\nline2\n");
        assert_eq!(chunk, "line2\n");
        assert!(!reset);
    }

    #[test]
    fn delta_is_empty_when_nothing_new() {
        let (chunk, reset) = snapshot_delta("same\n", "same\n");
        assert_eq!(chunk, "");
        assert!(!reset);

        // 本地留存反而更长（上次订阅拿到过更多）→ 没有新内容
        let (chunk, reset) = snapshot_delta("a\nb\nc\n", "a\n");
        assert_eq!(chunk, "");
        assert!(!reset);
    }

    /// 快照与已知内容对不上（服务端换了窗口）→ 整段当新内容，并让前端先清空
    #[test]
    fn mismatched_snapshot_is_flagged_as_reset() {
        let (chunk, reset) = snapshot_delta("old-a\nold-b\n", "new-a\nnew-b\n");
        assert_eq!(chunk, "new-a\nnew-b\n");
        assert!(reset);
    }

    #[test]
    fn split_utf8_never_cuts_a_multibyte_char() {
        // 每个汉字 3 字节，切点落在字符中间时必须回退到边界
        let s = "中文日志内容";
        let (a, b) = split_utf8_at(s, 4);
        assert_eq!(a, "中");
        assert_eq!(b, "文日志内容");
        assert_eq!(format!("{a}{b}"), s);
    }

    #[test]
    fn split_utf8_returns_whole_string_when_smaller() {
        let (a, b) = split_utf8_at("abc", 10);
        assert_eq!(a, "abc");
        assert_eq!(b, "");
    }
}
