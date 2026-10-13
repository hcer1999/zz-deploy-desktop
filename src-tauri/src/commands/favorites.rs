use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

const STORE_FILE: &str = "favorites.json";
const ITEMS_KEY: &str = "items";

/// 与插件 `src/favorites.ts` 的 Favorite 结构完全一致，
/// 这样从插件导出的收藏文件可以直接用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Favorite {
    pub id: String,
    /// "project"（只记项目）| "config"（项目 + 环境 + 分支）
    #[serde(rename = "type")]
    pub kind: String,
    /// "auto" | "docker"
    pub deploy_type: String,
    pub env_id: i64,
    pub env_name: String,
    pub project_id: i64,
    pub project_name: String,
    #[serde(default)]
    pub branch: Option<String>,
}

/// 去重键，与插件 `src/favorites.ts:46` 一致：
/// 同项目 + 同环境 + 同部署类型 + 同分支 视为同一条收藏。
pub fn dedupe_key(f: &Favorite) -> String {
    format!(
        "{}_{}_{}_{}",
        f.project_id,
        f.env_id,
        f.deploy_type,
        f.branch.as_deref().unwrap_or("")
    )
}

/// 新增或替换。已存在同键时**沿用原 id**，否则前端持有的引用会失效。
/// `now_ms` 由调用方传入，便于测试在同一毫秒内新增多条。
pub fn upsert(list: &mut Vec<Favorite>, mut incoming: Favorite, now_ms: u128) -> Favorite {
    let key = dedupe_key(&incoming);
    if let Some(idx) = list.iter().position(|f| dedupe_key(f) == key) {
        incoming.id = list[idx].id.clone();
        list[idx] = incoming.clone();
        return incoming;
    }
    if incoming.id.is_empty() {
        incoming.id = unique_id(list, now_ms);
    }
    list.push(incoming.clone());
    incoming
}

/// 时间戳可能撞车（同一毫秒内连续新增），撞了就往后挪一位
fn unique_id(list: &[Favorite], now_ms: u128) -> String {
    let mut candidate = now_ms;
    while list.iter().any(|f| f.id == candidate.to_string()) {
        candidate += 1;
    }
    candidate.to_string()
}

pub fn remove(list: &mut Vec<Favorite>, id: &str) {
    list.retain(|f| f.id != id);
}

/// 按给定的 id 顺序重排。
///
/// 防御性设计：
/// - `ids` 里不存在的 id 直接忽略
/// - `list` 里未被 `ids` 提及的项，按**原相对顺序**追加到末尾
/// - 重复 id 只取一次
///
/// 即一次重排**绝不会丢数据**。前端传来的顺序表若有缺失（比如并发新增了
/// 一条收藏而 UI 还没刷新），那些项会安全地留在末尾。
pub fn reorder(list: &[Favorite], ids: &[String]) -> Vec<Favorite> {
    let mut remaining: Vec<&Favorite> = list.iter().collect();
    let mut out: Vec<Favorite> = Vec::with_capacity(list.len());

    for id in ids {
        // 只在 remaining 里找，找到就移走，天然避免重复
        if let Some(pos) = remaining.iter().position(|f| &f.id == id) {
            out.push(remaining.remove(pos).clone());
        }
    }
    // 未被提及的按原顺序接上
    out.extend(remaining.into_iter().cloned());
    out
}

fn load_all<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<Favorite>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    match store.get(ITEMS_KEY) {
        Some(v) => {
            serde_json::from_value(v).map_err(|e| AppError::config(format!("收藏数据已损坏：{e}")))
        }
        None => Ok(Vec::new()),
    }
}

