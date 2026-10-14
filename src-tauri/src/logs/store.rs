//! 构建日志的本地留存：落盘、索引、保留策略。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub task_id: i64,
    /// "auto" | "docker"
    pub deploy_type: String,
    pub project_name: String,
    pub env_name: String,
    /// 首次订阅的毫秒时间戳
    pub started_at: u128,
    pub size: u64,
}

/// 保留策略。默认 30 天 / 500 条（spec §6.3）
#[derive(Debug, Clone, Copy)]
pub struct Retention {
    pub max_days: u64,
    pub max_entries: usize,
}

impl Default for Retention {
    fn default() -> Self {
        Self {
            max_days: 30,
            max_entries: 500,
        }
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 只接受两个已知的部署类型。
///
/// deploy_type 会被**直接拼进文件路径**，放任前端传任意字符串就等于
/// 允许用 `../` 把日志写到日志目录之外。
fn validate_deploy_type(deploy_type: &str) -> Result<(), AppError> {
    if deploy_type == "auto" || deploy_type == "docker" {
        Ok(())
    } else {
        Err(AppError::config(format!(
            "未知的部署类型：{deploy_type}（只允许 auto / docker）"
        )))
    }
}

/// 日志落盘 + 索引 + 保留策略。
///
/// 目录布局：
///   <root>/index.json                 元数据索引
///   <root>/<deployType>/<taskId>.log  日志正文（原始 chunk，未剥离 ANSI）
///
/// 内部只有一个 `PathBuf`，因此可以随手 clone 一份丢给后台任务。
#[derive(Debug, Clone)]
pub struct LogStore {
    root: PathBuf,
    /// 串行化索引的"读-改-写"。
    ///
    /// Tauri 的多个命令是并发跑的：两个 log_open 同时 note_open 时，
    /// 双方都会读到旧索引再写回，后写的那个会抹掉别人的条目，
    /// 留下一个 list() 里看不到、保留策略也清不掉的孤儿日志文件。
    index_lock: Arc<Mutex<()>>,
}

impl LogStore {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            index_lock: Arc::new(Mutex::new(())),
        }
    }

    /// 锁中毒（别的线程 panic 时）也要继续可用：日志留存是辅助功能，
    /// 不该因为一次 panic 就永久不可用。
    fn lock_index(&self) -> MutexGuard<'_, ()> {
        self.index_lock.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 供 spawn 出去的后台任务持有（语义与 `clone()` 相同，名字更直白）
    pub fn clone_for_task(&self) -> LogStore {
        self.clone()
    }

    fn index_path(&self) -> PathBuf {
        self.root.join("index.json")
    }

    fn file_path(&self, deploy_type: &str, task_id: i64) -> PathBuf {
        self.root.join(deploy_type).join(format!("{task_id}.log"))
    }

    /// 索引损坏时返回空表而不是报错——日志留存是辅助功能，
    /// 不该因为一个坏掉的 json 让整个应用不可用。
    fn load_index(&self) -> BTreeMap<String, HistoryEntry> {
        std::fs::read(self.index_path())
            .ok()
            .and_then(|b| serde_json::from_slice::<BTreeMap<String, HistoryEntry>>(&b).ok())
            .unwrap_or_default()
    }

    fn save_index(&self, idx: &BTreeMap<String, HistoryEntry>) -> Result<(), AppError> {
        std::fs::create_dir_all(&self.root)
            .map_err(|e| AppError::io(format!("创建日志目录失败：{e}")))?;
        let body = serde_json::to_vec_pretty(idx)
            .map_err(|e| AppError::io(format!("序列化日志索引失败：{e}")))?;
        std::fs::write(self.index_path(), body)
            .map_err(|e| AppError::io(format!("写入日志索引失败：{e}")))
    }

    fn key(deploy_type: &str, task_id: i64) -> String {
        format!("{deploy_type}_{task_id}")
    }

    /// 记录"用户主动打开了这条日志"。只有被打开过的任务才会留存，
    /// 避免把全站日志都拉下来（spec §6.3）。
    pub fn note_open(
        &self,
        deploy_type: &str,
        task_id: i64,
        project_name: &str,
        env_name: &str,
    ) -> Result<(), AppError> {
        validate_deploy_type(deploy_type)?;
        let _guard = self.lock_index();
        let mut idx = self.load_index();
        let k = Self::key(deploy_type, task_id);
        idx.entry(k)
            .and_modify(|e| {
                e.project_name = project_name.to_string();
                e.env_name = env_name.to_string();
            })
            .or_insert_with(|| HistoryEntry {
                task_id,
                deploy_type: deploy_type.to_string(),
                project_name: project_name.to_string(),
                env_name: env_name.to_string(),
                started_at: now_ms(),
                size: 0,
            });
        self.save_index(&idx)
    }

