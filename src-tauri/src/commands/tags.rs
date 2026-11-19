use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::commands::{batch_favorites, favorites};
use crate::error::AppError;

/**
 * 全局标签表：标签名 → 颜色。
 *
 * 为什么颜色不跟着每条收藏存：同名标签在收藏页、批量页、筛选条里必须同色，
 * 每条各存一份颜色迟早出现「同一个『线上』三种红」。改一次颜色全局生效。
 *
 * 存储位置与收藏同一个文件（favorites.json 的 `tags` 键）：两者经常一起读写，
 * 分文件只会多一次失败点。
 */
const STORE_FILE: &str = "favorites.json";
const TAGS_KEY: &str = "tags";

/// 10 色预设。深浅主题下都能看清，且互相之间可区分。
/// ⚠️ 与 `src/stores/tags.ts` 的 PALETTE 必须同值（前端只用于兜底着色）。
const PALETTE: [&str; 10] = [
    "#94a3b8", "#f87171", "#fb923c", "#fbbf24", "#34d399", "#2dd4bf", "#38bdf8", "#818cf8",
    "#a78bfa", "#f472b6",
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TagDef {
    pub name: String,
    /// `#rrggbb`（小写）
    pub color: String,
}

/// 未登记颜色时的默认色：按名字稳定取一个，保证同名同色。
pub fn default_color(name: &str) -> &'static str {
    let sum: usize = name.bytes().map(|b| b as usize).sum();
    PALETTE[sum % PALETTE.len()]
}

/// 校验颜色，非法值回退默认色。只接受 `#RRGGBB`。
pub fn normalize_color(input: &str, name: &str) -> String {
    let v = input.trim();
    let valid = v.len() == 7
        && v.starts_with('#')
        && v[1..].chars().all(|c| c.is_ascii_hexdigit());
    if valid {
        v.to_ascii_lowercase()
    } else {
        default_color(name).to_string()
    }
}

/// 标签名规范化：去首尾空白、不超过 24 字、不能为空。
pub fn normalize_name(name: &str) -> Result<String, AppError> {
    let n = name.trim();
    if n.is_empty() {
        return Err(AppError::config("标签名不能为空"));
    }
    if n.chars().count() > 24 {
        return Err(AppError::config("标签名最多 24 个字"));
    }
    Ok(n.to_string())
}

/// 新增 / 改色 / 改名。返回新的整张表（调用方直接回给前端替换本地状态）。
///
/// - 带 `old_name` 且存在 → 改名（颜色沿用或更新为传入的 color）
/// - 同名已存在 → 只改颜色
/// - 否则追加
pub fn upsert_tag(
    list: &mut Vec<TagDef>,
    old_name: Option<&str>,
    name: &str,
    color: &str,
) -> Vec<TagDef> {
    let name = name.trim().to_string();
    let color = normalize_color(color, &name);

    // 改名：把旧名那条摘掉，再用新名走下面的"已存在/追加"逻辑
    if let Some(old) = old_name.map(str::trim).filter(|o| !o.is_empty() && *o != name) {
        list.retain(|t| t.name != old);
    }

    match list.iter_mut().find(|t| t.name == name) {
        Some(existing) => existing.color = color,
        None => list.push(TagDef { name, color }),
    }
    list.clone()
}

/// 删除一个标签定义（收藏里的引用由命令层级联清理）
pub fn remove_tag(list: &mut Vec<TagDef>, name: &str) {
    list.retain(|t| t.name != name);
}

fn load_tags<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<TagDef>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    match store.get(TAGS_KEY) {
        Some(v) => serde_json::from_value(v)
            .map_err(|e| AppError::config(format!("标签数据已损坏：{e}"))),
        None => Ok(Vec::new()),
    }
}

