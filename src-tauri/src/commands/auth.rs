use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use crate::commands::config;
use crate::error::AppError;
use crate::net::client::HttpClient;
use crate::net::redirect::is_login_redirect;
use crate::secure::Backend;
use crate::session::SessionState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub logged_in: bool,
    pub username: String,
    pub base_url: String,
    pub credential_backend: Backend,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginResult {
    pub ok: bool,
    pub message: String,
}

impl LoginResult {
    fn ok() -> Self {
        Self {
            ok: true,
            message: String::new(),
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: message.into(),
        }
    }
}

/// 走一次真实的登录流程。
///
/// 步骤与插件 `src/api/deploy.ts:96-131` 一致：
/// 1. GET /login/ 拿初始 sessionid 与 csrftoken（由 Cookie Jar 自动保存）；
/// 2. POST /login/ 提交 username/password（不带 CSRF，与插件一致）；
/// 3. 校验登录是否真的生效。
///
/// 第 3 步是相对插件的改进：插件仅凭"响应里出现了 sessionid"判断成功
/// （`src/api/deploy.ts:126`），而服务端在认证失败时也可能下发新 session，
/// 会造成"密码错了却提示登录成功"。这里额外发一次受保护请求来确认。
pub async fn login_flow(
    client: &HttpClient,
    username: &str,
    password: &str,
) -> Result<(), AppError> {
    // 1. 预热：触发服务端下发 sessionid 与 csrftoken
    client.get("/login/", &[]).await?;

    // 2. 提交登录表单
    let form = vec![
        ("username".to_string(), username.to_string()),
        ("password".to_string(), password.to_string()),
    ];
    let resp = client.post_raw("/login/", &form).await?;
    if is_login_redirect(resp.status, resp.location.as_deref()) {
        return Err(AppError::auth("用户名或密码错误"));
    }

    // 3. 用一次受保护请求确认登录态真的生效
    let probe = client.get("/deployment/deploy/task/", &[]).await?;
    if is_login_redirect(probe.status, probe.location.as_deref()) {
        return Err(AppError::auth("用户名或密码错误"));
    }
    Ok(())
}

#[tauri::command]
pub async fn auth_status<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<AuthStatus, AppError> {
    let cfg = config::load(&app)?;
    Ok(AuthStatus {
        logged_in: session.is_logged_in().await,
        username: cfg.username,
        base_url: cfg.base_url,
        credential_backend: session.credentials.backend(),
    })
}

#[tauri::command]
pub async fn auth_login<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
    username: String,
    password: String,
    remember: bool,
) -> Result<LoginResult, AppError> {
    let mut cfg = config::load(&app)?;

    // 登录可能用的是刚改过的地址，确保客户端指向它
    session.rebuild_client(&cfg.base_url).await;

    match session.perform_login(&username, &password).await {
        Ok(()) => {
            cfg.username = username.clone();
            config::save(&app, &cfg)?;
            if remember {
                session.credentials.save(&username, &password)?;
            } else {
                session.credentials.forget()?;
            }
            Ok(LoginResult::ok())
        }
        // 登录失败不作为 Err 抛出：前端需要用统一结构展示 message
        Err(e) => Ok(LoginResult::failed(e.message)),
    }
}

#[tauri::command]
pub async fn auth_logout<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<(), AppError> {
    let mut cfg = config::load(&app)?;
    cfg.username = String::new();
    config::save(&app, &cfg)?;
    session.clear_cookies().await;
    // 登出即清除凭据：不清的话下次启动会静默登回去，用户会以为登出无效
    session.credentials.forget()?;
    Ok(())
}

/// 前端收到 `auth://expired` 后调用，用保存的凭据再试一次
#[tauri::command]
pub async fn auth_relogin<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
) -> Result<LoginResult, AppError> {
    let cfg = config::load(&app)?;
    session.rebuild_client(&cfg.base_url).await;

    let Some((user, pass)) = session.credentials.load()? else {
        return Ok(LoginResult::failed("没有保存的凭据"));
    };
    match session.perform_login(&user, &pass).await {
        Ok(()) => Ok(LoginResult::ok()),
        Err(e) => Ok(LoginResult::failed(e.message)),
    }
}

/// 登录页用：在未登录状态下修改 ITSM 地址
#[tauri::command]
pub async fn set_base_url<R: Runtime>(
    app: AppHandle<R>,
    session: State<'_, SessionState>,
    base_url: String,
) -> Result<(), AppError> {
    let mut cfg = config::load(&app)?;
    cfg.base_url = base_url.trim_end_matches('/').to_string();
    config::save(&app, &cfg)?;
    // 换地址必须重建客户端：旧 Cookie 对新域名无意义
    session.rebuild_client(&cfg.base_url).await;
    Ok(())
}

/// 应用启动时若钥匙串里有凭据，静默续登一次。
/// 失败是正常情况（没存过凭据、密码已改），返回 false 即可，不报错。
pub async fn try_silent_login<R: Runtime>(
    app: &AppHandle<R>,
    session: &SessionState,
) -> Result<bool, AppError> {
    let cfg = config::load(app)?;
    if cfg.username.is_empty() {
        return Ok(false);
    }
    let Ok(Some((user, pass))) = session.credentials.load() else {
        return Ok(false);
    };
    match session.perform_login(&user, &pass).await {
        Ok(()) => Ok(true),
        Err(_) => Ok(false),
    }
}
