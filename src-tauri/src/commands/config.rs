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
    /// 日志留存天数（spec §6.3，默认 30）
    pub log_retention_days: u64,
    /// 日志留存条数上限（spec §6.3，默认 500）
    pub log_retention_entries: usize,
    /// 构建完成通知的触发条件："always"（默认：不管窗口是否在前台都弹）
    /// | "unfocused"（仅窗口失焦时）（spec §6.2）
    pub notify_mode: String,
    /// 侧边栏是否展开（仅 UI 布局偏好，但和其它设置一起放 config.json，重启后保持）
    pub sidebar_expanded: bool,
    /// 上次在向导里用的部署类型（"auto" | "docker"）：下次打开向导预填
    pub last_deploy_type: String,
    /// 上次在向导里选的环境 id：下次打开向导预填。None = 还没选过（首次运行不预填）
    pub last_env_id: Option<u32>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            theme: "system".to_string(),
            username: String::new(),
            close_behavior: "tray".to_string(),
            poll_interval_secs: 60,
            log_retention_days: 30,
            log_retention_entries: 500,
            notify_mode: "always".to_string(),
            sidebar_expanded: false,
            last_deploy_type: "auto".to_string(),
            last_env_id: None,
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

/// 保留策略只接受合理区间：0 天 / 0 条会在启动清理时把日志全删光，
/// 而不设上界则等于允许把磁盘写爆。
fn clamp_retention_days(v: u64) -> u64 {
    v.clamp(1, 3650)
}

fn clamp_retention_entries(v: u64) -> usize {
    v.clamp(1, 10_000) as usize
}

fn normalize_notify_mode(v: &str) -> String {
    match v {
        "always" | "unfocused" => v.to_string(),
        // 无效值回退到默认值
        _ => "always".to_string(),
    }
}

fn normalize_deploy_type(v: &str) -> String {
    match v {
        "auto" | "docker" => v.to_string(),
        _ => "auto".to_string(),
    }
}

