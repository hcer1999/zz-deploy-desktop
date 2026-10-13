//! 构建日志会话：打开长连接、把日志块以事件推给前端、同时落盘留存。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

use crate::error::AppError;
use crate::logs::store::LogStore;
use crate::session::SessionState;
use crate::ws::log_socket::{LogEnd, backoff_delay, connect_and_stream};

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
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LogStatus {
    session_id: String,
    state: &'static str,
}

fn emit_status<R: Runtime>(app: &AppHandle<R>, session_id: &str, state: &'static str) {
    let _ = app.emit(
        "log://status",
        LogStatus {
            session_id: session_id.to_string(),
            state,
        },
    );
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
    // 只有被主动打开过的任务才落盘
    store.note_open(&deploy_type, task_id, &project_name, &env_name)?;

    let client = session.client().await;
    let cookie = client
        .cookie_header()
        .await
        .ok_or_else(|| AppError::auth("没有可用会话，请重新登录"))?;
    let base_url = client.base_url().to_string();
    drop(client);

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
        let mut attempt = 0u32;
        loop {
            // 本次连接是否收到了 code=1。Ok(()) 也可能只是"被干净地关掉"，
            // 必须靠这个标志区分，否则会把没写完的日志当成已结束（spec §4.3）。
            let saw_finish = Arc::new(AtomicBool::new(false));
            let fin = saw_finish.clone();

            let on_chunk = {
                let app = app_for_task.clone();
                let sid = sid.clone();
                let store = store_for_task.clone();
                let dt = dt.clone();
                move |chunk: String| {
                    // 落盘保留原始内容（未剥离 ANSI），显示时才剥离
                    let _ = store.append(&dt, task_id, &chunk);
                    let _ = app.emit(
                        "log://data",
                        LogData {
                            session_id: sid.clone(),
                            chunk,
                        },
                    );
                }
            };
            let on_end = move |end: LogEnd| {
                if end == LogEnd::Finished {
                    fin.store(true, Ordering::SeqCst);
                }
            };

            let result =
                connect_and_stream(&url, &cookie, task_id, &dt, on_chunk, on_end).await;

            if result.is_ok() && saw_finish.load(Ordering::SeqCst) {
                emit_status(&app_for_task, &sid, "finished");
                break;
            }

            if attempt >= MAX_RETRIES {
                emit_status(&app_for_task, &sid, "error");
                if let Err(e) = result {
                    eprintln!("日志连接最终失败：{e}");
                }
                break;
            }

            attempt += 1;
            emit_status(&app_for_task, &sid, "disconnected");
            tokio::time::sleep(backoff_delay(attempt)).await;
        }
    });

    // 先注册再等：注册必须在 spawn 之后（handle 来自 spawn），
    // 但清理不能写在任务体内——任务可能在注册完成前就结束，
    // 那样 remove 会落空、留下永远清不掉的死会话。
    // 所以交给下面的独立回收任务在 JoinHandle 结束后清理。
    // `tauri::async_runtime::JoinHandle` 只暴露 `inner()`/`abort()`，
    // 而 JoinHandle 本身要交给回收任务 await，所以取它的 AbortHandle 存进表里。
    let abort = handle.inner().abort_handle();
    sessions
        .inner
        .lock()
        .await
        .insert(session_id.clone(), LogSession { handle: abort });

    let reaper = sessions_inner;
    let sid_for_reaper = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let _ = handle.await;
        reaper.lock().await.remove(&sid_for_reaper);
    });

    Ok(session_id)
}

/// 关闭日志标签页时调用：中止后台任务，停止落盘
#[tauri::command]
pub async fn log_close(
    sessions: State<'_, LogSessions>,
    session_id: String,
) -> Result<(), AppError> {
    if let Some(s) = sessions.inner.lock().await.remove(&session_id) {
        s.handle.abort();
    }
    Ok(())
}
