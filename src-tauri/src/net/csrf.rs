use crate::error::AppError;

/// 从 cookie 字符串里取出 `csrftoken` 的值。
///
/// 对应插件 `src/api/client.ts:43` 的 `cookie.match(/csrftoken=([^;]+)/)`。
/// 逐段比对而不是正则，避免引入 regex 依赖。
pub fn extract_csrf(cookie: &str) -> Option<String> {
    cookie.split(';').find_map(|pair| {
        let pair = pair.trim();
        pair.strip_prefix("csrftoken=").map(|v| v.to_string())
    })
}

/// 往表单里塞 CSRF。
///
/// **注意字段名**：请求体里是 `csrfmiddlewaretoken`，而 cookie 名是 `csrftoken`，
/// 两者不同名。对应插件 `src/api/client.ts:45`。
/// 若表单里已存在同名字段则替换，避免出现两个导致服务端取值不确定。
pub fn with_csrf(mut form: Vec<(String, String)>, token: &str) -> Vec<(String, String)> {
    form.retain(|(k, _)| k != "csrfmiddlewaretoken");
    form.push(("csrfmiddlewaretoken".to_string(), token.to_string()));
    form
}

/// 从请求头形式的 cookie 串里读出 CSRF；读不到时报 Auth 错误。
/// 没有 CSRF 的 POST 一定会被服务端拒绝，早报错比让服务端报 403 更清晰。
pub fn require_csrf(cookie_header: Option<&str>) -> Result<String, AppError> {
    cookie_header
        .and_then(extract_csrf)
        .ok_or_else(|| AppError::auth("cookie 中缺少 csrftoken，请重新登录"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_csrf_from_cookie_string() {
        let cookie = "sessionid=abc123; csrftoken=XYZ789; other=1";
        assert_eq!(extract_csrf(cookie), Some("XYZ789".to_string()));
    }

    #[test]
    fn returns_none_when_csrf_absent() {
        assert_eq!(extract_csrf("sessionid=abc123"), None);
    }

    #[test]
    fn handles_csrf_as_first_pair() {
        let cookie = "csrftoken=AAA; sessionid=b";
        assert_eq!(extract_csrf(cookie), Some("AAA".to_string()));
    }

    #[test]
    fn does_not_match_csrftoken_as_substring_of_longer_name() {
        // 例如 XSRF-TOKEN 这类名字不应被误认为 csrftoken
        assert_eq!(extract_csrf("prefix-csrftoken=nope"), None);
    }

    #[test]
    fn adds_csrfmiddlewaretoken_not_csrftoken() {
        let form = vec![("title".to_string(), "deploy".to_string())];
        let out = with_csrf(form, "TOKEN");
        assert!(out.contains(&("csrfmiddlewaretoken".to_string(), "TOKEN".to_string())));
        assert!(!out.iter().any(|(k, _)| k == "csrftoken"));
        assert!(out.contains(&("title".to_string(), "deploy".to_string())));
    }

    #[test]
    fn replaces_existing_csrfmiddlewaretoken_rather_than_duplicating() {
        let form = vec![("csrfmiddlewaretoken".to_string(), "OLD".to_string())];
        let out = with_csrf(form, "NEW");
        assert_eq!(
            out.iter()
                .filter(|(k, _)| k == "csrfmiddlewaretoken")
                .count(),
            1
        );
        assert!(out.contains(&("csrfmiddlewaretoken".to_string(), "NEW".to_string())));
    }

    #[test]
    fn require_csrf_reports_auth_error_when_missing() {
        let err = require_csrf(Some("sessionid=abc")).unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Auth);

        let err = require_csrf(None).unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Auth);
    }
}
