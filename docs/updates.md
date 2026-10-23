# 应用内更新

现在更新是**在客户端内完成**的：启动后检查新版本 → 顶部提示 → 点「立即更新」→
客户端下载并安装（Tauri minisign 签名校验）→ 点「立即重启」即用上新版本。

用户不需要再去浏览器 / 聊天工具里下载新包。首次安装仍然要按
[`install-unsigned.md`](install-unsigned.md) 处理 Gatekeeper（应用未做 Apple 公证）。

> **过渡期**：已经在用旧版（没有 updater 插件）的同事，需要手动装一次带 updater 的包；
> 从这个版本之后，后续更新才会走客户端内自动更新。

## 一次性的准备：签名密钥

Tauri updater **强制**校验安装包签名，没有签名密钥就无法发更新。仓库只保存**公钥**
（`src-tauri/tauri.conf.json` → `plugins.updater.pubkey`），私钥绝不能提交。

本机已生成一套密钥（无密码）：

| 文件 | 用途 | 是否进仓库 |
|---|---|---|
| `~/.tauri/zz-deploy-desktop.key` | 签发更新包，**丢失后老用户无法再更新** | ❌ 绝对不能 |
| `~/.tauri/zz-deploy-desktop.key.pub` | 公钥，已写入 `tauri.conf.json` | ✅（已写入） |

请立刻把私钥备份到密码管理器 / 安全位置。要换密码或轮换密钥：

```bash
# 重新生成（会得到新的公钥，必须同步更新 tauri.conf.json 并重新发一次全网包）
npx tauri signer generate -w ~/.tauri/zz-deploy-desktop.key
```

## 发一个可自动更新的版本

### 1. 改版本号

同步四处：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、
`src-tauri/Cargo.lock` 里的 `zz-deploy-desktop` 条目。并在 `src/data/changelog.ts` 头部加一条。

### 2. 用「release 配置」构建

普通 `npm run tauri build` 不会生成 updater 产物，也不需要私钥；
发版必须用 overlay 配置并带上私钥：

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/zz-deploy-desktop.key"
# 如果密钥设置了密码，再加：
# export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="..."

npm run build:release        # = tauri build --config src-tauri/tauri.release.conf.json
```

`src-tauri/tauri.release.conf.json` 只做一件事：打开 `bundle.createUpdaterArtifacts`。
构建后会多出：

| 平台 | 更新包 | 签名 |
|---|---|---|
| macOS | `bundle/macos/至真部署.app.tar.gz` | 同名 `.sig` |
| Windows | `bundle/nsis/*-setup.exe`、`bundle/msi/*.msi` | 同名 `.sig` |
| Linux | `bundle/appimage/*.AppImage`、`bundle/deb/*.deb` | 同名 `.sig` |

macOS 的 `.dmg` 仍然要发给**首次安装**的同事；`.app.tar.gz` 是给 updater 用的，
不要拿它当首次安装包。

### 3. 生成 latest.json

客户端默认从 GitHub 的 `releases/latest/download/latest.json` 读取清单。
用脚本把各平台的 `.sig` 拼成清单：

```bash
node scripts/make-latest-json.mjs \
  --version 0.2.0 \
  --base-url https://github.com/hcer1999/zz-deploy-desktop/releases/download/v0.2.0 \
  --notes-file release-notes.md \
  --platform "darwin-aarch64=src-tauri/target/release/bundle/macos/至真部署.app.tar.gz" \
  --platform "windows-x86_64-nsis=src-tauri/target/release/bundle/nsis/至真部署_0.2.0_x64-setup.exe" \
  --platform "linux-x86_64-appimage=src-tauri/target/release/bundle/appimage/至真部署_0.2.0_amd64.AppImage" \
  --out latest.json
```

脚本会校验 `.sig` 里的构建版本与 `--version` 一致，避免把 0.1.0 的包配到 0.2.0 的清单上。

清单格式（Tauri 静态清单）：

```json
{
  "version": "0.2.0",
  "notes": "更新说明",
  "pub_date": "2026-10-22T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "（.sig 文件内容）",
      "url": "https://…/至真部署.app.tar.gz"
    }
  }
}
```

### 4. 发布

在 GitHub 建 Release，tag 用 `v0.2.0`，上传：

- 各平台更新包 + `.sig`
- `latest.json`
- macOS `.dmg`（给新用户）

客户端下一次启动就会看到「发现新版本 v0.2.0 → 立即更新」。

## 换成内网更新源

把 `src-tauri/tauri.conf.json` 里的 endpoint 改成一串静态 JSON 地址：

```json
"endpoints": ["https://intranet.example.com/zz-deploy/latest.json"]
```

然后重新构建客户端。清单与安装包的部署方式不变。Tauri 生产环境只允许 https；
本机调试可用 `http://localhost` 并打开 `dangerousInsecureTransportProtocol`（不推荐发版）。

> 用 GitHub Actions 的话，`tauri-apps/tauri-action` 可以直接生成 `latest.json`
> 并上传到 Release，就不需要手动跑第 3 步；关键是把
> `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 配成仓库 secret，
> 并在构建参数里加上 `--config src-tauri/tauri.release.conf.json`。

## 平台行为与限制

| 平台 | 点「立即更新」之后 |
|---|---|
| macOS | 下载 → 校签 → 用新 `.app` 替换当前 bundle；若 `/Applications` 无写权限会弹一次管理员授权；点「立即重启」生效 |
| Windows | 下载 → 校签 → 启动 NSIS/MSI（passive，无交互）；应用会退出，安装器装完自动拉起 |
| Linux | AppImage 自替换；deb/rpm 由插件调用系统安装流程，可能要求权限 |

已知边界：

- **开发模式不能安装更新**：必须用打包后的 `.app` / `.exe` / `.AppImage` 运行。
- macOS 仍是 ad-hoc 签名、未公证：首次安装要手动放行；后续应用内更新由客户端自己下载，
  不会带浏览器下载的 quarantine 属性，通常可直接运行。若系统仍拦截，退回 `.dmg` 手动安装。
- 私钥丢失 / 公钥换了：已经装出去的旧版本再也无法通过 updater 更新，只能让用户手动装新包。
  所以**私钥一定要备份**。
- 不自动重启：用户可能正在跑构建 / 看日志。Windows 由安装器拉起；macOS / Linux 等用户点
  「立即重启」。
- 清单里的版本必须大于当前版本（SemVer），否则客户端认为没有更新。

## 排查

| 现象 | 检查 |
|---|---|
| 提示「暂无更新」但 Release 已发 | `latest.json` 的 `version` 是否大于当前版本；Release 是否带 `latest.json` 资产 |
| 检查更新报「valid release JSON」 | `latest.json` 未上传，或平台 key 与当前 `OS-ARCH` 不匹配 |
| 下载后安装失败 / 签名校验失败 | 私钥与 `tauri.conf.json` 的 `pubkey` 不是一对，或 `.sig` 与安装包不是同一次构建 |
| 构建时报 `A public key has been found, but no private key` | 用了 `build:release` 但没设置 `TAURI_SIGNING_PRIVATE_KEY` |
| macOS 安装时要求管理员密码 | 应用目录不可写（如安装在 `/Applications` 且属于其他用户），输入一次即可 |
