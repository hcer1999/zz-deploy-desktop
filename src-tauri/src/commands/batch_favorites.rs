//! 批量部署的收藏：把"一份批量计划"存下来，下次一键载入。
//!
//! 一个计划 = 若干条部署项，**每一项自带环境、项目、分支**（可以跨环境、跨分支），
//! 所以模型是一个扁平列表而不是"一个环境 + 一批项目"。
//!
//! 为什么不复用 `favorites.rs` 的 `Favorite`：那套的语义是"一个收藏 = 一个项目"，
//! 去重键是 `项目_环境_类型_分支`；这里是"一个收藏 = 一批部署项"，混在一起会把
//! 去重、排序、顺序持久化都搅浑，所以单独一个文件。
//!
//! **刻意不存的东西**：每项的 commit（发版时基本都是取最新一条；
//! 存下来只会造成"以为在发新版、其实发的是旧提交"）与 `autoOnline`
//! （"构建成功即自动上线"必须是一次一次有意识的决定，不能从收藏里悄悄带出来）。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use tauri_plugin_store::StoreExt;

use crate::error::AppError;

const STORE_FILE: &str = "batch_favorites.json";
const ITEMS_KEY: &str = "items";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFavoriteItem {
    /// "auto" | "docker"
    pub deploy_type: String,
    pub env_id: i64,
    pub env_name: String,
    pub project_id: i64,
    pub project_name: String,
    /// 该项的默认分支；空串表示"载入后还要自己选"
    #[serde(default)]
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchFavorite {
    pub id: String,
    /// 用户起的名字，例如「dramafinds 发版」
    pub name: String,
    /// 计划里的部署项（跨环境、跨分支都允许）
    #[serde(default)]
    pub items: Vec<BatchFavoriteItem>,
}

/// 去重键就是名字（名字是用户给这份计划起的，同名就是同一条）。
/// 计划本身已经能跨环境，所以去重键里不再带环境/类型。
pub fn dedupe_key(f: &BatchFavorite) -> String {
    f.name.trim().to_string()
}

/// 新增或替换。已有同键时**沿用原 id**（前端持有的引用不会失效）；
/// 传入非空 id 时按 id 覆盖（支持"改了名字再存"这种修改）。
pub fn upsert(list: &mut Vec<BatchFavorite>, mut incoming: BatchFavorite, now_ms: u128) -> BatchFavorite {
    let by_id = if incoming.id.is_empty() {
        None
    } else {
        list.iter().position(|f| f.id == incoming.id)
    };
    let key = dedupe_key(&incoming);
    let idx = by_id.or_else(|| list.iter().position(|f| dedupe_key(f) == key));

    if let Some(i) = idx {
        incoming.id = list[i].id.clone();
        list[i] = incoming.clone();
        return incoming;
    }
    if incoming.id.is_empty() {
        incoming.id = unique_id(list, now_ms);
    }
    list.push(incoming.clone());
    incoming
}

/// 时间戳可能撞车（同一毫秒内连续新增），撞了就往后挪一位
fn unique_id(list: &[BatchFavorite], now_ms: u128) -> String {
    let mut candidate = now_ms;
    while list.iter().any(|f| f.id == candidate.to_string()) {
        candidate += 1;
    }
    candidate.to_string()
}

pub fn remove(list: &mut Vec<BatchFavorite>, id: &str) {
    list.retain(|f| f.id != id);
}

/// 旧形状（开发期用过一版）：一个收藏 = 一个环境 + 一条分支 + 一批项目。
/// 读到就迁移成逐项的 `items`（每项都带上那个环境与分支），不然老数据会被当成损坏。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyBatchFavorite {
    id: String,
    name: String,
    deploy_type: String,
    env_id: i64,
    env_name: String,
    #[serde(default)]
    branch: String,
    projects: Vec<LegacyProject>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyProject {
    project_id: i64,
    project_name: String,
}

impl From<LegacyBatchFavorite> for BatchFavorite {
    fn from(old: LegacyBatchFavorite) -> Self {
        BatchFavorite {
            id: old.id,
            name: old.name,
            items: old
                .projects
                .into_iter()
                .map(|p| BatchFavoriteItem {
                    deploy_type: old.deploy_type.clone(),
                    env_id: old.env_id,
                    env_name: old.env_name.clone(),
                    project_id: p.project_id,
                    project_name: p.project_name,
                    branch: old.branch.clone(),
                })
                .collect(),
        }
    }
}

fn load_all<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<BatchFavorite>, AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开批量收藏存储失败：{e}")))?;
    let Some(v) = store.get(ITEMS_KEY) else {
        return Ok(Vec::new());
    };
    let raw: Vec<serde_json::Value> = serde_json::from_value(v)
        .map_err(|e| AppError::config(format!("批量收藏数据已损坏：{e}")))?;

    Ok(raw.into_iter().filter_map(parse_record).collect())
}

