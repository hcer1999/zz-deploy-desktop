use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use serde::Serialize;

use crate::error::AppError;

const CREDENTIALS_FILE: &str = "credentials.bin";
const KEY_FILE: &str = "credentials.key";
const NONCE_LEN: usize = 12;

/// 凭据后端。会透传给设置页，用于告知用户当前实际的存储方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Backend {
    Keyring,
    EncryptedFile,
}

pub trait CredentialStore: Send + Sync {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError>;
    fn load(&self) -> Result<Option<(String, String)>, AppError>;
    fn forget(&self) -> Result<(), AppError>;
    fn backend(&self) -> Backend;
}

/// 用户名与密码一起编码存放，避免多开一个钥匙串条目。
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
fn restrict_permissions(path: &Path) {
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

// ---------- 系统钥匙串 ----------

const SERVICE: &str = "com.zhizhengroup.deploy";
const ACCOUNT: &str = "itsm";

pub struct KeyringStore;

impl KeyringStore {
    fn entry() -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|e| AppError::config(format!("访问系统钥匙串失败：{e}")))
    }

    /// 探测系统钥匙串是否真的可用。
    ///
    /// 不能只看 `Entry::new` 是否成功：Linux 上没有 Secret Service 时，
    /// 构造能过，真正写入才会失败。因此写一次再读回。
    pub fn available() -> bool {
        let Ok(e) = keyring::Entry::new(SERVICE, "__probe__") else {
            return false;
        };
        let probe = "probe";
        if e.set_password(probe).is_err() {
            return false;
        }
        let ok = e.get_password().map(|v| v == probe).unwrap_or(false);
        let _ = e.delete_credential();
        ok
    }
}

impl CredentialStore for KeyringStore {
    fn save(&self, username: &str, password: &str) -> Result<(), AppError> {
        Self::entry()?
            .set_password(&encode(username, password))
            .map_err(|e| AppError::config(format!("写入钥匙串失败：{e}")))
    }

    fn load(&self) -> Result<Option<(String, String)>, AppError> {
        match Self::entry()?.get_password() {
            Ok(payload) => decode(&payload),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::config(format!("读取钥匙串失败：{e}"))),
        }
    }

    fn forget(&self) -> Result<(), AppError> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::config(format!("清除钥匙串失败：{e}"))),
        }
    }

    fn backend(&self) -> Backend {
        Backend::Keyring
    }
}

// ---------- 加密文件降级 ----------

/// 注意其安全等级：密钥与密文存放在同一台机器的同一目录下。
/// 它只保证"文件被拷走或随手打开时看不到明文"，
/// **不能**防御已经能在本机读文件系统的攻击者。
/// 设置页会向用户明示这一点（见 spec §12）。
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
        if let Some(parent) = self.key_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&self.key_path, key)
            .map_err(|e| AppError::io(format!("写入密钥失败：{e}")))?;
        restrict_permissions(&self.key_path);
        Ok(key)
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

        if let Some(parent) = self.data_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::io(format!("创建目录失败：{e}")))?;
        }
        std::fs::write(&self.data_path, out)
            .map_err(|e| AppError::io(format!("写入凭据失败：{e}")))?;
        restrict_permissions(&self.data_path);
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

    fn backend(&self) -> Backend {
        Backend::EncryptedFile
    }
}

/// 优先用系统钥匙串；不可用时降级到加密文件。
pub fn detect_store(app_data_dir: &Path) -> Box<dyn CredentialStore> {
    if KeyringStore::available() {
        Box::new(KeyringStore)
    } else {
        Box::new(EncryptedFileStore::new(
            app_data_dir.join(CREDENTIALS_FILE),
        ))
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
        assert!(dir.path().join("credentials.key").exists(), "不应删除密钥文件");
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
    fn backend_is_reported_for_settings_page() {
        let dir = TempDir::new().unwrap();
        assert_eq!(store(&dir).backend(), Backend::EncryptedFile);
    }

    /// 会访问真实系统钥匙串，因此标记 ignore，需手动运行：
    ///   cargo test --lib secure -- --ignored --nocapture
    /// 探测使用独立的 __probe__ 账号，不会碰到真实凭据。
    #[test]
    #[ignore = "会访问真实系统钥匙串，需手动运行"]
    fn keyring_availability_probe() {
        println!("系统钥匙串可用 = {}", KeyringStore::available());
    }

    #[cfg(unix)]
    #[test]
    fn files_are_created_with_restrictive_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new().unwrap();
        let s = store(&dir);
        s.save("a", "1").unwrap();
        for name in ["credentials.bin", "credentials.key"] {
            let mode = std::fs::metadata(dir.path().join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "{name} 权限应为 0600，实际 {mode:o}");
        }
    }
}
