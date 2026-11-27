# RokBot Mac 补丁

[English](README.en.md)

基于原版 Grok Bot 1.2.3 Apple Silicon 客户端构建 RokBot，连接自己的 RokBot Host。需要 Node.js 22.12+。

完整的部署步骤见[部署手册](../docs/AI-INSTALL.md#client-packages)，实现原理见[技术文档](../docs/ARCHITECTURE.md#mac-client)。`clients/desktop/` 是客户端主进程，Windows 和 Android 客户端也用到这里的代码。

## 使用

在 macOS 上、`mac/` 目录中执行（在仓库根目录可写成 `node mac/patchers/desktop/patch.mjs`）：

```sh
node patchers/desktop/patch.mjs --source "/path/to/Grok_Bot_1.2.3.dmg"
```

工具校验 1.2.3 Apple Silicon 原版（省略 `--source` 时从官方地址下载并校验），替换 RokBot 专属应用图标（`assets/logo/rokbot.icns` 与 `assets/logo/rokbot-icon-512.png`），并生成 `output.noindex/RokBot.app`，原版的副本备份在 `backup.noindex/RokBot.app`。输出已存在时不会覆盖。移入「应用程序」，填写 Host 地址和六位配对码。

如需通过自建镜像源下载原版安装包，可设置 `ROKBOT_DESKTOP_DOWNLOAD_BASE`（无凭据的 `http(s)` 基地址）；下载产物仍会严格校验官方字节数与 SHA-256 摘要。

补丁只接受未经修改的 1.2.3 Apple Silicon 原版，固定摘要见 [`patchers/desktop/supported.json`](patchers/desktop/supported.json)。`--source` 也可以指向已有的 `Grok Bot.app`。

`--verify-only` 在临时目录回放固定版本的补丁，不生成客户端。手动指定的 DMG 也检查完整 SHA-256；Mac 上还会验证输入 App 的原签名。本项目没有在 macOS 上实测安装、启动、配对或聊天。可接受的原包见[支持平台](../docs/clients.md#支持平台)。

默认使用 ad-hoc 签名。需要控制本机图形界面时，在命令中增加 `--identity auto`，使用钥匙串里已有的 Developer ID Application 或 Apple Development 证书。

本仓库不提供原版或生成后的客户端。生成的 App 只给自己的设备用，或由 Host 管理员在管理页「客户端更新」发布，见[获取客户端](../docs/clients.md#获取客户端)。

项目仓库：<https://github.com/hongfaqiu/rokbot>

## 许可与支持

仅限非商业使用，见 [LICENSE](LICENSE)。本项目多数代码由 AI 辅助编写。
