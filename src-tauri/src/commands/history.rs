//! 历史日志：回看、导出、删除与保留策略。

use serde::Serialize;
use tauri::{AppHandle, Runtime, State};

use crate::error::AppError;
use crate::logs::store::{HistoryEntry, LogStore, Retention, TailLog};

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

/// 预览用的「只读末尾」：避免几十 MB 日志整段穿过 IPC、再同步解析卡死界面。
#[tauri::command]
pub async fn history_read_tail(
    store: State<'_, LogStore>,
    deploy_type: String,
    task_id: i64,
    max_bytes: Option<u64>,
) -> Result<Option<TailLog>, AppError> {
    // 下限保证还能看到有意义的末尾；上限防止前端传个天文数字绕过保护
    let max_bytes = max_bytes
        .unwrap_or(2 * 1024 * 1024)
        .clamp(64 * 1024, 16 * 1024 * 1024);
    store.read_tail(&deploy_type, task_id, max_bytes)
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

/// 校验导出目标路径。
///
/// dest 来自保存对话框（用户亲自选定的路径），但仍是本应用**唯一**能写任意
/// 位置的入口，所以再加一道限制：只允许日志后缀、且父目录必须已存在
/// （否则会"导出成功"但实际没落盘）。
fn validate_export_path(dest: &str) -> Result<(), AppError> {
    use std::path::Path;
    let path = Path::new(dest);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    if !matches!(ext.as_deref(), Some("log") | Some("txt")) {
        return Err(AppError::config("导出文件名需以 .log 或 .txt 结尾"));
    }
    let parent = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .ok_or_else(|| AppError::config("导出路径缺少目录"))?;
    if !parent.is_dir() {
        return Err(AppError::config("导出目录不存在"));
    }
    Ok(())
}

/// 导出日志正文。
///
/// 内容由前端传入（已剥离 ANSI）而不是在 Rust 侧读文件：
/// 剥离开销本来就要在读取端付一次，这里复用前端已经算好的文本，
/// 免得两边各写一份剥离逻辑、行为还可能不一致。
#[tauri::command]
pub async fn history_export(dest: String, content: String) -> Result<(), AppError> {
    validate_export_path(&dest)?;
    std::fs::write(&dest, content).map_err(|e| AppError::io(format!("导出日志失败：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_path_must_look_like_a_log_file() {
        // 不给任意扩展名开口子（避免被当成通用的"写任意文件"命令）
        assert!(validate_export_path("/tmp/a.sh").is_err());
        assert!(validate_export_path("/tmp/a").is_err());
        assert!(validate_export_path("a.log").is_err(), "相对路径没有目录，拒绝");
    }

    #[test]
    fn export_path_parent_must_exist() {
        let dir = tempfile::TempDir::new().unwrap();
        let ok = dir.path().join("out.log");
        assert!(validate_export_path(ok.to_str().unwrap()).is_ok());
        let missing = dir.path().join("nope").join("out.log");
        assert!(validate_export_path(missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn export_accepts_txt_too() {
        let dir = tempfile::TempDir::new().unwrap();
        let ok = dir.path().join("out.TXT");
        assert!(validate_export_path(ok.to_str().unwrap()).is_ok());
    }
}
