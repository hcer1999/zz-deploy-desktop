pub mod commands;
pub mod error;
pub mod net;
pub mod secure;
pub mod session;

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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::config_get,
            commands::config::config_set,
            commands::auth::auth_status,
            commands::auth::auth_login,
            commands::auth::auth_logout,
            commands::auth::auth_relogin,
            commands::auth::set_base_url,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
