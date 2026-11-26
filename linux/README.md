# RokBot Linux 桌面端

[English](README.en.md)

从官方 **Grok Bot Linux `.deb`（1.3.0）** 本地构建自托管的 **RokBot Linux 桌面客户端**，支持 **x64 (`amd64`)** 与 **arm64 (`aarch64`)**，输出便携目录、`.tar.gz` 与 `.deb` 安装包。

## 特性

- 与 macOS / Windows 桌面端共享 `mac/clients/desktop/` 运行时与全部 RokBot 功能（自托管重定向、遥测关闭、应用内模型配置、`needsModel` 提示条、会话排序、头像样式、用量统计、批量下载图片、Tailcat 穿透、`rokbot-local://` 协议）。
- 完整重品牌为 `rokbot-local`：安装到 `/opt/RokBot/rokbot`、`/usr/bin/rokbot`、`/usr/share/applications/rokbot.desktop`、hicolor SVG/PNG 图标与 `/etc/apparmor.d/rokbot`。
- 彻底移除上游 `postinst` 对 `downloads.cursor.com/aptrepo` APT 源和 GPG 密钥的写入。
- 内置预编译的 `rokbot-tailcat`（`host/bin/rokbot-tailcat` 与 `host/bin/linux-arm64/rokbot-tailcat`）。
- 支持连接 RokBot Host 自托管更新服务（`/local/updates/linux-x64.json`、`/local/updates/linux-arm64.json`）及可写便携目录的 ASAR 增量热更新。

## 构建方法

首次使用需先安装共享的 `@electron/asar` 依赖：

```bash
npm install --prefix mac/patchers/desktop
```

### 仅校验官方包与补丁配方

```bash
node linux/patchers/desktop/patch.mjs --arch x64 --verify-only
node linux/patchers/desktop/patch.mjs --arch arm64 --verify-only
```

### 生成便携版 + `.tar.gz` + `.deb`

```bash
# 自动下载并校验当前架构对应的官方 Grok Bot 1.3.0 .deb
node linux/patchers/desktop/patch.mjs

# 指定架构（支持在 macOS 或 Linux 跨平台生成 .deb 与 .tar.gz，无需 dpkg-deb）
node linux/patchers/desktop/patch.mjs --arch x64
node linux/patchers/desktop/patch.mjs --arch arm64

# 使用本地已下载的官方 .deb（自动按 SHA-256 识别架构与版本）
node linux/patchers/desktop/patch.mjs --source /path/to/grok-bot_1.3.0_amd64.deb

# 启用自托管应用内更新
node linux/patchers/desktop/patch.mjs --arch x64 \
  --update-url https://your-host.example/local/updates \
  --update-public-key-file /path/to/update-public-key.pem
```

输出默认写入 `linux/output/`：
- `RokBotLocal-1.3.0-linux-<arch>/`（便携目录，直接运行 `./rokbot`）
- `RokBotLocal-1.3.0-linux-<arch>.tar.gz`（通用发行版便携包）
- `RokBotLocal-1.3.0-linux-<arch>.deb`（Debian / Ubuntu 安装包：`sudo apt install ./RokBotLocal-1.3.0-linux-<arch>.deb`）
- `RokBotLocal-1.3.0-linux-<arch>.patch.json`（构建校验与 ASAR 摘要清单）