/// 环境 id 的合法集合（与前端 `api/deploy.ts` 的 ENVS 一致，spec §5.4 明确硬编码）。
/// 不在集合里的值一律当「没选过」，而不是让向导拿着一个不存在的环境去预填。
fn normalize_env_id(v: u64) -> Option<u32> {
    const VALID: [u32; 9] = [1, 2, 4, 7, 8, 9, 11, 12, 14];
    let v = u32::try_from(v).ok()?;
    VALID.contains(&v).then_some(v)
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
    if let Some(v) = store.get("logRetentionDays").and_then(|v| v.as_u64()) {
        cfg.log_retention_days = clamp_retention_days(v);
    }
    if let Some(v) = store.get("logRetentionEntries").and_then(|v| v.as_u64()) {
        cfg.log_retention_entries = clamp_retention_entries(v);
    }
    if let Some(v) = get_str("notifyMode") {
        cfg.notify_mode = normalize_notify_mode(&v);
    }
    if let Some(v) = store.get("sidebarExpanded").and_then(|v| v.as_bool()) {
        cfg.sidebar_expanded = v;
    }
    if let Some(v) = get_str("lastDeployType") {
        cfg.last_deploy_type = normalize_deploy_type(&v);
    }
    if let Some(v) = store.get("lastEnvId").and_then(|v| v.as_u64()) {
        cfg.last_env_id = normalize_env_id(v);
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
    store.set(
        "logRetentionDays",
        serde_json::json!(clamp_retention_days(cfg.log_retention_days)),
    );
    store.set(
        "logRetentionEntries",
        serde_json::json!(clamp_retention_entries(
            cfg.log_retention_entries as u64
        )),
    );
    store.set(
        "notifyMode",
        serde_json::json!(normalize_notify_mode(&cfg.notify_mode)),
    );
    store.set(
        "sidebarExpanded",
        serde_json::json!(cfg.sidebar_expanded),
    );
    store.set(
        "lastDeployType",
        serde_json::json!(normalize_deploy_type(&cfg.last_deploy_type)),
    );
    store.set("lastEnvId", serde_json::json!(cfg.last_env_id));
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
        let d = AppConfig::default();
        assert_eq!(d.base_url, DEFAULT_BASE_URL);
        assert_eq!(d.log_retention_days, 30);
        assert_eq!(d.log_retention_entries, 500);
        // 默认折叠，保持与历史外观一致
        assert!(!d.sidebar_expanded);
    }

    #[test]
    fn retention_bounds_are_clamped() {
        // 0 或极大会在启动清理时造成误删 / 磁盘写爆，必须夹住
        assert_eq!(clamp_retention_days(0), 1);
        assert_eq!(clamp_retention_days(99999), 3650);
        assert_eq!(clamp_retention_days(30), 30);
        assert_eq!(clamp_retention_entries(0), 1);
        assert_eq!(clamp_retention_entries(99999), 10_000);
    }

    #[test]
    fn default_notify_mode_is_always() {
        assert_eq!(AppConfig::default().notify_mode, "always");
    }

    #[test]
    fn invalid_notify_mode_falls_back_to_default() {
        assert_eq!(normalize_notify_mode("whenever"), "always");
        assert_eq!(normalize_notify_mode("always"), "always");
        // 显式选了「仅失焦」要保留，不能被回退掉
        assert_eq!(normalize_notify_mode("unfocused"), "unfocused");
    }

    #[test]
    fn config_serializes_with_camel_case_keys() {
        let v = serde_json::to_value(AppConfig::default()).unwrap();
        assert!(v.get("baseUrl").is_some());
        assert!(v.get("pollIntervalSecs").is_some());
        assert!(v.get("closeBehavior").is_some());
        assert!(v.get("logRetentionDays").is_some());
        assert!(v.get("logRetentionEntries").is_some());
        assert!(v.get("notifyMode").is_some());
        assert_eq!(v["sidebarExpanded"], serde_json::json!(false));
    }

    #[test]
    fn config_round_trips_through_json() {
        let original = AppConfig {
            base_url: "https://example.com".to_string(),
            theme: "dark".to_string(),
            username: "zhangsan".to_string(),
            close_behavior: "quit".to_string(),
            poll_interval_secs: 120,
            log_retention_days: 7,
            log_retention_entries: 42,
            notify_mode: "always".to_string(),
            sidebar_expanded: true,
            last_deploy_type: "docker".to_string(),
            last_env_id: Some(4),
        };
        let text = serde_json::to_string(&original).unwrap();
        let back: AppConfig = serde_json::from_str(&text).unwrap();
        assert_eq!(back.base_url, original.base_url);
        assert_eq!(back.theme, original.theme);
        assert_eq!(back.poll_interval_secs, original.poll_interval_secs);
        assert_eq!(back.log_retention_days, 7);
        assert_eq!(back.log_retention_entries, 42);
        assert_eq!(back.notify_mode, "always");
        assert!(back.sidebar_expanded);
        assert_eq!(back.last_deploy_type, "docker");
        assert_eq!(back.last_env_id, Some(4));
    }

    #[test]
    fn last_choice_defaults_to_nothing() {
        // 首次运行不该预填环境：null 才代表"还没选过"
        let cfg = AppConfig::default();
        assert_eq!(cfg.last_deploy_type, "auto");
        assert_eq!(cfg.last_env_id, None);
    }

    #[test]
    fn only_known_env_ids_survive() {
        assert_eq!(normalize_env_id(1), Some(1));
        assert_eq!(normalize_env_id(14), Some(14));
        // 服务端环境列表是硬编码的；配置被手改成不存在的 id 就当没选过
        assert_eq!(normalize_env_id(3), None);
        assert_eq!(normalize_env_id(999), None);
        assert_eq!(normalize_deploy_type("docker"), "docker");
        assert_eq!(normalize_deploy_type("whatever"), "auto");
    }
}
