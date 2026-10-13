//! 真实环境端到端验证：会话被服务端失效后，自动续登能否无感恢复。
//!
//! 这是 spec §2.1 第 4 条与 §4.1 的验收测试。单元测试（src/net/relogin.rs）
//! 用 mock server 覆盖了逻辑，但"服务端真的会为失效 session 返回指向
//! /login/ 的 302"这件事只有连真实 ITSM 才能确认。
//!
//! 会访问真实内网服务并消耗一次登录，因此标记 ignore，手动运行：
//!   cargo test --test relogin_e2e -- --ignored --nocapture
//!
//! 前置条件：先在应用里登录并勾选「记住密码」，让凭据进入系统钥匙串。

use zz_deploy_desktop_lib::commands::config::DEFAULT_BASE_URL;
use zz_deploy_desktop_lib::net::redirect::is_login_redirect;
use zz_deploy_desktop_lib::net::relogin::Method;
use zz_deploy_desktop_lib::secure::detect_store;
use zz_deploy_desktop_lib::session::SessionState;

#[tokio::test]
#[ignore = "会访问真实 ITSM 服务并消耗一次登录，需手动运行"]
async fn session_expiry_triggers_silent_relogin() {
    // 用临时目录：只关心钥匙串分支，加密文件分支不参与
    let scratch = std::env::temp_dir().join("zz-deploy-relogin-e2e");
    let credentials = detect_store(&scratch);

    let Some((user, pass)) = credentials.load().expect("读取凭据失败") else {
        panic!("钥匙串里没有凭据：请先在应用里登录并勾选「记住密码」");
    };
    println!("凭据读取成功，用户名 = {user}");

    let state = SessionState::new(DEFAULT_BASE_URL, credentials);

    // ---- 步骤 1：用真实凭据登录 ----
    state
        .perform_login(&user, &pass)
        .await
        .expect("首次登录失败（检查内网/VPN 连通性与密码是否已改）");

    let cookie = state
        .client()
        .await
        .cookie_header()
        .await
        .unwrap_or_default();
    assert!(cookie.contains("sessionid="), "登录后 Cookie 里应有 sessionid");
    println!("步骤 1 通过：已登录，Cookie 长度 = {}", cookie.len());

    // ---- 步骤 2：基线请求应当正常 ----
    let baseline = state
        .request(Method::Get, "/deployment/deploy/task/", &[], &[])
        .await
        .expect("基线请求失败");
    assert!(
        !is_login_redirect(baseline.status, baseline.location.as_deref()),
        "基线请求就被踢到登录页，说明登录没生效"
    );
    println!("步骤 2 通过：基线请求 status = {}", baseline.status);

    // ---- 步骤 3：把 sessionid 换成垃圾值，模拟服务端已使会话失效 ----
    state
        .client()
        .await
        .seed_cookie("sessionid=definitely-expired-session-value")
        .await;

    let tampered = state
        .client()
        .await
        .cookie_header()
        .await
        .unwrap_or_default();
    assert!(
        tampered.contains("definitely-expired-session-value"),
        "伪造的 sessionid 未写入 Cookie Jar，该用例无效"
    );
    println!("步骤 3 通过：已把 sessionid 替换为失效值");

    // ---- 步骤 4：再发同一个请求，应自动续登并重放成功 ----
    let recovered = state
        .request(Method::Get, "/deployment/deploy/task/", &[], &[])
        .await
        .expect("自动续登链路失败：请求返回了 Auth 错误");

    assert!(
        !is_login_redirect(recovered.status, recovered.location.as_deref()),
        "续登后仍被要求登录（status={}, location={:?}）",
        recovered.status,
        recovered.location
    );
    assert!(
        recovered.body.contains("table") || recovered.body.contains("<html"),
        "续登后的响应体不像任务列表页面，长度 = {}",
        recovered.body.len()
    );

    // 续登后 Cookie 应已更新，不再是伪造的那个
    let after = state
        .client()
        .await
        .cookie_header()
        .await
        .unwrap_or_default();
    assert!(
        !after.contains("definitely-expired-session-value"),
        "续登后 Cookie 仍是失效值，说明登录没真正重新执行"
    );

    println!(
        "步骤 4 通过：会话失效后自动续登成功，响应长度 = {} 字节",
        recovered.body.len()
    );
    println!("✅ 端到端验证通过：会话过期 → 静默续登 → 重放原请求，全程用户无感");
}
