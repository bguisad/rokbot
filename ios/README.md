# RokBot iOS 补丁

[English](README.en.md)

为 Grok Bot arm64 砸壳 IPA 注入补丁，接受 `1.27.0`（`29519`）、`1.26.0`（`29388`）和 `1.16.0`（`23152`）。主程序和三个扩展都必须是解密过的，需要 Python 3.9+。本仓库不提供任何原版或修改过的 IPA，请自己准备。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#ios-客户端)。

## 支持的版本

补丁按 IPA 中 `Info.plist` 的版本号、Build 号和固定摘要识别输入：`1.27.0 (29519)` 的配置在 `recipes/ios/manifest.json`，`1.26.0 (29388)` 和 `1.16.0 (23152)` 在 `recipes/ios/<版本>/manifest.json`。其他版本会被拒绝。

- App Store 官方包受 FairPlay 加密保护，工具不能自动下载或解密，需要自备解密过的 IPA。
- 每个版本都核对主程序 `__text` 摘要（`nativeTextSha256`）、Hermes 包摘要（`hbcSha256`）和注入库 `RokBotLocal.dylib` 的摘要，再应用 `.gbp.gz` 字节补丁。

## 使用

```sh
python3 release/patch-ios.py \
  --input /path/to/GrokBot-decrypted.ipa \
  --output ./RokBot-Patched \
  --bundle-id dev.rokbot.local
```

