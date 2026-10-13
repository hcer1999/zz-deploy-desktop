//! 诊断工具：看 ITSM 在登录各阶段到底下发了哪些 cookie，以及 POST 是否真的需要 CSRF。
//!
//!   cargo run --example probe_cookies
//!
//! 只打印 cookie 的**名字与值长度**，不打印值本身。

use std::error::Error;

use zz_deploy_desktop_lib::net::client::HttpClient;
use zz_deploy_desktop_lib::secure::detect_store;

/// 把 "a=1; b=2" 变成 "a(len=1), b(len=1)"，避免把凭据打到终端
fn describe(header: &Option<String>) -> String {
    match header {
        None => "<无 cookie>".to_string(),
        Some(h) => h
            .split(';')
            .map(|p| {
                let p = p.trim();
                match p.split_once('=') {
                    Some((k, v)) => format!("{k}(len={})", v.len()),
                    None => p.to_string(),
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let credentials = detect_store(&std::env::temp_dir().join("zz-deploy-probe"));
    let (user, pass) = credentials
        .load()?
        .ok_or("钥匙串里没有凭据：请先在应用里登录并勾选「记住密码」")?;

    let base_url = std::env::var("ZZ_ITSM_BASE_URL")
        .unwrap_or_else(|_| "https://itsm.zhizhengroup.com".to_string());
    let client = HttpClient::new(&base_url);
    println!("目标 {base_url}，用户 {user}\n");

    println!("1) 初始状态");
    println!("   cookie: {}", describe(&client.cookie_header().await));

    println!("\n2) GET /login/（拿初始 session 与 csrf）");
    let r = client.get("/login/", &[]).await?;
    println!("   status = {}", r.status);
    println!("   cookie: {}", describe(&client.cookie_header().await));

    println!("\n3) POST /login/（登录）");
    let form = vec![
        ("username".to_string(), user.clone()),
        ("password".to_string(), pass.clone()),
    ];
    let r = client.post_raw("/login/", &form).await?;
    println!("   status = {}  location = {:?}", r.status, r.location);
    let after_login = client.cookie_header().await;
    println!("   cookie: {}", describe(&after_login));

    let has_csrf = after_login
        .as_deref()
        .map(|h| h.contains("csrftoken="))
        .unwrap_or(false);
    println!("\n   >>> 登录后是否持有 csrftoken: {has_csrf}");

    println!("\n4) GET /deployment/deploy/submit/?env=1（受保护页面，看是否被踢到登录页）");
    let r = client.get("/deployment/deploy/submit/", &[("env".into(), "1".into())]).await?;
    println!("   status = {}  location = {:?}", r.status, r.location);
    println!("   body 长度 = {}", r.body.len());

    println!("\n5) 无害的真实 POST 探测：服务端是否真的强制 CSRF");
    // 往只接受 GET 的任务列表页发一个空 POST：
    //   若 CSRF 中间件启用  → 403 Forbidden
    //   若未启用            → 405 Method Not Allowed（或 200）
    // 这样既能判定结论，又不会真的建出部署任务。
    let r = client.post("/deployment/deploy/task/", &[]).await?;
    println!("   status = {}", r.status);
    match r.status {
        403 => println!("   >>> 403：服务端强制 CSRF，必须拿到真实 token"),
        // Django 的 CSRF 失败**一定**返回 403（CsrfViewMiddleware::_reject）。
        // 因此非 403 就说明请求已经穿过了 CSRF 中间件、进到了视图层。
        // 500 是因为往 GET-only 的视图发了空 POST，属预期的视图层错误。
        other => println!(
            "   >>> {other}：非 403，说明请求已穿过 CSRF 中间件，空 token 被接受"
        ),
    }

    println!("\n6) 结论");
    if has_csrf {
        println!("   服务端确实下发了 csrftoken，缺它说明别处把它弄丢了");
    } else {
        println!("   服务端**没有**下发 csrftoken（或未保留）。");
        println!("   那么 Rust 侧 post() 里 require_csrf 的强校验就是错的——");
        println!("   插件的 post 在取不到 csrftoken 时会发空串（src/api/client.ts:43-45），");
        println!("   即它从未真正依赖过这个 cookie。");
    }

    Ok(())
}
