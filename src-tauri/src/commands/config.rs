use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

pub const DEFAULT_BASE_URL: &str = "https://itsm.zhizhengroup.com";
const STORE_FILE: &str = "config.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    pub base_url: String,
    /// "system" | "dark" | "light"
    pub theme: String,
    pub username: String,
    /// 关闭窗口行为："tray" | "quit"
    pub close_behavior: String,
    pub poll_interval_secs: u32,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            theme: "system".to_string(),
            username: String::new(),
            close_behavior: "tray".to_string(),
            poll_interval_secs: 60,
        }
    }
}

/// 只接受已知取值，防止配置文件被手改成无效值后行为诡异
fn normalize_theme(v: &str) -> String {
    match v {
        "dark" | "light" | "system" => v.to_string(),
        _ => "system".to_string(),
    }
}

fn normalize_close_behavior(v: &str) -> String {
    match v {
        "tray" | "quit" => v.to_string(),
        _ => "tray".to_string(),
    }
}

pub fn load<R: Runtime>(app: &AppHandle<R>) -> Result<AppConfig, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开配置存储失败：{e}")))?;

    let get_str = |key: &str| -> Option<String> {
        store
            .get(key)
            .and_then(|v| v.as_str().map(|s| s.to_string()))
    };

    let mut cfg = AppConfig::default();
    if let Some(v) = get_str("baseUrl") {
        cfg.base_url = v.trim_end_matches('/').to_string();
    }
    if let Some(v) = get_str("theme") {
        cfg.theme = normalize_theme(&v);
    }
    if let Some(v) = get_str("username") {
        cfg.username = v;
    }
    if let Some(v) = get_str("closeBehavior") {
        cfg.close_behavior = normalize_close_behavior(&v);
    }
    if let Some(v) = store.get("pollIntervalSecs").and_then(|v| v.as_u64()) {
        cfg.poll_interval_secs = v.clamp(10, 3600) as u32;
    }
    Ok(cfg)
}

pub fn save<R: Runtime>(app: &AppHandle<R>, cfg: &AppConfig) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开配置存储失败：{e}")))?;
    store.set(
        "baseUrl",
        serde_json::json!(cfg.base_url.trim_end_matches('/')),
    );
    store.set("theme", serde_json::json!(normalize_theme(&cfg.theme)));
    store.set("username", serde_json::json!(cfg.username));
    store.set(
        "closeBehavior",
        serde_json::json!(normalize_close_behavior(&cfg.close_behavior)),
    );
    store.set(
        "pollIntervalSecs",
        serde_json::json!(cfg.poll_interval_secs),
    );
    store
        .save()
        .map_err(|e| AppError::config(format!("写入配置失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn config_get<R: Runtime>(app: AppHandle<R>) -> Result<AppConfig, AppError> {
    load(&app)
}

#[tauri::command]
pub async fn config_set<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, crate::session::SessionState>,
    patch: AppConfig,
) -> Result<AppConfig, AppError> {
    let previous = load(&app)?;
    save(&app, &patch)?;
    // 地址变了就重建客户端：旧 Cookie 对新域名无意义，必须丢弃
    if previous.base_url != patch.base_url {
        session.rebuild_client(&patch.base_url).await;
    }
    load(&app)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_theme_falls_back_to_system() {
        assert_eq!(normalize_theme("neon"), "system");
        assert_eq!(normalize_theme("dark"), "dark");
    }

    #[test]
    fn invalid_close_behavior_falls_back_to_tray() {
        assert_eq!(normalize_close_behavior("explode"), "tray");
        assert_eq!(normalize_close_behavior("quit"), "quit");
    }

    #[test]
    fn default_config_points_at_itsm() {
        assert_eq!(AppConfig::default().base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn config_serializes_with_camel_case_keys() {
        let v = serde_json::to_value(AppConfig::default()).unwrap();
        assert!(v.get("baseUrl").is_some());
        assert!(v.get("pollIntervalSecs").is_some());
        assert!(v.get("closeBehavior").is_some());
    }

    #[test]
    fn config_round_trips_through_json() {
        let original = AppConfig {
            base_url: "https://example.com".to_string(),
            theme: "dark".to_string(),
            username: "zhangsan".to_string(),
            close_behavior: "quit".to_string(),
            poll_interval_secs: 120,
        };
        let text = serde_json::to_string(&original).unwrap();
        let back: AppConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.base_url, original.base_url);
        assert_eq!(back.theme, original.theme);
        assert_eq!(back.poll_interval_secs, original.poll_interval_secs);
    }
}