fn save_tags<R: Runtime>(app: &AppHandle<R>, list: &[TagDef]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    store.set(
        TAGS_KEY,
        serde_json::to_value(list).map_err(|e| AppError::config(format!("序列化标签失败：{e}")))?,
    );
    store
        .save()
        .map_err(|e| AppError::config(format!("写入标签失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn tags_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<TagDef>, AppError> {
    load_tags(&app)
}

/**
 * 新增 / 改色 / 改名。
 *
 * 改名必须同时改掉两条收藏（单条 + 批量）里引用的旧名，否则收藏里会留下
 * 指向不存在的标签名的悬空引用（前端只能以灰色兜底）。
 */
#[tauri::command]
pub async fn tags_upsert<R: Runtime>(
    app: AppHandle<R>,
    old_name: Option<String>,
    name: String,
    color: String,
) -> Result<Vec<TagDef>, AppError> {
    let name = normalize_name(&name)?;
    let mut list = load_tags(&app)?;

    let renaming = old_name
        .as_deref()
        .map(str::trim)
        .filter(|o| !o.is_empty() && *o != name);

    if let Some(old) = renaming {
        let mut favs = favorites::load_all(&app)?;
        favorites::rename_tag(&mut favs, old, &name);
        favorites::save_all(&app, &favs)?;

        let mut batch = batch_favorites::load_all(&app)?;
        batch_favorites::rename_tag(&mut batch, old, &name);
        batch_favorites::save_all(&app, &batch)?;
    }

    let out = upsert_tag(&mut list, renaming, &name, &color);
    save_tags(&app, &out)?;
    Ok(out)
}

/// 删除标签，并从两条收藏里级联摘掉这个名字。
#[tauri::command]
pub async fn tags_delete<R: Runtime>(app: AppHandle<R>, name: String) -> Result<Vec<TagDef>, AppError> {
    let name = name.trim().to_string();
    let mut list = load_tags(&app)?;
    remove_tag(&mut list, &name);
    save_tags(&app, &list)?;

    let mut favs = favorites::load_all(&app)?;
    favorites::strip_tag(&mut favs, &name);
    favorites::save_all(&app, &favs)?;

    let mut batch = batch_favorites::load_all(&app)?;
    batch_favorites::strip_tag(&mut batch, &name);
    batch_favorites::save_all(&app, &batch)?;

    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_color_is_stable_and_hex() {
        let a = default_color("线上");
        let b = default_color("线上");
        assert_eq!(a, b);
        assert!(a.starts_with('#') && a.len() == 7);
        assert!(a[1..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn default_color_spreads_names_across_the_palette() {
        let used: std::collections::HashSet<&str> =
            ["线上", "测试", "紧急", "周五", "回滚", "灰度", "热修"].iter().map(|n| default_color(n)).collect();
        assert!(used.len() > 1, "不同名字不应全部落到同一个颜色上");
    }

    #[test]
    fn normalize_color_rejects_non_hex_and_lowercases() {
        assert_eq!(normalize_color("red", "线上"), default_color("线上"));
        assert_eq!(normalize_color("#12abEF", "线上"), "#12abef");
        assert_eq!(normalize_color("#12345", "线上"), default_color("线上"));
        assert_eq!(normalize_color("", "线上"), default_color("线上"));
    }

    #[test]
    fn normalize_name_trims_and_limits() {
        assert_eq!(normalize_name("  x  ").unwrap(), "x");
        assert!(normalize_name("   ").is_err());
        assert!(normalize_name(&"长".repeat(25)).is_err());
        assert!(normalize_name(&"长".repeat(24)).is_ok());
    }

    #[test]
    fn upsert_adds_then_updates_color() {
        let mut list = Vec::new();
        upsert_tag(&mut list, None, "线上", "#f87171");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].color, "#f87171");

        upsert_tag(&mut list, None, "线上", "#34d399");
        assert_eq!(list.len(), 1, "同名只改颜色，不新增");
        assert_eq!(list[0].color, "#34d399");
    }

    #[test]
    fn upsert_renames_and_keeps_one_entry() {
        let mut list = Vec::new();
        upsert_tag(&mut list, None, "线上", "#f87171");
        upsert_tag(&mut list, Some("线上"), "生产", "#f87171");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "生产");
    }

    #[test]
    fn remove_tag_drops_only_that_name() {
        let mut list = Vec::new();
        upsert_tag(&mut list, None, "线上", "#f87171");
        upsert_tag(&mut list, None, "紧急", "#fbbf24");
        remove_tag(&mut list, "线上");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "紧急");
    }
}