    /// 追加日志块（原始内容，不剥离 ANSI）。
    ///
    /// **刻意不在这里更新索引**：日志是高频写入（每秒可能几十块），
    /// 每块都重写一次 index.json 会让磁盘写入放大几十倍。
    /// 文件大小改为在 `list()` 时按实际文件算。
    pub fn append(&self, deploy_type: &str, task_id: i64, chunk: &str) -> Result<(), AppError> {
        use std::io::Write;
        validate_deploy_type(deploy_type)?;
        let path = self.file_path(deploy_type, task_id);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建日志目录失败：{e}")))?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| AppError::io(format!("打开日志文件失败：{e}")))?;
        f.write_all(chunk.as_bytes())
            .map_err(|e| AppError::io(format!("写入日志失败：{e}")))
    }

    pub fn read(&self, deploy_type: &str, task_id: i64) -> Result<Option<String>, AppError> {
        validate_deploy_type(deploy_type)?;
        match std::fs::read_to_string(self.file_path(deploy_type, task_id)) {
            Ok(s) => Ok(Some(s)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(AppError::io(format!("读取日志失败：{e}"))),
        }
    }

    /// 按开始时间倒序返回（最新的在前），size 以磁盘上的实际文件为准
    pub fn list(&self) -> Result<Vec<HistoryEntry>, AppError> {
        let mut v: Vec<HistoryEntry> = self.load_index().into_values().collect();
        for e in &mut v {
            if let Ok(meta) = std::fs::metadata(self.file_path(&e.deploy_type, e.task_id)) {
                e.size = meta.len();
            }
        }
        v.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        Ok(v)
    }

    pub fn delete(&self, deploy_type: &str, task_id: i64) -> Result<(), AppError> {
        validate_deploy_type(deploy_type)?;
        let _guard = self.lock_index();
        let _ = std::fs::remove_file(self.file_path(deploy_type, task_id));
        let mut idx = self.load_index();
        idx.remove(&Self::key(deploy_type, task_id));
        self.save_index(&idx)
    }

    pub fn clear(&self) -> Result<(), AppError> {
        let _guard = self.lock_index();
        for e in self.list()? {
            let _ = std::fs::remove_file(self.file_path(&e.deploy_type, e.task_id));
        }
        let empty: BTreeMap<String, HistoryEntry> = BTreeMap::new();
        self.save_index(&empty)
    }

    /// 应用保留策略，返回被淘汰的条数。
    /// **同时删除日志正文文件**，否则索引清了但磁盘还在涨。
    pub fn apply_retention(&self, r: &Retention) -> Result<usize, AppError> {
        let _guard = self.lock_index();
        let all = self.list()?; // 已是"最新在前"
        let cutoff = now_ms().saturating_sub(r.max_days as u128 * 24 * 3600 * 1000);

        let mut keep = Vec::new();
        let mut drop = Vec::new();
        for (i, e) in all.into_iter().enumerate() {
            if i < r.max_entries && e.started_at >= cutoff {
                keep.push(e);
            } else {
                drop.push(e);
            }
        }

        for e in &drop {
            let _ = std::fs::remove_file(self.file_path(&e.deploy_type, e.task_id));
        }
        let idx: BTreeMap<String, HistoryEntry> = keep
            .into_iter()
            .map(|e| (Self::key(&e.deploy_type, e.task_id), e))
            .collect();
        self.save_index(&idx)?;
        Ok(drop.len())
    }

    /// 全部日志占用的字节数，供设置页展示
    pub fn total_size(&self) -> Result<u64, AppError> {
        Ok(self.list()?.iter().map(|e| e.size).sum())
    }
}

/// 供测试与调用方拼路径用
pub fn logs_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("logs")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(dir: &TempDir) -> LogStore {
        LogStore::new(dir.path().join("logs"))
    }

