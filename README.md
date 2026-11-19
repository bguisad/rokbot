# RokBot

**在自己的服务器上运行 Grok Bot，接入你自己的模型，并坚持全端官方原生客户端补丁路线。**

**简体中文** · [English](README.en.md)

---

## 简介

RokBot 是一套面向自托管场景的 Grok Bot 服务端与全端客户端补丁工程：

- **全端原生路线（舍弃套壳）**：彻底舍弃旧版「WebView 套壳 Windows 前端」的 Android 方案，Android 端直接对官方原生 React Native + Hermes 安装包（`.xapk` / `.apks` / `.apk`）执行补丁，100% 保留原版界面与交互。
- **自托管 Host 增强**：支持 Anthropic Messages / OpenAI Responses / OpenAI Chat 多接口、按 Bot 独立模型路由、可靠上下文压缩、管理员密码配对、多机本地执行与默认机器固定路由（`GROKBOT_DEFAULT_MACHINE_ID`）。
- **零官方闭源分发**：本仓库不含任何官方程序包、成品 APK/IPA 或密钥；所有客户端与 Host 均由用户在本地基于自行校验的官方安装包生成。

---

## 参考与致谢

本项目在架构设计、字节补丁机制与多端适配思路上参考了以下两个优秀开源上游仓库：

1. **[ProkBot](https://gitee.com/ahaduoduoduo/ProkBot)**（基线 `3e9fe8c`）—— 开创性地将官方 Host 容器化并打通客户端补丁链路；
2. **[ferretgeek/prokbot-plus](https://github.com/ferretgeek/prokbot-plus)**（参考至 `1.5.1`）—— 扩展了多模型协议、按 Bot 模型路由、可靠压缩、Windows/Web 客户端及部署运维工具。

RokBot 在上述工作基础上以全新仓库重新组织，聚焦**原生官方客户端补丁**与**新一代 Host 基线演进**。本项目沿用 [ProkBot Noncommercial License 1.0](LICENSE)（仅限个人学习、研究与非商业使用；详见 [NOTICE](NOTICE)）。

---

## 目录结构

| 目录 | 说明 | 当前适配基线 |
| --- | --- | --- |
| [`host/`](host/) | 自托管 Host 运行时、管理后台、Docker 构建与字节差分补丁 | Host `d0a4baa` / Box `9d2ac1b`（正推进 `2bb5e41` 升级） |
| [`android/`](android/) | **官方原生 React Native Android 补丁器**（Pairip 去校验、Hermes 字节码补丁、Companion DEX、16KB 对齐 Tailcat `.so`、6 个原生模态页） | 官方 Android `1.16.0`（build `1075`） |
| [`windows/`](windows/) | Windows x64 客户端补丁与安装器 | 官方 Windows `1.1.0`（兼容 `0.71.2`） |
| [`mac/`](mac/) | macOS Apple Silicon 客户端补丁 | 官方 macOS `0.71.2` |
| [`ios/`](ios/) | iOS arm64 砸壳 IPA 注入补丁（`GBBootstrap`） | 官方 iOS `1.16.0`（build `23152`） |
| [`web/`](web/) | 浏览器网页版客户端打包与上传工具 | 界面取自 Windows `1.1.0` |
| [`docs/`](docs/) | 部署手册与架构技术文档 | — |

---

## 快速开始

### 1. 部署自托管 Host

详见 [`docs/AI-INSTALL.md`](docs/AI-INSTALL.md) 与 [`host/README.md`](host/README.md)：

- 构建本地 Host 镜像：`python3 host/release/build-docker.py --host-archive <sand-host-bundle.tgz>`
- 启动服务：`docker compose -f host/release/compose.yaml up -d`
- 多台电脑同时接入时，可通过环境变量 `GROKBOT_DEFAULT_MACHINE_ID` 指定默认执行机器，未配置且多机在线时将明确报错以避免静默随机落点。

### 2. 生成原生 Android 客户端

详见 [`android/README.md`](android/README.md)（运行仅需 Node.js >= 20）：

```bash
node android/release/patch-android.mjs \
  --input-apk /path/to/grok-bot-1.16.0.xapk \
  --output-apk android/output/rokbot-android-patched.apk \
  --force
```

---

## 路线图

- [ ] **Host 基线升级**：从 `d0a4baa` 推进至最新官方 `2bb5e41`（支持内置 `officekit-ts`、全量转正多机本地执行、Local CUA、新扩展体系等）
- [ ] **桌面端新版适配**：跟进官方 Windows / macOS `1.2.x` 新版本补丁
- [ ] **原生 Android 持续打磨**：完善真机兼容性、连接器能力与增量更新流程

---

## 许可与声明

- 沿用 [ProkBot Noncommercial License 1.0](LICENSE)：允许个人使用、学习、修改与非商业分发，禁止任何形式的商业用途（包括收费部署、付费服务与企业内部使用）。
- 本项目与 xAI、Grok Bot 及 Cursor/Anysphere 均无任何关联。安全问题请参阅 [SECURITY.md](SECURITY.md)。
