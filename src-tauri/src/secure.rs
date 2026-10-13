//! 凭据（账号 + 密码）的本地存储。
//!
//! **不使用系统钥匙串**：macOS 上未签名（或每次构建签名都变）的应用访问钥匙串时，
//! ACL 无法与已有条目匹配，系统会**每次都弹授权框**，体验上等于每启动一次都要输密码。
//! 因此凭据统一存放在应用数据目录下的加密文件里（`credentials.bin` + `credentials.key`）。
//!
//! 安全等级要说清楚：密钥与密文同在应用数据目录，**只能防止明文外泄**
//! （文件被拷走、被随手打开都看不到密码），无法防御已经能在本机读文件系统的攻击者。
//! 设置页会向用户明示这一点（spec §7 / §12）。

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;

use crate::error::AppError;

/// 应用数据目录下与 `tauri.conf.json` 的 `identifier` 一致的子目录名。
/// 只在 example / e2e 这类没有 Tauri App 的地方用来定位凭据文件。
const APP_IDENTIFIER: &str = "com.zhizhengroup.deploy";

pub const CREDENTIALS_FILE: &str = "credentials.bin";
const KEY_FILE: &str = "credentials.key";
const NONCE_LEN: usize = 12;

pub trait CredentialStore: Send + Sync {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError>;
    fn load(&self) -> Result<Option<(String, String)>, AppError>;
    fn forget(&self) -> Result<(), AppError>;
    /// 透传给设置页，用于告知用户当前实际的存储方式
    fn backend(&self) -> &'static str;
    /// 凭据文件位置，设置页会显示出来（用户关心"到底存哪了"）
    fn location(&self) -> String;
}

/// 用户名与密码一起编码存放，避免多开一个文件。
fn encode(username: &str, password: &str) -> String {
    serde_json::json!({ "u": username, "p": password }).to_string()
}

fn decode(payload: &str) -> Result<Option<(String, String)>, AppError> {
    let v: serde_json::Value = serde_json::from_str(payload)
        .map_err(|e| AppError::config(format!("凭据内容无法解析：{e}")))?;
    let u = v.get("u").and_then(|x| x.as_str()).unwrap_or_default();
    let p = v.get("p").and_then(|x| x.as_str()).unwrap_or_default();
    if u.is_empty() {
        return Ok(None);
    }
    Ok(Some((u.to_string(), p.to_string())))
}

/// 把文件权限收紧到 0600（仅所有者可读写）
fn restrict_file_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 目录收紧到 0700：密钥就在这个目录里，别的本地用户不该能进来读
fn restrict_dir_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

/// 应用数据目录下凭据文件的路径
pub fn credentials_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(CREDENTIALS_FILE)
}

/// 建凭据存储。**只返回加密文件后端**——见文件头对钥匙串的说明。
pub fn create_store(app_data_dir: &Path) -> Box<dyn CredentialStore> {
    Box::new(EncryptedFileStore::new(credentials_path(app_data_dir)))
}

/// 应用数据目录（不依赖 Tauri 的平台约定，与 `tauri::path::app_data_dir` 一致）。
///
/// 为什么需要它：`examples/` 与 `tests/` 里没有 Tauri App，拿不到 `AppHandle`，
/// 但它们要读"本机已保存的凭据"（`capture_fixtures` 刷 fixture、`relogin_e2e` 跑真实续登）。
/// 可用 `ZZ_DEPLOY_APP_DATA_DIR` 覆盖，便于指向测试目录。
pub fn app_data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("ZZ_DEPLOY_APP_DATA_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    {
        return Some(home?.join("Library/Application Support").join(APP_IDENTIFIER));
    }
    #[cfg(target_os = "windows")]
    {
        let _ = home;
        let appdata = std::env::var_os("APPDATA").map(PathBuf::from)?;
        return Some(appdata.join(APP_IDENTIFIER));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.unwrap_or_default().join(".local/share"));
        return Some(data_home.join(APP_IDENTIFIER));
    }
    #[allow(unreachable_code)]
    None
}

