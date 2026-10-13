//! 历史日志：回看、导出、删除与保留策略。

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

/// 导出日志正文。
///
/// 内容由前端传入（已剥离 ANSI）而不是在 Rust 侧读文件：
/// 剥离开销本来就要在读取端付一次，这里复用前端已经算好的文本，
/// 免得两边各写一份剥离逻辑、行为还可能不一致。
#[tauri::command]
pub async fn history_export(dest: String, content: String) -> Result<(), AppError> {
    std::fs::write(&dest, content).map_err(|e| AppError::io(format!("导出日志失败：{e}")))
}
