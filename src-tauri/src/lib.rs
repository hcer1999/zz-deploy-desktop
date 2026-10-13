// 命令与模块在后续 Task 中逐个加入。
// 参见 docs/superpowers/plans/2026-10-13-plan1-scaffold-and-auth.md

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