/// 逐条解析一条记录。
///
/// **顺序很重要**：先试旧形状。旧形状有 `projects` 字段、没有 `items`，
/// 而新形状的 `items` 带 `#[serde(default)]`——先试新形状的话旧记录会被
/// 当成"空计划"解析成功，迁移就永远不会发生（表现成一条 0 项的收藏）。
/// 两条都不像就跳过：**绝不能因为一条坏数据让整个列表读不出来**
/// （实测踩过：旧记录缺 `items` 时整份列表报损坏，存进去的收藏一条都不显示）。
fn parse_record(value: serde_json::Value) -> Option<BatchFavorite> {
    if let Ok(old) = serde_json::from_value::<LegacyBatchFavorite>(value.clone()) {
        return Some(old.into());
    }
    serde_json::from_value::<BatchFavorite>(value).ok()
}

fn save_all<R: Runtime>(app: &AppHandle<R>, list: &[BatchFavorite]) -> Result<(), AppError> {
    let store = app
        .store(STORE_FILE)
        .map_err(|e| AppError::config(format!("打开批量收藏存储失败：{e}")))?;
    store.set(
        ITEMS_KEY,
        serde_json::to_value(list)
            .map_err(|e| AppError::config(format!("序列化批量收藏失败：{e}")))?,
    );
    store
        .save()
        .map_err(|e| AppError::config(format!("写入批量收藏失败：{e}")))?;
    Ok(())
}

#[tauri::command]
pub async fn batch_favorites_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<BatchFavorite>, AppError> {
    load_all(&app)
}

#[tauri::command]
pub async fn batch_favorites_save<R: Runtime>(
    app: AppHandle<R>,
    fav: BatchFavorite,
) -> Result<BatchFavorite, AppError> {
    let mut list = load_all(&app)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let saved = upsert(&mut list, fav, now_ms);
    save_all(&app, &list)?;
    Ok(saved)
}