`--output` 必须是不存在的新目录，其中包含未签名的 `RokBot-Local-resignable.ipa`、`RokBotLocal.dylib`、`patch-report.json`，保留扩展时还有 `extension-signing.json`。本仓库不提供签名好的 IPA；生成的 IPA 只给自己的设备用，或由 Host 管理员在管理页「客户端更新」发布，见首页的[获取客户端](../README.md#获取客户端)。按下一节用自己的工具签名并安装，然后填写 Host 地址和六位配对码（或切换为**管理员密码**配对）。

推送用 APNs 或 Bark，在 Host 管理页配置。实时通话在 App 设置中开启。

## 签名与免费 Apple ID 限制

补丁默认保留 Widgets、Share 和 NotificationService 三个扩展。签名工具要为以下四个目标配置描述文件：

| 目标 | Bundle ID |
| --- | --- |
| 主应用 | 传入 `--bundle-id` 的值（默认 `dev.rokbot.local`） |
| Widgets | `<主应用 ID>.widgets` |
| Share | `<主应用 ID>.share` |
| NotificationService | `<主应用 ID>.NotificationService` |

- **免费 7 天 Apple ID（3 个 App ID 上限）**：免费个人签名账号同时最多注册 3 个 App ID，无法为全部 4 个目标签名；如无需扩展，请追加 `--remove-extensions` 仅保留主应用。
- **付费开发者账号（4 个目标）**：四个目标使用同一个 App Group（默认 `group.<主应用 ID>`，可用 `--app-group` 指定）；共享钥匙串组为 `<AppIdentifierPrefix>.<主应用 ID>.shared`，需加入四个目标的签名 entitlement，并将各目标 `Info.plist` 的 `SandKeychainAccessGroups` 设为包含该组的数组（`extension-signing.json` 已列出完整配置）。
- 安装包带 APNs 权限时用 APNs，推送凭证在 Host 里配置；没有 APNs 权限时，在 App 的通知设置里填写 Bark 链接。
- **设备去重（`clientDeviceId`）**：使用相同 `CFBundleIdentifier` 重签升级或退出重连时，App 会在 Keychain（`dev.rokbot.local.<bundleId>` / `client-device-id`）与 `NSUserDefaults` 中保留同一个 `clientDeviceId`，并在配对与 `/local/device` 上报时自动绑定旧记录，避免 Host 产生重复设备。

## 应用内模型配置（`RBModels`）

- 首次配对或启动恢复后，App 会查询 Host 的 `GET /local/status`。若 `needsModel` 为真，会弹出非阻塞引导提示，引导进入**模型配置**界面。
- 也可随时点击已连接页面的**模型配置**按钮打开，支持查看/新增/编辑/切换模型服务（`openai`、`openai-responses`、`anthropic`）、模型档案（含 `POST /local/model/catalog` 拉取远端模型列表与推理强度/上下文窗口）、以及发送真实测试请求（`POST /local/model/test`，125 秒超时）。
- 留空已保存服务的 API Key 字段会自动保留 Host 既有密钥；若当前设备未通过管理员密码配对且 Host 返回 `403`，App 会弹窗要求临时输入管理员密码（仅存内存，通过 `X-RokBot-Admin-Password` 提交，不写入本地持久化存储）。
- **场景模型与单 Bot 模型路由**：模型配置页新增「场景模型」（输入建议、上下文压缩、记忆提取、自动审核、子任务 Agent、定时任务）和「单 Bot 模型路由」，未设置时跟随默认路由。保存时始终带上 `scenarioRoutes`，并原样保留 Host 已有的 `adaptiveRouting`，不会把其他端配置的场景模型清掉。
- **选择器**：默认档案、推理强度、备用模型、接口格式、所属服务等都改用 RokBot 自有样式的底部选择面板（`RBChoiceSheet`），不再使用系统 Action Sheet 或分段控件；深色、浅色和动态字体都适配。

## 输入建议（`RBSuggestions`）

- 聊天输入框获得焦点且为空时，在输入框上方显示建议条：先显示自定义常用语，再显示模型按当前对话生成的建议（最多 4 条）。点一下直接通过 `POST /api/sendPrompt` 发送；发送失败时会把文字填回输入框。
- 空会话或 Host 未返回模型建议时只显示常用语，没有任何预置文案；失败结果不缓存，下次聚焦会重试。
- 连接设置页的「输入建议」可以开关建议、单独开关「AI 生成建议」，并增删改常用语和调整顺序。设置保存在 Host（`/local/suggestions/settings`、`/local/suggestions/phrases`），和桌面端、网页版、Android 同步。

## 新建群聊（`RBGroupCreate`）

- 会话列表的「+」按钮会弹出 RokBot 底部面板，可选「新建 Bot」或「新建群聊」；连接设置页也有「新建群聊」入口。
- 建群流程与桌面端 1.3.0 一致：单页完成，顶部「收件人：」栏选成员，最多 6 个 Bot，可以直接输入名称新建 Bot；群名按桌面端规则自动生成（最长 72 个字符），描述为空。可以直接写首条消息，创建后自动进入新群。创建失败会删除本次新建的 Bot，并保留草稿和已选成员。

## 应用内更新与 iOS 沙盒约束（`RBUpdater`）

受 iOS 沙盒机制与代码签名限制，App **无法在运行时静默自我替换二进制或应用增量补丁**（`patch-app.py` 也会禁用原版 `Expo.plist` 的 OTA 热更新以保证主包一致性）。已连接页面的**检查更新**（以及每 6 小时节流的后台检查）会请求 Host 的 `GET /local/updates/ios.json`（`rokbot-ios-update/v1`），比对版本与 Build 号、校验 `bundleId`、展示大小与 SHA-256，并提供以下安装方式：

1. **OTA 一键安装（`itms-services://`）**：由系统守护进程 `itunesstored` 在 RokBot 沙盒外执行，要求 `manifest.plist` 为受信任的 **`https://` 非回环地址**（无法通过 Tailcat `127.0.0.1` 访问），且安装包的 `CFBundleIdentifier` 与签名描述文件（Ad-Hoc / 企业 / 开发者证书）必须与本机签名兼容。
2. **AltStore / SideStore（`altstore://`、`sidestore://`）**：跳转到已安装的 AltStore 或 SideStore 添加源并使用用户自己的 Apple 凭证重签安装。
3. **下载 IPA 并分享（TrollStore / Sideloadly / 文件）**：通过 `NSURLSessionDownloadTask` 流式下载 `.ipa`（支持 Tailcat 隧道与仅同源携带 `Bearer` 鉴权），在本地完成字节长度与分块 `CC_SHA256` 校验后，拉起系统分享面板交给 TrollStore、AltStore、爱思或文件 App 完成签名安装。

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
