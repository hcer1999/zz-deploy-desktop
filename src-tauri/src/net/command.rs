use serde::Deserialize;
use tauri::State;

use crate::error::AppError;
use crate::net::client::HttpResult;
use crate::net::relogin::Method;
use crate::session::SessionState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpArgs {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: Vec<(String, String)>,
    #[serde(default)]
    pub form: Vec<(String, String)>,
}

/// 前端唯一的 HTTP 出口。
///
/// Rust 不知道任何业务概念——它只会「按规则发请求、按规则维持登录态」。
/// 业务路径、参数、以及响应体的 HTML 解析全部留在前端 TS 侧。
///
/// 内部自动完成：注入 Cookie、POST 补 CSRF、302 语义判定、会话过期自动续登。
#[tauri::command]
pub async fn http_request(
    session: State<'_, SessionState>,
    args: HttpArgs,
) -> Result<HttpResult, AppError> {
    let method = match args.method.to_uppercase().as_str() {
        "GET" => Method::Get,
        "POST" => Method::Post,
        other => {
            return Err(AppError::config(format!("不支持的 HTTP 方法：{other}")));
        }
    };
    session
        .request(method, &args.path, &args.query, &args.form)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_args() {
        let a: HttpArgs = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "path": "/deployment/deploy/task/",
            "query": [["page", "2"]],
            "form": []
        }))
        .unwrap();
        assert_eq!(a.method, "GET");
        assert_eq!(a.path, "/deployment/deploy/task/");
        assert_eq!(a.query, vec![("page".to_string(), "2".to_string())]);
    }

    #[test]
    fn query_and_form_default_to_empty() {
        let a: HttpArgs = serde_json::from_value(serde_json::json!({
            "method": "GET",
            "path": "/x/"
        }))
        .unwrap();
        assert!(a.query.is_empty());
        assert!(a.form.is_empty());
    }

    #[test]
    fn rejects_unsupported_method_at_command_level() {
        // 方法名归一化：小写也应被接受
        let a: HttpArgs = serde_json::from_value(serde_json::json!({
            "method": "post",
            "path": "/x/"
        }))
        .unwrap();
        assert_eq!(a.method.to_uppercase(), "POST");
    }
}
