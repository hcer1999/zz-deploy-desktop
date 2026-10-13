# 未签名版本安装说明

当前构建**未做代码签名**，系统会提示来源不明。按下面步骤放行即可。

## macOS

1. 打开 `.dmg`，把 App 拖进「应用程序」
2. 首次打开会提示「无法验证开发者」→ 点「完成」
3. 到「系统设置 → 隐私与安全性」，在底部找到刚被拦下的项目 → 点「仍要打开」
4. 之后每次双击即可正常打开

若提示「已损坏，无法打开」（下载后被加了隔离属性），在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/至真部署.app"
```

架构说明：默认构建产出的是当前机器架构（Apple Silicon 机器上是 `arm64`）。
若同事用 Intel Mac，需要产出通用包：

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

## Windows

1. 双击 `.msi` 安装
2. 若出现 SmartScreen 提示 → 点「更多信息」→「仍要运行」
3. 安装完成后从开始菜单启动

## Linux

```bash
chmod +x 至真部署_*.AppImage
./至真部署_*.AppImage
```

或安装 deb：

```bash
sudo dpkg -i 至真部署_*.deb
```

## 构建产物在哪

| 平台 | 路径 |
|---|---|
| macOS | `src-tauri/target/release/bundle/dmg/*.dmg`、`bundle/macos/*.app` |
| Windows | `src-tauri/target/release/bundle/msi/*.msi`、`bundle/nsis/*.exe` |
| Linux | `src-tauri/target/release/bundle/appimage/*.AppImage`、`bundle/deb/*.deb` |

**注意**：三端产物必须在各自平台上构建，Tauri 不支持交叉编译打包。
