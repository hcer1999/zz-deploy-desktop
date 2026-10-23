# 分发指南

给同事装机用的清单。接收方要看的放行步骤在 [`install-unsigned.md`](install-unsigned.md)，
可以直接把那份转给他们。

## 1. 产物从哪来

```bash
cd zz-deploy-desktop
npm run tauri build        # 当前平台
```

| 平台 | 产物 | 大小（参考） |
|---|---|---|
| macOS | `src-tauri/target/release/bundle/dmg/至真部署_<版本>_<arch>.dmg` | 3.5 MB |
| macOS（备选） | `src-tauri/target/release/bundle/macos/至真部署.app` | 6.7 MB |
| Windows | `bundle/msi/*.msi`、`bundle/nsis/*.exe` | — |
| Linux | `bundle/deb/*.deb`、`bundle/appimage/*.AppImage` | — |

**发 `.dmg`，不要直接发 `.app`**：`.app` 是目录，走聊天工具/网盘会被压成 zip，
解压后容易丢符号链接与权限；`.dmg` 里已经带了 `Applications` 快捷方式，
接收方拖进去即可。

## 2. 按对象选包

| 接收方 | 需要的包 | 现在能出吗 |
|---|---|---|
| Apple Silicon Mac（M 系列） | `至真部署_0.1.1_aarch64.dmg` | ✅ 已产出 |
| Intel Mac | 通用包（universal） | ⚠️ 需要先 `rustup target add x86_64-apple-darwin`，再 `npm run tauri build -- --target universal-apple-darwin` |
| Windows | `.msi` / `.exe` | ❌ **必须在 Windows 机器上构建**（Tauri 不支持交叉编译打包） |
| Linux | `.deb` / `.AppImage` | ❌ **必须在 Linux 机器上构建** |

判断架构：`lipo -info "至真部署.app/Contents/MacOS/zz-deploy-desktop"`。
Intel Mac 装 arm64 包会直接报无法打开（Rosetta 是 x86→arm 方向，反向不行）。

## 3. 发给同事的话术（复制粘贴）

> 装这个：至真部署_0.1.1_aarch64.dmg（Apple 芯片 Mac）／…（Intel Mac 用 universal 包）
> 打开 dmg → 把「至真部署」拖进「应用程序」→ 首次打开会被拦（未签名），
> 到「系统设置 → 隐私与安全性」点「仍要打开」；
> 若提示「已损坏」，在终端执行：`xattr -dr com.apple.quarantine "/Applications/至真部署.app"`
> 用你自己的 ITSM 账号登录，勾选「记住密码」以后就不用重复输了。
> 前提：要在内网 / VPN 里能访问 itsm.zhizhengroup.com。

## 4. 使用前提与数据位置

- **网络**：必须能访问 ITSM（内网 / VPN）。连不上时表现为登录或列表请求超时。
- **账号**：每人用自己的账号登录，互不影响。第一次需要手动登录一次。
- **本机数据**（macOS `~/Library/Application Support/com.zhizhengroup.deploy/`）：

  | 文件 | 内容 |
  |---|---|
  | `config.json` | 地址、主题、关闭行为、轮询间隔、日志保留策略、通知触发条件 |
  | `favorites.json` | 收藏 |
  | `credentials.bin` + `credentials.key` | 记住的账号密码（AES-256-GCM），**不用系统钥匙串** |
  | `logs/` | 历史日志（索引 + 正文） |

- **卸载**：把 App 拖进废纸篓；想彻底清干净再删上面那个目录（相当于重置：需要重新登录、收藏清空）。

## 5. 发新版本

1. 改版本号：`package.json`、`src-tauri/tauri.conf.json`（打包用后者）、`src-tauri/Cargo.toml`，
   以及 `src-tauri/Cargo.lock` 里的 `zz-deploy-desktop` 条目（不改的话下次 `cargo` 会改回来）。
2. 带 updater 签名构建（源码构建不需要密钥；发版必须带）：
   ```bash
   export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/zz-deploy-desktop.key"
   npm run build:release
   ```
3. 生成 `latest.json`（把 `.sig` 拼成清单，详见 [`updates.md`](updates.md)），
   连同 `.app.tar.gz` / `.exe` / `.AppImage` 和 `.sig` 一起上传到 GitHub Release（tag `v<版本号>`）。
4. 把 `.dmg` 发给**首次安装**的同事；已经装过的客户端会在下次启动时提示
   「发现新版本 → 立即更新」，下载、安装、重启都在客户端内完成。
5. 版本号建议带进文件名，方便同事区分：`至真部署_0.2.0_aarch64.dmg`。

配置、收藏、历史日志、凭据都在应用数据目录里，更新不会清掉——前提是 `identifier`
（`com.zhizhengroup.deploy`）不要改。

## 6. 想三端自动出包（CI）

在各自平台构建是硬性要求，所以用矩阵构建。GitHub Actions 示例：

```yaml
name: release
on: { push: { tags: ["v*"] } }
jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-14,      target: aarch64-apple-darwin }
          - { os: macos-13,      target: x86_64-apple-darwin }
          - { os: windows-latest, target: x86_64-pc-windows-msvc }
          - { os: ubuntu-22.04,  target: x86_64-unknown-linux-gnu }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - uses: dtolnay/rust-toolchain@stable
        with: { targets: ${{ matrix.target }} }
      - run: sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev
        if: matrix.os == 'ubuntu-22.04'
      - run: npm ci
      - uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          # updater 签名：与 src-tauri/tauri.conf.json 的 pubkey 配对
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v__VERSION__
          releaseName: 至真部署 v__VERSION__
          args: --target ${{ matrix.target }} --config src-tauri/tauri.release.conf.json
```

`tauri-action` 会生成 `latest.json` 并上传到同一个 Release；没有 secret 时构建会失败，
所以第一次接入 CI 要先把私钥内容存进仓库 secret（可保留文件路径版本在本机用）。

内网 GitLab 同理，用 shell runner（macOS/Windows/Linux 各一）跑同样的命令。

## 7. 目前的缺口（分发前心里有数）

| 缺口 | 影响 | 解法 |
|---|---|---|
| 无代码签名 / 公证 | 每次首次安装都要手动放行；有 Apple Developer 账号（¥688/年）可去掉 | 配置 `signingIdentity` + `notarytool` |
| 无自动重启 | 新版本安装完成后要用户点「立即重启」（避免打断正在跑的构建） | 产品选择，不需要补 |
| 无单实例限制 | 重复双击会出现多个窗口/托盘图标 | `tauri-plugin-single-instance` |
| 设置页「启动时自动运行」未实现 | 想让同事开机自启做不到 | `tauri-plugin-autostart`（spec §5.6 已列） |
| 仅 arm64 macOS 产物 | Intel Mac 无法使用 | 通用包或在 Intel 机器上构建 |