fn save_all<R: Runtime>(app: &AppHandle<R>, list: &[Favorite]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开收藏存储失败：{e}")))?;
    store.set(
        ITEMS_KEY,
        serde_json::to_value(list).map_err(|e| AppError::config(format!("序列化收藏失败：{e}")))?,
    );
    store
        .save()
        .map_err(|e| AppError::config(format!("写入收藏失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn favorites_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<Favorite>, AppError> {
    load_all(&app)
}

#[tauri::command]
pub async fn favorites_save<R: Runtime>(
    app: AppHandle<R>,
    fav: Favorite,
) -> Result<Favorite, AppError> {
    let mut list = load_all(&app)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let saved = upsert(&mut list, fav, now_ms);
    save_all(&app, &list)?;
    Ok(saved)
}

/// 按给定的 id 顺序重排收藏。数组顺序即显示顺序。
/// 返回重排后的完整列表，供前端直接替换本地状态。
#[tauri::command]
pub async fn favorites_reorder<R: Runtime>(
    app: AppHandle<R>,
    ids: Vec<String>,
) -> Result<Vec<Favorite>, AppError> {
    let list = load_all(&app)?;
    let reordered = reorder(&list, &ids);
    save_all(&app, &reordered)?;
    Ok(reordered)
}

#[tauri::command]
pub async fn favorites_delete<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), AppError> {
    let mut list = load_all(&app)?;
    remove(&mut list, &id);
    save_all(&app, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fav(project: i64, env: i64, dtype: &str, branch: Option<&str>) -> Favorite {
        Favorite {
            id: String::new(),
            kind: "config".to_string(),
            deploy_type: dtype.to_string(),
            env_id: env,
            env_name: "测试环境".to_string(),
            project_id: project,
            project_name: format!("zz-proj-{project}"),
            branch: branch.map(|s| s.to_string()),
        }
    }

    #[test]
    fn dedupe_key_ignores_absent_branch() {
        assert_eq!(dedupe_key(&fav(1, 2, "auto", None)), "1_2_auto_");
        assert_eq!(dedupe_key(&fav(1, 2, "auto", Some("main"))), "1_2_auto_main");
    }

    #[test]
    fn dedupe_key_distinguishes_deploy_type() {
        assert_ne!(
            dedupe_key(&fav(1, 2, "auto", None)),
            dedupe_key(&fav(1, 2, "docker", None))
        );
    }

    #[test]
    fn dedupe_key_distinguishes_env() {
        assert_ne!(
            dedupe_key(&fav(1, 2, "auto", None)),
            dedupe_key(&fav(1, 4, "auto", None))
        );
    }

    #[test]
    fn upsert_replaces_same_key_and_keeps_id() {
        let mut list = vec![];
        let first = upsert(&mut list, fav(1, 2, "auto", Some("main")), 1000);
        let second = upsert(&mut list, fav(1, 2, "auto", Some("main")), 2000);
        assert_eq!(list.len(), 1, "同键应替换而非追加");
        assert_eq!(first.id, second.id, "替换时应沿用原 id，避免前端引用失效");
        assert_eq!(second.project_name, "zz-proj-1");
    }

    #[test]
    fn upsert_appends_when_key_differs() {
        let mut list = vec![];
        upsert(&mut list, fav(1, 2, "auto", Some("main")), 1000);
        upsert(&mut list, fav(1, 2, "auto", Some("dev")), 1001);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn upsert_assigns_unique_ids_even_in_same_millisecond() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 2, "auto", None), 1000);
        let b = upsert(&mut list, fav(3, 2, "auto", None), 1000);
        assert_ne!(a.id, b.id, "同一毫秒内新增两条也要拿到不同 id");
    }

    #[test]
    fn upsert_keeps_explicit_id_when_provided() {
        let mut list = vec![];
        let mut incoming = fav(1, 2, "auto", None);
        incoming.id = "custom-id".to_string();
        let saved = upsert(&mut list, incoming, 1000);
        assert_eq!(saved.id, "custom-id");
    }

    #[test]
    fn remove_drops_matching_id_only() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 2, "auto", None), 1000);
        let b = upsert(&mut list, fav(3, 2, "auto", None), 1001);
        remove(&mut list, &a.id);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, b.id);
    }

    #[test]
    fn remove_unknown_id_is_noop() {
        let mut list = vec![];
        upsert(&mut list, fav(1, 2, "auto", None), 1000);
        remove(&mut list, "no-such-id");
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn serializes_with_camel_case_and_type_key() {
        let v = serde_json::to_value(fav(1, 2, "auto", Some("main"))).unwrap();
        assert_eq!(v["deployType"], "auto");
        assert_eq!(v["projectId"], 1);
        assert_eq!(v["envId"], 2);
        assert_eq!(v["envName"], "测试环境");
        assert_eq!(v["projectName"], "zz-proj-1");
        assert_eq!(v["branch"], "main");
        // 前端用 type 表示"项目级/配置级"收藏
        assert_eq!(v["type"], "config");
    }

    #[test]
    fn deserializes_existing_json() {
        let text = r#"{"id":"9","type":"project","deployType":"docker","envId":4,
            "envName":"预发布环境","projectId":7,"projectName":"zz-x","branch":null}"#;
        let f: Favorite = serde_json::from_str(text).unwrap();
        assert_eq!(f.kind, "project");
        assert_eq!(f.deploy_type, "docker");
        assert_eq!(f.env_id, 4);
        assert_eq!(f.branch, None);
    }

    #[test]
    fn branch_field_can_be_absent_in_json() {
        // 插件导出的老数据可能没有 branch 字段
        let text = r#"{"id":"1","type":"project","deployType":"auto","envId":1,
            "envName":"测试环境","projectId":2,"projectName":"zz-y"}"#;
        let f: Favorite = serde_json::from_str(text).unwrap();
        assert_eq!(f.branch, None);
    }

    #[test]
    fn round_trips_through_json() {
        let original = fav(5, 9, "docker", Some("release/v1"));
        let text = serde_json::to_string(&original).unwrap();
        let back: Favorite = serde_json::from_str(&text).unwrap();
        assert_eq!(dedupe_key(&back), dedupe_key(&original));
    }

    #[test]
    fn reorder_follows_given_id_order() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 1, "auto", None), 1000);
        let b = upsert(&mut list, fav(2, 1, "auto", None), 1001);
        let c = upsert(&mut list, fav(3, 1, "auto", None), 1002);

        let out = reorder(&list, &[c.id.clone(), a.id.clone(), b.id.clone()]);
        assert_eq!(
            out.iter().map(|f| f.project_id).collect::<Vec<_>>(),
            vec![3, 1, 2]
        );
    }

    #[test]
    fn reorder_ignores_unknown_ids() {
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 1, "auto", None), 1000);
        let out = reorder(&list, &["no-such-id".to_string(), a.id.clone()]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].project_id, 1);
    }

    #[test]
    fn reorder_appends_items_missing_from_ids() {
        // 防御前端传了不完整的顺序表：未提及的项按原相对顺序追加到末尾，
        // 绝不能因为一次重排而丢数据
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 1, "auto", None), 1000);
        let b = upsert(&mut list, fav(2, 1, "auto", None), 1001);
        let c = upsert(&mut list, fav(3, 1, "auto", None), 1002);

        let out = reorder(&list, &[c.id.clone()]);
        assert_eq!(
            out.iter().map(|f| f.project_id).collect::<Vec<_>>(),
            vec![3, 1, 2]
        );
        let _ = (a, b);
    }

    #[test]
    fn reorder_with_empty_ids_keeps_original_order() {
        let mut list = vec![];
        upsert(&mut list, fav(1, 1, "auto", None), 1000);
        upsert(&mut list, fav(2, 1, "auto", None), 1001);
        let out = reorder(&list, &[]);
        assert_eq!(
            out.iter().map(|f| f.project_id).collect::<Vec<_>>(),
            vec![1, 2]
        );
    }

    #[test]
    fn reorder_does_not_duplicate_on_repeated_ids() {
        // 前端理论上不会传重复 id，但传了也不能把同一项放进去两次
        let mut list = vec![];
        let a = upsert(&mut list, fav(1, 1, "auto", None), 1000);
        let out = reorder(&list, &[a.id.clone(), a.id.clone()]);
        assert_eq!(out.len(), 1);
    }
}