#[tauri::command]
pub async fn batch_favorites_delete<R: Runtime>(
    app: AppHandle<R>,
    id: String,
) -> Result<(), AppError> {
    let mut list = load_all(&app)?;
    remove(&mut list, &id);
    save_all(&app, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(project: i64, env: i64, dtype: &str, branch: &str) -> BatchFavoriteItem {
        BatchFavoriteItem {
            deploy_type: dtype.to_string(),
            env_id: env,
            env_name: "测试环境".to_string(),
            project_id: project,
            project_name: format!("p{project}"),
            branch: branch.to_string(),
        }
    }

    fn fav(name: &str) -> BatchFavorite {
        BatchFavorite {
            id: String::new(),
            name: name.to_string(),
            items: vec![item(1, 1, "auto", "origin/master"), item(2, 2, "docker", "origin/dev")],
        }
    }

    /// 旧形状（一个环境 + 一批项目 + 一条分支）要能迁移成逐项的 items，
    /// 而不是被当成损坏数据（实测：旧记录缺 items，导致收藏区一条都不显示）。
    #[test]
    fn legacy_record_migrates_to_items() {
        let legacy = serde_json::json!({
            "id": "1792073680181",
            "name": "体育站批量",
            "deployType": "docker",
            "envId": 2,
            "envName": "正式环境",
            "branch": "feature/2.0.6-pay",
            "projects": [
                { "projectId": 1578, "projectName": "sportsflux-pro（tke_node）" },
                { "projectId": 1579, "projectName": "sportsflux-fun（tke_node）" }
            ]
        });
        let migrated = parse_record(legacy).expect("旧记录应被迁移而不是被跳过");

        assert_eq!(migrated.name, "体育站批量");
        assert_eq!(migrated.items.len(), 2, "每个项目变成一项");
        assert_eq!(migrated.items[0].deploy_type, "docker");
        assert_eq!(migrated.items[0].env_id, 2);
        assert_eq!(migrated.items[0].env_name, "正式环境");
        assert_eq!(migrated.items[0].branch, "feature/2.0.6-pay");
        assert_eq!(migrated.items[1].project_id, 1579);
    }

    /// 一条坏数据不能拖垮整个列表
    #[test]
    fn one_bad_record_does_not_break_the_rest() {
        assert!(parse_record(serde_json::json!({ "name": "什么都不像的记录" })).is_none());
        let good = parse_record(serde_json::json!({ "id": "1", "name": "好的", "items": [] }));
        assert_eq!(good.unwrap().name, "好的");
    }

    /// 回归：旧记录必须先被认成旧形状。
    /// 如果先试新形状（items 有 default），旧记录会被解析成"空计划"，
    /// 迁移永不发生，用户看到的就是"收藏显示为 0 项"。
    #[test]
    fn legacy_shape_wins_over_empty_new_shape() {
        let legacy = serde_json::json!({
            "id": "9", "name": "体育站批量", "deployType": "docker", "envId": 2,
            "envName": "正式环境", "branch": "feature/2.0.6-pay",
            "projects": [{ "projectId": 1578, "projectName": "sportsflux-pro（tke_node）" }]
        });
        let f = parse_record(legacy).unwrap();
        assert_eq!(f.items.len(), 1, "不能变成 0 项的收藏");
        assert_eq!(f.items[0].project_id, 1578);
    }

    #[test]
    fn upsert_appends_then_replaces_same_name() {
        let mut list = Vec::new();
        let a = upsert(&mut list, fav("发版"), 1000);
        assert_eq!(list.len(), 1);
        assert_eq!(a.id, "1000");

        let mut again = fav("发版");
        again.items = vec![item(3, 1, "auto", "origin/master")];
        let b = upsert(&mut list, again, 2000);
        assert_eq!(list.len(), 1, "同名视为同一条");
        assert_eq!(b.id, "1000", "应沿用原 id");
        assert_eq!(list[0].items, vec![item(3, 1, "auto", "origin/master")]);
    }

    /// 一份计划里可以同时有不同环境、不同分支、不同部署类型的项
    #[test]
    fn one_plan_can_span_envs_branches_and_types() {
        let mut list = Vec::new();
        let saved = upsert(&mut list, fav("跨环境发版"), 1000);
        assert_eq!(saved.items.len(), 2);
        assert_eq!(saved.items[0].env_id, 1);
        assert_eq!(saved.items[1].env_id, 2);
        assert_eq!(saved.items[0].deploy_type, "auto");
        assert_eq!(saved.items[1].deploy_type, "docker");
    }

    #[test]
    fn different_names_are_different_entries() {
        let mut list = Vec::new();
        upsert(&mut list, fav("发版"), 1000);
        upsert(&mut list, fav("回滚用"), 2000);
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn id_can_update_and_rename() {
        let mut list = Vec::new();
        let a = upsert(&mut list, fav("发版"), 1000);

        // 改名再存：带 id → 按 id 覆盖，不会留下旧名字那条
        let mut renamed = fav("发版（新）");
        renamed.id = a.id.clone();
        let b = upsert(&mut list, renamed, 2000);
        assert_eq!(list.len(), 1);
        assert_eq!(b.id, a.id);
        assert_eq!(list[0].name, "发版（新）");
    }

    #[test]
    fn ids_do_not_collide_within_the_same_millisecond() {
        let mut list = Vec::new();
        upsert(&mut list, fav("一"), 1000);
        upsert(&mut list, fav("二"), 1000);
        upsert(&mut list, fav("三"), 1000);
        let ids: Vec<&str> = list.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["1000", "1001", "1002"]);
    }

    #[test]
    fn remove_by_id_keeps_the_rest() {
        let mut list = Vec::new();
        let a = upsert(&mut list, fav("一"), 1000);
        let b = upsert(&mut list, fav("二"), 2000);
        remove(&mut list, &a.id);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, b.id);
    }
}