    #[test]
    fn append_creates_file_and_returns_size() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.append("auto", 42, "line1\n").unwrap();
        s.append("auto", 42, "line2\n").unwrap();
        let text = s.read("auto", 42).unwrap();
        assert_eq!(text, Some("line1\nline2\n".to_string()));
    }

    #[test]
    fn keeps_deploy_types_separate() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.append("auto", 1, "A").unwrap();
        s.append("docker", 1, "D").unwrap();
        assert_eq!(s.read("auto", 1).unwrap(), Some("A".to_string()));
        assert_eq!(s.read("docker", 1).unwrap(), Some("D".to_string()));
    }

    #[test]
    fn read_missing_returns_none() {
        let dir = TempDir::new().unwrap();
        assert!(store(&dir).read("auto", 999).unwrap().is_none());
    }

    #[test]
    fn index_records_metadata() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.note_open("auto", 42, "zz-cy-iptv", "测试环境").unwrap();
        s.append("auto", 42, "x").unwrap();
        let list = s.list().unwrap();
        let e = list.iter().find(|e| e.task_id == 42).unwrap();
        assert_eq!(e.project_name, "zz-cy-iptv");
        assert_eq!(e.env_name, "测试环境");
        assert!(e.size > 0);
    }

    #[test]
    fn index_survives_reload() {
        let dir = TempDir::new().unwrap();
        {
            let s = store(&dir);
            s.note_open("auto", 7, "p", "e").unwrap();
        }
        // 新实例应能读到之前的索引
        let s2 = store(&dir);
        assert!(s2.list().unwrap().iter().any(|e| e.task_id == 7));
    }

    #[test]
    fn retention_drops_entries_beyond_max_count() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..5 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
        }
        // 只留最近 3 条
        let removed = s
            .apply_retention(&Retention {
                max_days: 3650,
                max_entries: 3,
            })
            .unwrap();
        assert_eq!(removed, 2);
        assert_eq!(s.list().unwrap().len(), 3);
    }

    #[test]
    fn retention_keeps_newest_entries() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..5 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
            // 拉开时间戳，保证"最新"可判定
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        s.apply_retention(&Retention {
            max_days: 3650,
            max_entries: 2,
        })
        .unwrap();
        let ids: Vec<i64> = s.list().unwrap().iter().map(|e| e.task_id).collect();
        assert!(ids.contains(&4), "应保留最新的 task 4，实际 {ids:?}");
        assert!(ids.contains(&3));
    }

    #[test]
    fn retention_removes_log_file_too() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        for i in 0..3 {
            s.note_open("auto", i, "p", "e").unwrap();
            s.append("auto", i, "x").unwrap();
        }
        s.apply_retention(&Retention {
            max_days: 3650,
            max_entries: 1,
        })
        .unwrap();
        // 被淘汰的日志正文文件也应删除，否则磁盘会一直涨
        let remaining = s.list().unwrap();
        assert_eq!(remaining.len(), 1);
        let kept = remaining[0].task_id;
        assert!(s.read("auto", kept).unwrap().is_some());
        let files = std::fs::read_dir(dir.path().join("logs").join("auto"))
            .unwrap()
            .count();
        assert_eq!(files, 1, "目录里应只剩 1 个日志文件");
    }

    #[test]
    fn delete_removes_entry_and_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.note_open("auto", 5, "p", "e").unwrap();
        s.append("auto", 5, "x").unwrap();
        s.delete("auto", 5).unwrap();
        assert!(s.list().unwrap().is_empty());
        assert!(s.read("auto", 5).unwrap().is_none());
    }

    #[test]
    fn index_with_corrupt_json_is_treated_as_empty_not_fatal() {
        // 索引文件损坏不应该让整个功能不可用
        let dir = TempDir::new().unwrap();
        let root = dir.path().join("logs");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("index.json"), b"{ not json").unwrap();
        let s = LogStore::new(root);
        assert!(s.list().unwrap().is_empty());
    }

    #[test]
    fn rejects_unknown_deploy_type() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        assert!(s.note_open("weird", 1, "p", "e").is_err());
        assert!(s.append("weird", 1, "x").is_err());
        assert!(s.read("weird", 1).is_err());
        assert!(s.delete("weird", 1).is_err());
    }

    #[test]
    fn rejects_path_traversal_deploy_type() {
        // deploy_type 会被拼进路径：放过它就能写到日志目录之外
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        assert!(s.note_open("../evil", 1, "p", "e").is_err());
        assert!(s.append("/tmp/evil", 1, "x").is_err());
        assert!(!dir.path().join("evil").exists());
    }

    #[test]
    fn concurrent_note_open_keeps_every_entry() {
        // 并发读-改-写若不串行化会互相覆盖，丢掉索引条目
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        let mut handles = Vec::new();
        for i in 0..8 {
            let s = s.clone();
            handles.push(std::thread::spawn(move || {
                s.note_open("auto", i, "p", "e").unwrap();
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(s.list().unwrap().len(), 8);
    }
}
