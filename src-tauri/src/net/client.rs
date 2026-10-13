use std::sync::Arc;

use reqwest::Client;
use reqwest::cookie::{CookieStore, Jar};
use reqwest::redirect::Policy;
use serde::Serialize;
use url::Url;

use crate::error::AppError;
use crate::net::csrf::{csrf_or_empty, with_csrf};

/// 与插件 `src/api/client.ts:4-8` 保持一致的请求头。
/// User-Agent 必须伪装成浏览器：服务端会据此判断客户端类型。
const COMMON_HEADERS: &[(&str, &str)] = &[
    (
        "Accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    ),
    ("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8"),
    (
        "User-Agent",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    ),
];

const COOKIE_ATTRIBUTES: &[&str] = &[
    "path", "domain", "expires", "max-age", "httponly", "secure", "samesite",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    pub status: u16,
    /// 302 的跳转目标。语义判定交给上层（见 `net::redirect`）。
    pub location: Option<String>,
    pub body: String,
}

/// 不依赖任何 Tauri 状态的 HTTP 客户端，可直接用 wiremock 单测。
///
/// Cookie 全部由 reqwest 的 Cookie Jar 管理，前端永远接触不到 cookie 明文。
pub struct HttpClient {
    inner: Client,
    jar: Arc<Jar>,
    base_url: String,
}

impl HttpClient {
    pub fn new(base_url: &str) -> Self {
        let jar = Arc::new(Jar::default());
        let inner = Client::builder()
            // 必须手动处理重定向：302 是业务语义的一部分
            .redirect(Policy::none())
            .cookie_provider(jar.clone())
            .build()
            .expect("构建 reqwest client 失败");
        Self {
            inner,
            jar,
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// 拒绝绝对 URL 与协议相对 URL，只允许以 `/` 开头的站内路径。
    /// 目的是防止 baseUrl 被绕过，向任意主机发请求。
    pub fn validate_path(&self, path: &str) -> Result<(), AppError> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(AppError::config(format!(
                "只允许站内相对路径，收到：{path}"
            )));
        }
        Ok(())
    }

    fn url_for(&self, path: &str) -> Result<Url, AppError> {
        self.validate_path(path)?;
        Url::parse(&format!("{}{}", self.base_url, path))
            .map_err(|e| AppError::config(format!("URL 拼接失败：{e}")))
    }

    /// 预置 cookie。登录成功后写入；应用启动时不需要——cookie 不落盘。
    ///
    /// 注意：`Jar::add_cookie_str` 是按**单条 Set-Cookie** 语义解析的，
    /// 整串 `"a=1; b=2"` 会被当成一个 cookie 而丢掉后半部分。
    /// 因此这里按 `;` 拆开逐条写入，并跳过 Path/HttpOnly 这类属性段。
    pub async fn seed_cookie(&self, cookie: &str) {
        let Ok(url) = Url::parse(&self.base_url) else {
            return;
        };
        for part in cookie.split(';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let name = part.split('=').next().unwrap_or("").trim().to_lowercase();
            if name.is_empty() || COOKIE_ATTRIBUTES.contains(&name.as_str()) {
                continue;
            }
            self.jar.add_cookie_str(&format!("{part}; Path=/"), &url);
        }
    }

    /// 取出当前所有 cookie 拼成的请求头。
    /// 两个用途：POST 时提取 CSRF；后续 WebSocket 握手时带 Cookie 头。
    pub async fn cookie_header(&self) -> Option<String> {
        let url = Url::parse(&self.base_url).ok()?;
        let cookies = self.jar.cookies(&url)?;
        cookies.to_str().ok().map(|s| s.to_string())
    }

    pub async fn get(
        &self,
        path: &str,
        query: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let mut url = self.url_for(path)?;
        if !query.is_empty() {
            let mut qp = url.query_pairs_mut();
            for (k, v) in query {
                qp.append_pair(k, v);
            }
            drop(qp);
        }
        let req = self.inner.get(url.clone());
        self.execute(req, &url).await
    }

    /// 业务 POST。
    ///
    /// CSRF 是**尽力而为**而不是必需项：ITSM 不下发 csrftoken cookie，
    /// 已在线运行的插件也是发空值（`src/api/client.ts:43-45`）。
    /// 详见 `net::csrf::csrf_or_empty`。
    pub async fn post(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let url = self.url_for(path)?;
        let cookie = self.cookie_header().await;
        let token = csrf_or_empty(cookie.as_deref());
        let body = with_csrf(form.to_vec(), &token);

        let req = self
            .inner
            .post(url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("X-CSRFToken", token)
            .form(&body);
        self.execute(req, &url).await
    }

    /// 不带 CSRF 的 POST，仅用于登录接口。
    ///
    /// 登录页在未认证状态下拿不到配对的 csrftoken，插件也是直接发纯
    /// username/password（见 `src/api/deploy.ts:110`），此处保持一致。
    pub async fn post_raw(
        &self,
        path: &str,
        form: &[(String, String)],
    ) -> Result<HttpResult, AppError> {
        let url = self.url_for(path)?;
        let req = self
            .inner
            .post(url.clone())
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(form);
        self.execute(req, &url).await
    }

    async fn execute(
        &self,
        mut req: reqwest::RequestBuilder,
        url: &Url,
    ) -> Result<HttpResult, AppError> {
        for (k, v) in COMMON_HEADERS {
            req = req.header(*k, *v);
        }
        // Django 在 HTTPS 下会校验 Referer 的主机是否匹配，因此必须带上。
        // 这里用完整 URL（含 query），与插件对 POST 的处理一致。
        req = req
            .header("Origin", &self.base_url)
            .header("Referer", url.as_str());

        let resp = req.send().await.map_err(AppError::from_reqwest)?;
        let status = resp.status().as_u16();
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let body = resp
            .text()
            .await
            .map_err(|e| AppError::network(format!("读取响应体失败：{e}")))?;

        Ok(HttpResult {
            status,
            location,
            body,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_string_contains, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn http_client(base: &str) -> HttpClient {
        HttpClient::new(base)
    }

    #[tokio::test]
    async fn get_returns_status_and_body() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/deployment/deploy/task/"))
            .respond_with(ResponseTemplate::new(200).set_body_string("<html>ok</html>"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let r = c.get("/deployment/deploy/task/", &[]).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, "<html>ok</html>");
        assert_eq!(r.location, None);
    }

    #[tokio::test]
    async fn sends_query_params() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/task/"))
            .and(query_param("page", "2"))
            .and(query_param("search", "zz-pay"))
            .respond_with(ResponseTemplate::new(200).set_body_string("ok"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let params = vec![
            ("page".to_string(), "2".to_string()),
            ("search".to_string(), "zz-pay".to_string()),
        ];
        let r = c.get("/task/", &params).await.unwrap();
        assert_eq!(r.status, 200);
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/redirect-me"))
            .respond_with(
                ResponseTemplate::new(302).insert_header("location", "/deployment/deploy/task/"),
            )
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let r = c.get("/redirect-me", &[]).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(r.location.as_deref(), Some("/deployment/deploy/task/"));
    }

    #[tokio::test]
    async fn post_sends_form_urlencoded_with_csrf() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/submit/"))
            .and(header("Content-Type", "application/x-www-form-urlencoded"))
            .and(header("X-CSRFToken", "TOK"))
            .and(body_string_contains("csrfmiddlewaretoken=TOK"))
            .and(body_string_contains("title=deploy"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/task/"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        c.seed_cookie("sessionid=s1; csrftoken=TOK").await;
        let form = vec![("title".to_string(), "deploy".to_string())];
        let r = c.post("/submit/", &form).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(r.location.as_deref(), Some("/task/"));
    }

    #[tokio::test]
    async fn post_without_csrf_cookie_still_sends_with_empty_token() {
        // 回归：曾经因为"缺 csrftoken 就报错"导致提交部署直接失败。
        // ITSM 不下发 csrftoken，服务端也未启用 CSRF 校验，
        // 插件同样发空值并成功（src/api/client.ts:43-45）。
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/submit/"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/task/"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        c.seed_cookie("sessionid=s1").await;
        let r = c.post("/submit/", &[("title".to_string(), "t".to_string())])
            .await
            .unwrap();

        assert_eq!(r.status, 302, "缺少 CSRF 时仍应正常发出并返回");
        let reqs = server.received_requests().await.unwrap();
        assert_eq!(reqs.len(), 1, "缺少 CSRF 时仍应发出请求");
        // 空值而非省略字段：与插件保持一致的请求形态
        let body = String::from_utf8(reqs[0].body.clone()).unwrap();
        assert!(body.contains("csrfmiddlewaretoken="), "实际 body：{body}");
    }

    #[tokio::test]
    async fn post_raw_sends_no_csrf() {
        // 登录接口不带 csrfmiddlewaretoken：
        // 对应插件 src/api/deploy.ts:110，body 里只有 username/password
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/login/"))
            .respond_with(ResponseTemplate::new(302).insert_header("location", "/"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        let form = vec![
            ("username".to_string(), "zhangsan".to_string()),
            ("password".to_string(), "pw".to_string()),
        ];
        let r = c.post_raw("/login/", &form).await.unwrap();
        assert_eq!(r.status, 302);

        let reqs = server.received_requests().await.unwrap();
        let body = String::from_utf8(reqs[0].body.clone()).unwrap();
        assert!(body.contains("username=zhangsan"), "实际 body：{body}");
        assert!(
            !body.contains("csrfmiddlewaretoken"),
            "登录请求不应带 CSRF 字段，实际 body：{body}"
        );
    }

    #[tokio::test]
    async fn seed_cookie_handles_multiple_pairs_and_ignores_attributes() {
        let c = http_client("https://example.com");
        c.seed_cookie("sessionid=s1; csrftoken=TOK; Path=/; HttpOnly")
            .await;
        let h = c.cookie_header().await.unwrap();
        assert!(h.contains("sessionid=s1"), "实际：{h}");
        assert!(h.contains("csrftoken=TOK"), "实际：{h}");
        assert!(
            !h.to_lowercase().contains("httponly"),
            "不应把属性当 cookie：{h}"
        );
    }

    #[tokio::test]
    async fn stores_and_replays_cookies_across_requests() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/set-cookie"))
            .respond_with(
                ResponseTemplate::new(200).insert_header("set-cookie", "sessionid=abc; Path=/"),
            )
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/needs-cookie"))
            .and(header("cookie", "sessionid=abc"))
            .respond_with(ResponseTemplate::new(200).set_body_string("authorized"))
            .mount(&server)
            .await;

        let c = http_client(&server.uri());
        c.get("/set-cookie", &[]).await.unwrap();
        let r = c.get("/needs-cookie", &[]).await.unwrap();
        assert_eq!(r.body, "authorized");
    }

    #[test]
    fn rejects_absolute_url_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        let err = c
            .validate_path("https://evil.example.com/steal")
            .unwrap_err();
        assert_eq!(err.kind, crate::error::ErrorKind::Config);
    }

    #[test]
    fn rejects_protocol_relative_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        assert!(c.validate_path("//evil.example.com/x").is_err());
    }

    #[test]
    fn accepts_rooted_relative_path() {
        let c = http_client("https://itsm.zhizhengroup.com");
        assert!(c.validate_path("/deployment/deploy/task/").is_ok());
    }

    #[test]
    fn base_url_trailing_slash_is_normalized() {
        let c = http_client("https://itsm.zhizhengroup.com/");
        assert_eq!(c.base_url(), "https://itsm.zhizhengroup.com");
    }
}