/// 读"本机应用数据目录里的凭据"，供 example / e2e 工具使用
pub fn store_from_app_data_dir() -> Result<Box<dyn CredentialStore>, AppError> {
    let dir = app_data_dir().ok_or_else(|| AppError::config("无法解析应用数据目录"))?;
    Ok(create_store(&dir))
}

/// AES-256-GCM 加密的本地文件存储。
///
/// 文件布局：`[12 字节随机 nonce][密文]`；密钥是 32 字节随机数，存在同目录的
/// `credentials.key`（0600）。每次保存都换新 nonce，因此相同明文得到不同密文。
pub struct EncryptedFileStore {
    data_path: PathBuf,
    key_path: PathBuf,
}

impl EncryptedFileStore {
    /// `data_path` 例如 `<appDataDir>/credentials.bin`，密钥放同目录下的 `credentials.key`
    pub fn new(data_path: PathBuf) -> Self {
        let key_path = data_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join(KEY_FILE);
        Self {
            data_path,
            key_path,
        }
    }

    fn load_or_create_key(&self) -> Result<[u8; 32], AppError> {
        if let Ok(bytes) = std::fs::read(&self.key_path) {
            if bytes.len() == 32 {
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        self.ensure_dir()?;
        std::fs::write(&self.key_path, key)
            .map_err(|e| AppError::io(format!("写入密钥失败：{e}")))?;
        restrict_file_permissions(&self.key_path);
        Ok(key)
    }

    /// 确保目录存在并收紧权限（密钥与密文都在这里）
    fn ensure_dir(&self) -> Result<(), AppError> {
        if let Some(parent) = self.data_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建目录失败：{e}")))?;
            restrict_dir_permissions(parent);
        }
        Ok(())
    }

    fn cipher(&self) -> Result<Aes256Gcm, AppError> {
        let key = self.load_or_create_key()?;
        Ok(Aes256Gcm::new_from_slice(&key).expect("32 字节密钥必然合法"))
    }
}

impl CredentialStore for EncryptedFileStore {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError> {
        let plain = encode(username, password);
        let cipher = self.cipher()?;

        // 每次都用新的随机 nonce，因此相同明文会得到不同密文
        let mut nonce_bytes = [0u8; NONCE_LEN];
        rand::thread_rng().fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let ciphertext = cipher
            .encrypt(nonce, plain.as_bytes())
            .map_err(|e| AppError::config(format!("加密失败：{e}")))?;

        let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ciphertext);

        self.ensure_dir()?;
        std::fs::write(&self.data_path, out)
            .map_err(|e| AppError::io(format!("写入凭据失败：{e}")))?;
        restrict_file_permissions(&self.data_path);
        Ok(())
    }

