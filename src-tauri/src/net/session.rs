use std::future::Future;

use crate::error::AppError;
use crate::net::client::{HttpClient, HttpResult};
use crate::net::redirect::is_login_redirect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

async fn send(
    client: &HttpClient,
    method: Method,
    path: &str,
    query: &[(String, String)],
    form: &[(String, String)],
) -> Result<HttpResult, AppError> {
    match method {
        Method::Get => client.get(path, query).await,
        Method::Post => client.post(path, form).await,
    }
}

/// 带"会话过期自动续登"的请求。
///
/// 行为：
/// 1. 先正常发一次；
/// 2. 若响应是 302 且指向登录页，判定会话过期，调用 `relogin`；
/// 3. 续登成功后**只重放一次**原请求；
/// 4. 重放后仍指向登录页，报 Auth 错误。
///
/// 第 4 条是硬约束：绝不能循环重试。会话已经失效而密码又不对时，
/// 循环会把服务端打爆，也会把账号刷到风控。
///
/// `relogin` 用闭包注入，使本函数不依赖 Tauri 状态，可用 wiremock 单测。
pub async fn execute_with_relogin<F, Fut>(
    client: &HttpClient,
    method: Method,
    path: &str,
    query: &[(String, String)],
    form: &[(String, String)],
    relogin: F,
) -> Result<HttpResult, AppError>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), AppError>>,
{
    let first = send(client, method, path, query, form).await?;
    if !is_login_redirect(first.status, first.location.as_deref()) {
        return Ok(first);
    }

    relogin().await?;

    let second = send(client, method, path, query, form).await?;
    if is_login_redirect(second.status, second.location.as_deref()) {
        return Err(AppError::auth(
            "自动续登后仍被要求登录，请确认账号权限或重新登录",
        ));
    }
    Ok(second)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::client::HttpClient;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// 第一次请求被踢到登录页，续登后正常返回
    async fn server_requiring_relogin() -> MockServer {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", "/login/?next=/protected"),
            )
            .up_to_n_times(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/protected"))
            .respond_with(ResponseTemplate::new(200).set_body_string("secret-data"))
            .mount(&server)
            .await;
        server
    }

    #[tokio::test]
    async fn normal_response_does_not_trigger_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/ok"))
            .respond_with(ResponseTemplate::new(200).set_body_string("fine"))
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let r = execute_with_relogin(&c, Method::Get, "/ok", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok::<(), AppError>(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.body, "fine");
        assert_eq!(calls.load(Ordering::SeqCst), 0, "不应触发续登");
    }

    #[tokio::test]
    async fn login_redirect_triggers_relogin_and_replays_once() {
        let server = server_requiring_relogin().await;
        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();

        let r = execute_with_relogin(&c, Method::Get, "/protected", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok::<(), AppError>(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.status, 200);
        assert_eq!(r.body, "secret-data");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "应恰好续登一次");
    }

    #[tokio::test]
    async fn business_redirect_does_not_trigger_relogin() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/submit-task"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", "/deployment/deploy/task/"),
            )
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let r = execute_with_relogin(&c, Method::Get, "/submit-task", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok::<(), AppError>(())
            }
        })
        .await
        .unwrap();

        assert_eq!(r.status, 302);
        assert_eq!(calls.load(Ordering::SeqCst), 0, "业务 302 不该触发续登");
    }

    #[tokio::test]
    async fn relogin_failure_propagates_error() {
        let server = server_requiring_relogin().await;
        let c = HttpClient::new(&server.uri());

        let err = execute_with_relogin(&c, Method::Get, "/protected", &[], &[], || async {
            Err(crate::error::AppError::auth("密码已失效"))
        })
        .await
        .unwrap_err();

        assert_eq!(err.kind, crate::error::ErrorKind::Auth);
        assert_eq!(err.message, "密码已失效");
    }

    #[tokio::test]
    async fn still_redirected_after_relogin_is_reported_not_looped() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/always-login"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/login/"))
            .mount(&server)
            .await;

        let c = HttpClient::new(&server.uri());
        let calls = Arc::new(AtomicUsize::new(0));
        let n = calls.clone();
        let err = execute_with_relogin(&c, Method::Get, "/always-login", &[], &[], || {
            let n = n.clone();
            async move {
                n.fetch_add(1, Ordering::SeqCst);
                Ok::<(), AppError>(())
            }
        })
        .await
        .unwrap_err();

        assert_eq!(err.kind, crate::error::ErrorKind::Auth);
        assert_eq!(calls.load(Ordering::SeqCst), 1, "续登只允许一次，不能死循环");
    }
}
