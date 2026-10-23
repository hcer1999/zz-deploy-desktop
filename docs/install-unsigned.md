# 未签名版本安装说明

当前构建**没有 Apple Developer ID 签名，也没有公证**，所以同事拿到的包会被系统拦。按下面步骤放行即可。

## 先分清两种提示（处理方式完全不同）

| 提示 | 含义 | 怎么办 |
|---|---|---|
| 「无法验证开发者」/「Apple 无法检查是否包含恶意软件」 | 签名本身是**一致**的，只是没公证 | 系统设置 → 隐私与安全性 → **仍要打开**（见下） |
| **「已损坏，无法打开。你应该将它移到废纸篓」** | **签名与 bundle 内容不一致**（Gatekeeper 判定签名损坏） | 系统**不会**给「仍要打开」入口，只能清隔离属性（一条命令，见下），或重新收新版包 |

> 0.0.1 之前的包属于第二种：主二进制只有 linker 签名，而 bundle 里没有
> `_CodeSignature/CodeResources`，`codesign --verify` 直接报
> `code has no resources but signature indicates they must be present`。
> **0.0.1 起已在构建里对整个 bundle 做 ad-hoc 签名修掉了**，现在同事看到的是第一种（能正常放行）。

## macOS 放行步骤

1. 打开 `.dmg`，把 App 拖进「应用程序」
2. 先双击一次（让系统把这次拦截记录下来）
3. 打开「系统设置 → 隐私与安全性」，在底部找到刚被拦下的项目 → 点「**仍要打开**」
4. 之后每次双击即可

- macOS 15 (Sequoia) 起**已取消**「右键 → 打开」这个旧技巧，只能走上面的第 3 步；
  14 及更早版本可以右键 → 打开。
- **万能兜底**（终端一条命令，之后直接双击；对「已损坏」也有效）：

  ```bash
  xattr -dr com.apple.quarantine "/Applications/至真部署.app"
  ```

  路径可以直接把 app 拖进终端窗口自动补全。

### 为什么清掉隔离属性就能救「已损坏」

「已损坏」不是文件真的坏了，而是 Gatekeeper 判定「签名与 bundle 不一致」，
于是连「仍要打开」都不给。清掉 `com.apple.quarantine` 后系统根本不做这项检查，应用即可启动。
（Apple Silicon 只要求二进制有**任一**有效签名即可执行，linker 签名满足这条。）

想确认**文件本身**有没有传坏（与签名无关），可以校验 dmg 完整性：

```bash
hdiutil verify ~/Downloads/至真部署_0.1.1_aarch64.dmg
```

## 让同事完全看不到提示的两个办法

1. **内网 curl 下载**：`curl` 不像浏览器 / AirDrop / 网盘那样给文件打隔离属性，双击就直接开：

   ```bash
   curl -O https://<内网地址>/至真部署_0.1.1_aarch64.dmg
   ```

2. **买 Apple Developer（¥688/年）做 Developer ID 签名 + 公证**：配置已经就位，
   拿到证书后只需带环境变量构建，Tauri 会自动签名并提交公证：

   ```bash
   export APPLE_SIGNING_IDENTITY="Developer ID Application: <你的名字> (<TEAMID>)"
   export APPLE_ID=<你的 Apple ID>
   export APPLE_PASSWORD=<App 专用密码>
   export APPLE_TEAM_ID=<TEAMID>
   npm run tauri build
   ```

   此时 `tauri.conf.json` 里的 `signingIdentity: "-"` 会被环境变量覆盖，同事双击即开。

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

> 打包小坑：`bundle_dmg.sh` 偶发失败（报 `failed to run bundle_dmg.sh`）并会在 `/Volumes/`
> 留下一个没卸干净的临时卷。处理：`hdiutil detach /Volumes/<残留卷> -force` 后重跑
> `npx tauri bundle --bundles app,dmg -v`（加 `-v` 能看到真实输出）。
> 另外 `--bundles dmg` 单独跑会在完成后删掉 `.app`，需要 `.app` 就再跑一次 `--bundles app`。

---

## 给维护者：签名相关的不变量

`src-tauri/tauri.conf.json` 里 `bundle.macOS.signingIdentity: "-"`（ad-hoc 签名**整个 bundle**）
**必须保留**。去掉它的后果不是「少了个签名」，而是：

- 主二进制只剩 linker 签名，bundle 缺少 `_CodeSignature/CodeResources`
- `codesign --verify --deep --strict` 报 `code has no resources but signature indicates they must be present`
- 用户侧表现是「已损坏」，连「仍要打开」都没有 → 等于发不出去

三条自检命令（每次出包后跑一遍）：

```bash
APP="src-tauri/target/release/bundle/macos/至真部署.app"
codesign --verify --deep --strict "$APP"; echo "期望退出码 0"   # 签名一致
codesign -dv --verbose=2 "$APP" | grep Sealed                  # 期望 Sealed Resources version=2
spctl -a -vv -t exec "$APP"                                    # 期望 rejected（未公证属正常，不再是「损坏」类）
```

另注：`signingIdentity: "-"` 会让 Tauri 附加 hardened runtime（`flags=0x10002(adhoc,runtime)`）。
目前不影响 WKWebView（JIT 在 Apple 自己的 WebContent 进程里），实测应用能正常起界面；
若将来在**主进程**里引入需要 JIT 或加载未签名动态库的能力，需要补 entitlements。
