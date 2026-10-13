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

/// 尽量取出 CSRF；取不到时返回**空串**。
///
/// 这里刻意不做强制校验。依据有两条，都是实测得到的：
///
/// 1. ITSM **根本不下发 csrftoken cookie**——登录前后都只有 sessionid。
///    见 `examples/probe_cookies.rs` 的输出。
/// 2. 已在线运行的插件在取不到 csrftoken 时也是发空值
///    （`src/api/client.ts:43-45`），而部署功能一直正常。
///
/// 即服务端并未启用 CSRF 校验，这个 cookie 从来不是必需项。
/// 早期实现写成"缺失就报错"，导致提交部署直接失败。
///
/// 保留该字段是为了对齐插件行为：若将来服务端补上 csrftoken，
/// 这里会自然带上真实值，无需再改。
pub fn csrf_or_empty(cookie_header: Option<&str>) -> String {
    cookie_header.and_then(extract_csrf).unwrap_or_default()
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
    fn csrf_or_empty_returns_empty_when_missing() {
        // 服务端不下发 csrftoken 是常态，绝不能因此报错
        assert_eq!(csrf_or_empty(Some("sessionid=abc")), "");
        assert_eq!(csrf_or_empty(None), "");
    }

    #[test]
    fn csrf_or_empty_returns_real_token_when_present() {
        assert_eq!(csrf_or_empty(Some("sessionid=abc; csrftoken=T0K")), "T0K");
    }
}
