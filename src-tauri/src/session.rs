use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use tokio::sync::{broadcast, Mutex, RwLock};

use crate::error::AppError;
use crate::net::client::{HttpClient, HttpResult};
use crate::net::relogin::{execute_with_relogin, Method};
use crate::secure::CredentialStore;

/// 全局会话：持有 HTTP 客户端、凭据存储，以及"当前是否已登录"的依据。
///
/// Cookie 只活在这里的内存中，**不落盘**（spec §7）。应用重启后靠钥匙串里的
/// 密码静默续登，用户无感。
pub struct SessionState {
    client: RwLock<Arc<HttpClient>>,
    pub credentials: Box<dyn CredentialStore>,
    /// 续登期间串行化，避免多个请求同时发起登录
    relogin_lock: Mutex<()>,
    /// 每次成功登录自增。用来识别"别的请求已经替我把会话续上了"，
    /// 避免并发过期时重复登录。
    login_generation: AtomicU64,
    /// 续登失败时通过它广播 auth://expired；由 lib.rs 注入
    expired_tx: OnceLock<broadcast::Sender<String>>,
}

impl SessionState {
    pub fn new(base_url: &str, credentials: Box<dyn CredentialStore>) -> Self {
        Self {
            client: RwLock::new(Arc::new(HttpClient::new(base_url))),
            credentials,
            relogin_lock: Mutex::new(()),
            login_generation: AtomicU64::new(0),
            expired_tx: OnceLock::new(),
        }
    }

    pub fn set_expired_sender(&self, tx: broadcast::Sender<String>) {
        let _ = self.expired_tx.set(tx);
    }

    pub async fn client(&self) -> Arc<HttpClient> {
        self.client.read().await.clone()
    }

    pub async fn rebuild_client(&self, base_url: &str) {
        let mut w = self.client.write().await;
        *w = Arc::new(HttpClient::new(base_url));
    }

    /// 丢弃全部 cookie（换地址或登出时调用）
    pub async fn clear_cookies(&self) {
        let url = {
            let c = self.client.read().await;
            c.base_url().to_string()
        };
        self.rebuild_client(&url).await;
    }

    /// 判据：Cookie Jar 里还有 sessionid。
    /// 注意这只说明"有过会话"，不代表服务端仍认它——那要靠 302 判定。
    pub async fn is_logged_in(&self) -> bool {
        let c = self.client.read().await;
        c.cookie_header()
            .await
            .map(|h| h.contains("sessionid="))
            .unwrap_or(false)
    }

    /// 完整的登录流程，并在成功后推进登录代际。
    /// `auth_login` / 静默续登 / 自动续登 都走这里，保证代际计数不漏。
    pub async fn perform_login(&self, username: &str, password: &str) -> Result<(), AppError> {
        let client = self.client().await;
        crate::commands::auth::login_flow(&client, username, password).await?;
        self.login_generation.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    /// 所有业务请求的统一入口：带自动续登。
    pub async fn request(
        &self,
        method: Method,
        path: &str,
        query: &[(String, String)],
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let client = self.client().await;
        // 记住发起时的代际；续登时据此判断是否已被并发请求处理过
        let generation_before = self.login_generation.load(Ordering::SeqCst);

        let result = execute_with_relogin(&client, method, path, query, form, || async {
            let _guard = self.relogin_lock.lock().await;

            // 握锁后复查：若已有别的请求完成过续登，直接让外层重放即可，
            // 不必再登录一次（否则 N 个并发请求会触发 N 次登录）。
            if self.login_generation.load(Ordering::SeqCst) != generation_before {
                return Ok(());
            }

            let Some((user, pass)) = self.credentials.load()? else {
                return Err(AppError::auth("会话已过期，且没有保存的凭据"));
            };
            self.perform_login(&user, &pass).await
        })
        .await;

        if let Err(e) = &result {
            if e.kind == crate::error::ErrorKind::Auth {
                self.notify_expired(&e.message);
            }
        }
        result
    }

    fn notify_expired(&self, message: &str) {
        if let Some(tx) = self.expired_tx.get() {
            // 没有订阅者时返回 Err，属正常情况（前端未挂载），忽略即可
            let _ = tx.send(message.to_string());
        }
    }
}
