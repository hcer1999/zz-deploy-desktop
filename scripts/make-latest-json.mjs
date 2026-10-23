#!/usr/bin/env node
/**
 * 生成 Tauri updater 的静态清单 latest.json。
 *
 * 用法（在仓库根目录）：
 *
 *   node scripts/make-latest-json.mjs \
 *     --version 0.2.0 \
 *     --base-url https://github.com/hcer1999/zz-deploy-desktop/releases/download/v0.2.0 \
 *     --notes-file release-notes.md \
 *     --platform darwin-aarch64=src-tauri/target/release/bundle/macos/至真部署.app.tar.gz \
 *     --platform windows-x86_64-nsis=src-tauri/target/release/bundle/nsis/至真部署_0.2.0_x64-setup.exe \
 *     --platform linux-x86_64-appimage=src-tauri/target/release/bundle/appimage/至真部署_0.2.0_amd64.AppImage \
 *     --out latest.json
 *
 * 每个安装包旁必须有 tauri 生成的同名 `.sig` 文件（build:release 会生成）。
 * --base-url 是这些安装包上传到发布页后的目录，url 会自动拼成 `<base-url>/<文件名>`。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, resolve } from "node:path";

function usage() {
  console.error(`用法：
  node scripts/make-latest-json.mjs --version <x.y.z> --base-url <发布页目录> \\
    [--notes <文本> | --notes-file <文件>] \\
    --platform <target>=<安装包路径> [--platform ...] \\
    [--out latest.json]

示例 target：
  darwin-aarch64            macOS Apple Silicon（.app.tar.gz）
  darwin-x86_64             macOS Intel（.app.tar.gz）
  windows-x86_64-nsis       Windows NSIS（-setup.exe）
  windows-x86_64-msi        Windows MSI（.msi）
  linux-x86_64-appimage     Linux AppImage
  linux-x86_64-deb          Linux deb`);
}

function parseArgs(argv) {
  const out = { platforms: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--help" || key === "-h") {
      usage();
      process.exit(0);
    }
    if (!key.startsWith("--") || value === undefined) {
      usage();
      throw new Error(`参数不完整：${key}`);
    }
    i++;
    if (key === "--platform") {
      const at = value.indexOf("=");
      if (at <= 0 || at === value.length - 1) {
        throw new Error(`--platform 需要 <target>=<路径>，收到：${value}`);
      }
      out.platforms.push({ target: value.slice(0, at), path: value.slice(at + 1) });
    } else if (key === "--version") out.version = value;
    else if (key === "--base-url") out.baseUrl = value;
    else if (key === "--notes") out.notes = value;
    else if (key === "--notes-file") out.notes = readFileSync(value, "utf8");
    else if (key === "--out") out.out = value;
    else throw new Error(`未知参数：${key}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.version) throw new Error("缺少 --version");
  if (!args.baseUrl) throw new Error("缺少 --base-url");
  if (args.platforms.length === 0) throw new Error("至少需要一个 --platform");

  const baseUrl = args.baseUrl.replace(/\/+$/, "");
  const version = args.version.replace(/^v/i, "");
  const platforms = {};

  for (const { target, path } of args.platforms) {
    const artifact = resolve(path);
    const sigPath = `${artifact}.sig`;
    if (!existsSync(artifact)) throw new Error(`找不到安装包：${artifact}`);
    if (!existsSync(sigPath)) {
      throw new Error(
        `找不到签名文件：${sigPath}\n请用 build:release 构建（需要 TAURI_SIGNING_PRIVATE_KEY）`,
      );
    }

    const signature = readFileSync(sigPath, "utf8").trim();
    // 签名里带构建时的版本号：清单版本与安装包不一致时拒绝生成，
    // 否则客户端会下载到一个「版本对不上」的包。
    const signedVersion = /version:([^\s]+)/.exec(
      Buffer.from(signature, "base64").toString("utf8"),
    )?.[1];
    if (signedVersion && signedVersion !== version) {
      throw new Error(
        `${basename(artifact)} 的签名版本是 ${signedVersion}，与 --version ${version} 不一致；` +
          "请用对应版本重新构建",
      );
    }

    platforms[target] = {
      signature,
      url: `${baseUrl}/${encodeURIComponent(basename(artifact))}`,
    };
  }

  const manifest = {
    version,
    notes: args.notes ?? "",
    pub_date: new Date().toISOString(),
    platforms,
  };

  const out = args.out ?? "latest.json";
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`已生成 ${out}（${Object.keys(platforms).join(", ")}）`);
}

try {
  main();
} catch (e) {
  console.error(`\n生成失败：${e.message}`);
  process.exit(1);
}
