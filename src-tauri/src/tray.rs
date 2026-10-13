//! 常驻系统托盘。
//!
//! 托盘菜单只负责"显示窗口"和把命令**以事件转给前端**——
//! Rust 不知道"标签""向导"这些概念（spec §1 的分层原则）。

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::AppError;

/// 创建常驻托盘。没有可用图标时只告警不阻断启动——托盘是增强功能，
/// 不该因为它让整个应用起不来。
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> Result<(), AppError> {
    let Some(icon) = app.default_window_icon().cloned() else {
        eprintln!("创建托盘跳过：应用没有可用图标");
        return Ok(());
    };

    let item = |id: &str, text: &str| {
        MenuItem::with_id(app, id, text, true, None::<&str>)
            .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))
    };
    let show = item("show", "显示主窗口")?;
    let new_deploy = item("new_deploy", "新建部署")?;
    let task_list = item("task_list", "任务列表")?;
    let sep = PredefinedMenuItem::separator(app)
        .map_err(|e| AppError::config(format!("创建分隔线失败：{e}")))?;
    let quit = item("quit", "退出")?;

    let menu = Menu::with_items(app, &[&show, &new_deploy, &task_list, &sep, &quit])
        .map_err(|e| AppError::config(format!("创建托盘菜单失败：{e}")))?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("至真部署")
        .menu(&menu)
        // 左键点击托盘图标显示主窗口（macOS 上习惯用右键出菜单）
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "quit" => app.exit(0),
            "show" => reveal_main(app),
            // 这两项交给前端开对应标签
            "new_deploy" => {
                reveal_main(app);
                let _ = app.emit("tray://command", "new_deploy");
            }
            "task_list" => {
                reveal_main(app);
                let _ = app.emit("tray://command", "task_list");
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // 左键单击（非 macOS 上常见）：显示窗口
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|e| AppError::config(format!("创建托盘失败：{e}")))?;

    Ok(())
}

/// 显示并聚焦主窗口（可能被隐藏在托盘里）
pub fn reveal_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
