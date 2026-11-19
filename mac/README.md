# RokBot Mac 补丁

[English](README.en.md)

基于原版 Grok Bot 0.71.2 Apple Silicon 客户端构建 RokBot，连接自己的 RokBot Host。需要 Node.js 22.12+。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-client)。`clients/desktop/` 是客户端主进程，Windows 和 Android 客户端也用到这里的代码。

## 使用

```sh
node patchers/desktop/patch.mjs
```

工具自动下载并校验 0.71.2 Apple Silicon 原版，替换 RokBot 专属应用图标（`assets/logo/rokbot.icns` 与 `assets/logo/rokbot-icon-512.png`），并生成 `output.noindex/RokBot.app`。移入「应用程序」，填写 Host 地址和六位配对码。

如需通过自建镜像源下载原版安装包，可设置 `ROKBOT_DESKTOP_DOWNLOAD_BASE`（无凭据的 `http(s)` 基地址）；下载产物仍会严格校验官方字节数与 SHA-256 摘要。

官方 Mac 版已经更新到 1.2.3（2026-11-19 核对），这里仍然固定为 0.71.2：Mac 版是单独的程序包，要另做补丁，并在 Mac 上测试安装、签名和本机图形界面控制，维护者目前没有 Mac。0.71.2 仍可从官方地址下载，补丁会核对它的完整摘要。

已有原版 `.app` 或 `.dmg` 时，可增加 `--source "/path/to/Grok Bot.app"`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。本项目没有在 macOS 上实测安装、启动、配对或聊天。可接受的原包和官方最新版本见[首页版本表](../README.md#client-versions)。

需要控制本机图形界面时，在命令中增加 `--identity auto`，使用已有签名证书。

项目仓库：<https://github.com/hongfaqiu/rokbot>

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