    fn load(&self) -> Result<Option<(String, String)>, AppError> {
        let raw = match std::fs::read(&self.data_path) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(AppError::io(format!("读取凭据失败：{e}"))),
        };
        if raw.len() <= NONCE_LEN {
            return Err(AppError::config("凭据文件已损坏（长度异常）".to_string()));
        }
        let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plain = self
            .cipher()?
            .decrypt(nonce, ciphertext)
            .map_err(|_| AppError::config("凭据解密失败，文件或密钥已损坏".to_string()))?;
        let text = String::from_utf8(plain)
            .map_err(|e| AppError::config(format!("凭据内容不是合法文本：{e}")))?;
        decode(&text)
    }

    fn forget(&self) -> Result<(), AppError> {
        match std::fs::remove_file(&self.data_path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::io(format!("清除凭据失败：{e}"))),
        }
    }

    fn backend(&self) -> &'static str {
        "encryptedFile"
    }

    fn location(&self) -> String {
        self.data_path.to_string_lossy().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn store(dir: &TempDir) -> EncryptedFileStore {
        EncryptedFileStore::new(dir.path().join("credentials.bin"))
    }

    #[test]
    fn roundtrips_credentials() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("zhangsan", "p@ssw0rd").unwrap();
        let got = s.load().unwrap().unwrap();
        assert_eq!(got.0, "zhangsan");
        assert_eq!(got.1, "p@ssw0rd");
    }

    #[test]
    fn overwrites_previous_credentials() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        s.save("b", "2").unwrap();
        assert_eq!(
            s.load().unwrap().unwrap(),
            ("b".to_string(), "2".to_string())
        );
    }

    #[test]
    fn forget_clears_credentials_but_keeps_key_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        s.forget().unwrap();
        assert!(s.load().unwrap().is_none());
        assert!(
            dir.path().join("credentials.key").exists(),
            "不应删除密钥文件"
        );
    }

    #[test]
    fn load_returns_none_when_file_missing() {
        let dir = TempDir::new().unwrap();
        assert!(store(&dir).load().unwrap().is_none());
    }

    #[test]
    fn plaintext_password_is_not_present_in_ciphertext_file() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("zhangsan", "SUPER_SECRET_VALUE").unwrap();
        let raw = std::fs::read(dir.path().join("credentials.bin")).unwrap();
        assert!(
            !raw.windows(18).any(|w| w == b"SUPER_SECRET_VALUE"),
            "密文文件里不应出现明文密码"
        );
    }

    #[test]
    fn corrupted_file_reports_error_not_panic() {
        let dir = TempDir::new().unwrap();
        std::fs::write(dir.path().join("credentials.bin"), b"garbage").unwrap();
        std::fs::write(dir.path().join("credentials.key"), [7u8; 32]).unwrap();
        let e = store(&dir).load().unwrap_err();
        assert_eq!(e.kind, crate::error::ErrorKind::Config);
    }

    #[test]
    fn key_is_32_bytes_and_reused_across_instances() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        // 新实例应能读到同一把密钥并解出原值
        assert_eq!(store(&dir).load().unwrap().unwrap().1, "1");
        let key = std::fs::read(dir.path().join("credentials.key")).unwrap();
        assert_eq!(key.len(), 32);
    }

    #[test]
    fn each_save_produces_different_ciphertext_for_same_plaintext() {
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "same").unwrap();
        let first = std::fs::read(dir.path().join("credentials.bin")).unwrap();
        s.save("a", "same").unwrap();
        let second = std::fs::read(dir.path().join("credentials.bin")).unwrap();
        assert_ne!(first, second, "随机 nonce 应让相同明文产生不同密文");
    }

    #[test]
    fn create_store_is_always_the_encrypted_file_backend() {
        // 这是本文件的核心约束：不再走系统钥匙串（否则 macOS 每次启动都弹授权）
        let dir = TempDir::new().unwrap();
        let s = create_store(dir.path());
        assert_eq!(s.backend(), "encryptedFile");
        assert_eq!(s.location(), dir.path().join(CREDENTIALS_FILE).to_string_lossy());
    }

    #[test]
    fn credentials_path_is_inside_app_data_dir() {
        let dir = PathBuf::from("/tmp/whatever");
        assert_eq!(
            credentials_path(&dir),
            PathBuf::from("/tmp/whatever/credentials.bin")
        );
    }

    #[test]
    fn app_data_dir_ends_with_the_identifier() {
        // 与 tauri.conf.json 的 identifier 保持一致，否则 example/e2e 会读错位置
        let dir = app_data_dir().expect("本机应能解析应用数据目录");
        assert!(
            dir.ends_with(APP_IDENTIFIER),
            "应用数据目录应以 {APP_IDENTIFIER} 结尾，实际 {dir:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn files_are_created_with_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let nested = dir.path().join("appdata");
        let s = EncryptedFileStore::new(nested.join("credentials.bin"));
        s.save("a", "1").unwrap();
        for path in [nested.clone(), nested.join("credentials.bin"), nested.join("credentials.key")] {
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let want = if path.is_dir() { 0o700 } else { 0o600 };
            assert_eq!(mode, want, "{path:?} 权限应为 {want:o}，实际 {mode:o}");
        }
    }
}
