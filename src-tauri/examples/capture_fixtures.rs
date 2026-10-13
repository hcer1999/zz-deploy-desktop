//! 从真实 ITSM 抓取 HTML 快照，供 parser 的 fixture 快照测试使用。
//!
//! 运行（需内网/VPN，且钥匙串里已保存凭据）：
//!   cargo run --example capture_fixtures
//!
//! 产出写入 ../src/api/__fixtures__/。这些文件会提交进仓库——
//! 它们锁住了"服务端 HTML 长什么样"，是解析器唯一可靠的回归防线。

use std::error::Error;
use std::path::{Path, PathBuf};

use zz_deploy_desktop_lib::net::client::HttpClient;
use zz_deploy_desktop_lib::secure::detect_store;

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri 应有父目录")
        .join("src/api/__fixtures__")
}

fn save(dir: &Path, name: &str, html: &str) -> Result<(), Box<dyn Error>> {
    std::fs::write(dir.join(name), html)?;
    println!("  已保存 {name}（{} 字节）", html.len());
    Ok(())
}

fn extract_first_project_name(html: &str) -> Option<String> {
    let marker = "/submit/";
    let mut rest = html;
    while let Some(idx) = rest.find(marker) {
        let after = &rest[idx + marker.len()..];
        // 必须是 /submit/<数字>/ 才算项目链接，否则会误抓
        // 导航栏里的「提交上线」之类链接
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            if let Some(gt) = after.find('>') {
                if let Some(rel_close) = after[gt..].find("</a>") {
                    let name = after[gt + 1..gt + rel_close].trim();
                    if !name.is_empty() && name.len() < 120 {
                        return Some(name.to_string());
                    }
                }
            }
        }
        rest = after;
    }
    None
}

fn extract_first_branch(html: &str) -> Option<String> {
    let select = html.find("id=\"branchtag\"")?;
    let after = &html[select..];
    let opt = after.find("<option")?;
    let needle = "value=\"";
    let value_at = after[opt..].find(needle)? + opt + needle.len();
    let end = after[value_at..].find('"')? + value_at;
    let v = after[value_at..end].trim();
    if v.is_empty() { None } else { Some(v.to_string()) }
}

/// 从项目列表页里抠出第一个 `/submit/<id>/` 的 id，避免硬编码。
/// 这只是抓取工具，用最土的办法即可。
fn extract_first_project_id(html: &str) -> Option<i64> {
    let marker = "/submit/";
    let mut rest = html;
    while let Some(idx) = rest.find(marker) {
        let after = &rest[idx + marker.len()..];
        let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(id) = digits.parse() {
            return Some(id);
        }
        rest = after;
    }
    None
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let dir = out_dir();
    std::fs::create_dir_all(&dir)?;
    println!("产出目录：{}\n", dir.display());

    let credentials = detect_store(&std::env::temp_dir().join("zz-deploy-capture"));
    let (user, pass) = credentials
        .load()?
        .ok_or("钥匙串里没有凭据：请先在应用里登录并勾选「记住密码」")?;

    let base_url = std::env::var("ZZ_ITSM_BASE_URL")
        .unwrap_or_else(|_| "https://itsm.zhizhengroup.com".to_string());
    let client = HttpClient::new(&base_url);

    zz_deploy_desktop_lib::commands::auth::login_flow(&client, &user, &pass)
        .await
        .map_err(|e| format!("登录失败：{e}"))?;
    println!("登录成功（{user} @ {base_url}）\n");

    // ---- 项目列表：自动化 / Docker ----
    // 只取 env=1：解析器测试不需要多环境样本，多抓只会白白撑大仓库
    for env in [1_i64] {
        let auto = client
            .get("/deployment/deploy/submit/", &[("env".into(), env.to_string())])
            .await?
            .body;
        save(&dir, &format!("projects_auto_env{env}.html"), &auto)?;

        let docker = client
            .get("/dockerdeploy/docker/submit/", &[("env".into(), env.to_string())])
            .await?
            .body;
        save(&dir, &format!("projects_docker_env{env}.html"), &docker)?;
    }

    // ---- 分支列表：需要一个真实 project id，从刚抓的项目页里取 ----
    let projects_html = std::fs::read_to_string(dir.join("projects_auto_env1.html"))?;
    match extract_first_project_id(&projects_html) {
        Some(project_id) => {
            println!("  从项目页解析到 project id = {project_id}");
            let html = client
                .get(&format!("/deployment/deploy/submit/{project_id}/"), &[])
                .await?
                .body;
            save(&dir, "branches_auto.html", &html)?;
        }
        None => println!("  ⚠️ 未能解析出 project id，跳过分支抓取"),
    }

    // ---- 任务列表：自动化 / Docker ----
    for (name, path) in [
        ("tasks_auto.html", "/deployment/deploy/task/"),
        ("tasks_docker.html", "/dockerdeploy/docker/task/"),
    ] {
        let html = client
            .get(
                path,
                &[("page".into(), "1".to_string()), ("search".into(), String::new())],
            )
            .await?
            .body;
        save(&dir, name, &html)?;
    }

    // ---- commit 接口：JSON 样本，验证 raw.split("#-----#") 的拆解 ----
    let project_name = extract_first_project_name(&projects_html);
    let branch = std::fs::read_to_string(dir.join("branches_auto.html"))
        .ok()
        .and_then(|h| extract_first_branch(&h));

    match (project_name, branch) {
        (Some(name), Some(branch)) => {
            // 与前端 cleanProjectName 同口径：去掉括号后缀
            let mut clean = String::new();
            let mut in_paren = false;
            for c in name.chars() {
                match c {
                    '\u{ff08}' | '(' => in_paren = true,
                    '\u{ff09}' | ')' => in_paren = false,
                    _ if !in_paren => clean.push(c),
                    _ => {}
                }
            }
            let clean = clean.trim().to_string();
            println!("\n  样本用 项目={clean} 分支={branch}");

            let resp = client
                .get(
                    "/devapi/projectcommit/",
                    &[
                        ("project".into(), clean.clone()),
                        ("branch".into(), branch.clone()),
                    ],
                )
                .await?;
            save(&dir, "commits_sample.json", &resp.body)?;

            // 再故意用一个不存在的项目名请求一次，把服务端的「警告」响应也固定下来。
            // 这是一个真实的边界情况：服务端返回 msg=success，却把一句中文警告
            // 塞进 commitids 数组。前端必须能识别并过滤掉，否则 Commit 下拉里
            // 会出现 hash 为整句中文的假记录。
            let bogus = client
                .get(
                    "/devapi/projectcommit/",
                    &[
                        ("project".into(), "__nonexistent_project__".to_string()),
                        ("branch".into(), branch.clone()),
                    ],
                )
                .await?;
            save(&dir, "commits_warning_sample.json", &bogus.body)?;
            std::fs::write(
                dir.join("commits_sample.meta.txt"),
                format!("project={clean}\nbranch={branch}\n"),
            )?;
        }
        (n, b) => println!(
            "  \u{26a0} 未能取得样本（project={n:?}, branch={b:?}），跳过 commit 抓取"
        ),
    }

    println!("\n抓取完成。请人工抽查：");
    println!("  1. 文件确实是登录后的页面（不含 login 表单）");
    println!("  2. 不含 sessionid / 真实人名 / 内部 IP 等敏感信息");
    println!("  3. 通过后再 git add");
    Ok(())
}
