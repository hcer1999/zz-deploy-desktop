pub mod commands;
pub mod error;
pub mod logs;
pub mod net;
pub mod secure;
pub mod session;
pub mod tray;
pub mod ws;

use tauri::{Emitter, Manager};

use commands::auth::try_silent_login;
use session::SessionState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("无法解析应用数据目录");
            std::fs::create_dir_all(&app_data_dir).ok();

            let handle = app.handle().clone();
            let cfg = commands::config::load(&handle)?;
            let credentials = secure::detect_store(&app_data_dir);
            let state = SessionState::new(&cfg.base_url, credentials);

            // 续登失败要通过事件告知前端；这里建广播通道并由后台任务转发
            let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
            state.set_expired_sender(tx.clone());
            app.manage(state);

            // 构建日志：本地留存 + 活跃会话表
            app.manage(crate::logs::store::LogStore::new(
                crate::logs::store::logs_root(&app_data_dir),
            ));
            app.manage(commands::log::LogSessions::new());

            let mut rx = tx.subscribe();
            let emit_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                while let Ok(msg) = rx.recv().await {
                    let _ = emit_handle.emit("auth://expired", msg);
                }
            });

            // 启动时尝试用钥匙串里的凭据静默续登；无论成败都通知前端可以刷新状态了
            let login_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = login_handle.state::<SessionState>();
                let _ = try_silent_login(&login_handle.clone(), &state).await;
                let _ = login_handle.emit("auth://ready", ());
            });

            // 常驻托盘
            crate::tray::setup(app.handle())?;

            // 关闭窗口的默认行为是"关闭到托盘"而不是退出（设置页可改为直接退出）
            register_close_behavior(app);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::config_get,
            commands::config::config_set,
            commands::auth::auth_status,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_relogin,
            commands::auth::auth_forget_credentials,
            commands::auth::set_base_url,
            commands::favorites::favorites_list,
            commands::favorites::favorites_save,
            commands::favorites::favorites_delete,
            commands::favorites::favorites_reorder,
            net::command::http_request,
            commands::log::log_open,
            commands::log::log_close,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}

/// 拦截主窗口关闭请求：配置为 "tray" 时改成隐藏窗口，应用留在托盘。
///
/// 每次关闭都重新读配置，用户在设置页改完立刻生效。
fn register_close_behavior<R: tauri::Runtime>(app: &tauri::App<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let handle = app.handle().clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            let behavior = commands::config::load(&handle)
                .map(|c| c.close_behavior)
                .unwrap_or_else(|_| "tray".to_string());
            if behavior == "tray" {
                api.prevent_close();
                if let Some(w) = handle.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
        }
    });
}
