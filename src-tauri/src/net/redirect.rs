/// 判定一次响应是否代表"会话过期、被踢到登录页"。
///
/// 这是本层最重要的语义判定。插件把 `status === 302` 一律当成操作成功
/// （见 `src/api/deploy.ts:61`），于是 session 过期时提交部署会**误报成功**，
/// 实际后端什么都没执行。这里把两种情况区分开：
/// 302 指向登录页 = 会话过期；其余 302 = 业务成功。
///
/// 只看 location 的 path 部分并去掉末尾斜杠，避免 query 里出现的 `/login/`
/// （例如 `/task/?ref=/login/`）造成误判。
pub fn is_login_redirect(status: u16, location: Option<&str>) -> bool {
    if status != 302 {
        return false;
    }
    let Some(loc) = location else {
        return false;
    };
    let path = loc.split('?').next().unwrap_or("").trim_end_matches('/');
    path == "/login" || path == "login" || path.ends_with("/login")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_login_redirect_is_login() {
        let loc = "https://itsm.zhizhengroup.com/login/?next=/deployment/deploy/task/";
        assert!(is_login_redirect(302, Some(loc)));
    }

    #[test]
    fn relative_login_redirect_is_login() {
        assert!(is_login_redirect(302, Some("/login/?next=/")));
    }

    #[test]
    fn single_slash_login_is_login() {
        assert!(is_login_redirect(302, Some("/login/")));
    }

    #[test]
    fn bare_login_without_leading_slash_is_login() {
        assert!(is_login_redirect(302, Some("login/")));
    }

    #[test]
    fn business_redirect_is_not_login() {
        // 提交部署成功时服务端也返回 302，但指向任务列表
        assert!(!is_login_redirect(302, Some("/deployment/deploy/task/")));
    }

    #[test]
    fn only_302_counts() {
        assert!(!is_login_redirect(200, Some("/login/")));
        assert!(!is_login_redirect(301, Some("/login/")));
    }

    #[test]
    fn missing_location_is_not_login() {
        assert!(!is_login_redirect(302, None));
    }

    #[test]
    fn url_mentioned_in_query_is_not_a_login_redirect() {
        // 防止把 "/deployment/?ref=/login/" 这种路径误判为登录跳转
        assert!(!is_login_redirect(
            302,
            Some("/deployment/deploy/task/?ref=/login/")
        ));
    }

    #[test]
    fn path_merely_ending_in_login_without_slash_is_not_matched() {
        assert!(!is_login_redirect(302, Some("/notlogin")));
    }
}
