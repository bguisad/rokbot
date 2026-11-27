# rokbot 命令行工具

[返回首页](../README.md) · [部署指南](deployment.md) · [高级运维与备份](AI-INSTALL.md) · [客户端获取](clients.md)

`rokbot` 把部署、管理员引导、环境检查、更新回滚和本地打包收进一个命令。它是一层很薄的外壳，实际工作仍由仓库里已有的脚本完成：镜像部署用 `host/release/install-images.sh`，源码部署用 `host/deploy.py`，备份用 `host/release/backup.py`，打包用各平台的补丁脚本。只需要 Node.js 20+，没有第三方依赖。

## 安装

本仓库是私有仓库，需要有访问权限。

```bash
# 已有源码：在仓库根目录运行，把 rokbot 链接到 ~/.local/bin
bash scripts/install-cli.sh

# 新机器：一行完成 clone 和安装（CLI 放在 ~/.rokbot/cli）
git clone https://github.com/hongfaqiu/rokbot.git ~/.rokbot/cli && bash ~/.rokbot/cli/scripts/install-cli.sh
```

不安装也能直接用：`node bin/rokbot.mjs --help`，或 `npx github:hongfaqiu/rokbot --help`。

`install-cli.sh` 支持这些环境变量：`ROKBOT_BIN_DIR`（链接放在哪里，默认 `~/.local/bin`）、`ROKBOT_CLI_DIR`（不在仓库里运行时 clone 到哪里）、`ROKBOT_REPO_URL`、`ROKBOT_REF`。

## 快速开始

```bash
rokbot doctor          # 检查环境
rokbot init            # 向导：选择镜像或源码模式，写入配置
rokbot up              # 启动 Host 和执行桌面
rokbot admin           # 首次设置管理员密码（默认生成强随机密码，只显示一次）
rokbot status
```

打开 `rokbot status` 显示的管理页地址，用刚才的密码登录，然后在「对话模型」里添加模型服务。

## 命令

所有命令都接受 `--home <目录>` 指定实例目录（默认 `~/rokbot`，也可用环境变量 `ROKBOT_HOME`），`rokbot <命令> --help` 查看完整选项。

| 命令 | 作用 |
| --- | --- |
| `init` | 交互式向导；`--yes` 或参数非交互；`--dry-run` 只预览 |
| `up` | 启动 |
| `down` | 停止（保留容器和数据卷）；镜像模式 `--remove` 同时移除容器 |
| `status` | 容器状态、健康检查、镜像、管理页地址、管理员是否已设置；`--json` |
| `logs` | `rokbot logs [host\|box] [-f] [--tail N]` |
| `update` | 打回滚标签、备份数据卷，再拉新代码或镜像并重启 |
| `rollback` | 镜像模式：切回上一次 `update` 之前的镜像 |
| `admin` | 首次设置管理员、`--reset` 重置、`--status`、`--setup-key` |
| `doctor` | 环境检查，有失败项时退出码为 1 |
| `pack` | 用本地的官方原版安装包生成客户端，输出到 `./dist/<平台>/` |

### init

两种部署方式：

- **镜像模式**（`--mode image`，默认）：使用仓库发布的预构建镜像 `ghcr.io/hongfaqiu/rokbot/host:latest` 和 `ghcr.io/hongfaqiu/rokbot/box:2bb5e41`。CLI 把 `host/release/docker-compose.images.yml` 复制到实例目录，按 `host/release/.env.images.example` 的格式写入 `.env`，再用 `install-images.sh --local --prepare-only` 校验配置、补齐随机密钥，最后拉取镜像（`--no-pull` 跳过）。镜像需要 GHCR 权限，先 `docker login ghcr.io`；无法拉取时改用源码模式，或用 `--host-image` / `--box-image` 指向镜像加速地址。
- **源码模式**（`--mode source`）：`git clone` 仓库到 `--src`（默认 `<实例目录>/src`），已有仓库则 `git pull --ff-only`，然后运行 `host/deploy.py init` 写入 `.env`。之后的构建、启动、更新都由 `host/deploy.py` 完成。分机部署加 `--host-only`。

Host 配置项：`--listen`（默认 `127.0.0.1`）、`--port`（默认 18080）、`--web-port`（默认管理端口 + 1）、`--public-url`（客户端实际输入的地址）、`--web-public-url`、`--tz`、`--project`（Compose 项目名，也是数据卷前缀）。校验规则与 `host/deploy.py init` 相同：监听非本机地址时必须给 `--public-url`；网页版地址必须与管理页地址不同。

```bash
# 局域网访问
rokbot init --yes --listen 192.168.1.10 --public-url http://192.168.1.10:18080
# HTTPS 反向代理之后
rokbot init --yes --public-url https://bot.example.com --web-public-url https://web.bot.example.com
# 先看看会做什么
rokbot init --dry-run --mode source
```

`init` 从不覆盖已有的 `.env`；同一个 Docker 上已有同名项目（容器或数据卷）时也会拒绝，避免两个实例共用数据卷。

### admin

- **首次设置**：Host 运行起来后执行 `rokbot admin`。CLI 用 Host 容器里的一次性初始化码 `/data/setup-key`，通过 `host/tools/host-admin.mjs setup`（源码模式是 `host/deploy.py admin setup`）完成设置。
- **重置**：`rokbot admin --reset`。Host 没有重置接口，CLI 用 Host 自己的 scrypt 参数（`host/server/security.mjs`）在本地算出哈希，停止 Host，用 Host 镜像起一个无网络的一次性容器，把哈希写进数据卷里的 `/data/auth.json`（原子替换，权限 600），再启动 Host。所有管理页登录会话失效，已配对的设备不受影响。
- **密码来源**：默认生成 24 位随机密码；`--prompt` 自己输入（两次，不回显）；`--password-file <文件>` 或环境变量 `ROKBOT_ADMIN_PASSWORD`。密码 12–128 位。

安全约定：

- 不接受 `--password` 之类的命令行明文参数，避免留在 shell 历史和进程列表里。
- 生成的密码只在终端显示一次。输出不是终端（管道、日志）时拒绝打印，可改用 `--save-to <新文件>` 写入一个新的 600 权限文件。
- Host 只保存哈希；密码不写入任何日志或配置文件。设置时密码通过子进程环境变量传给 `docker compose exec`，不出现在命令参数里。

### update 与 rollback

镜像模式：

1. 给 Host、box 当前使用的镜像打标签 `rokbot-rollback/<项目>-<服务>:<时间>`；
2. 用 `host/release/backup.py` 把全部数据卷备份到 `<实例目录>/backups/<项目>-<时间>/`（`--no-backup` 跳过，不推荐）；
3. 运行 `install-images.sh --local` 拉取新镜像并等待健康检查（`--no-pull` 只用本地镜像重新部署）；
4. 回滚记录写入 `<实例目录>/rollback.json`，`rokbot rollback` 会把 `.env` 的镜像指向这些标签并重启。

新版本若已迁移数据，旧镜像未必能读取。最稳妥的回滚是按 [卷备份与恢复](AI-INSTALL.md#volume-recovery) 把备份恢复到一个新项目。

源码模式：给当前提交打 git 标签 `rokbot-rollback-<时间>`，`git pull --ff-only`，再运行 `host/deploy.py update`（构建候选镜像、停止、备份数据卷、切换，失败时按它自己的规则处理）。需要退回时 `git checkout rokbot-rollback-<时间>`，再 `rokbot update --no-pull`。

### doctor

检查项：Node.js 20+、Docker Engine（低于 26 时提示）、Compose v2 2.26+、git、python3（源码模式需要 3.10+）、桌面打包依赖 `@electron/asar`、实例目录所在磁盘的可用空间（少于 30 GB 提示，少于 5 GB 失败）、管理端口和网页版端口是否被占用、对外 HTTPS 地址的证书（是否受信任、剩余天数）、安卓正式签名密钥。

安卓签名沿用 `android/release/signing-guard.mjs` 的规则：

- 默认要求 `~/.rokbot-local/android-signing.json` 存在（`--keystore` 可另指定），且证书 SHA-256 与 `android/release/signing-pin.json` 一致（`46214d3d` 开头）。缺失、无法解析或指纹不符都判为**失败**。
- 只有显式加 `--dev-signing` 或设置 `ROKBOT_ANDROID_DEV_SIGNING=1` 时才降为提示。这样打出的 APK 不能作为正式版发布，已安装的客户端也无法原地升级。

`--skip-network` 不连外网检查证书；`--deep` 在源码模式下再跑一次 `host/deploy.py doctor`（架构与执行桌面兼容性探针）；`--json` 输出机器可读结果。

### pack

```bash
rokbot pack <平台> --input <官方原版安装包路径> [--output <目录>] [-- 补丁脚本的其他参数]
```

输入必须是你自己从官方渠道下载的 Grok Bot 官方原版安装包。**本工具不下载原版，也不提供打过补丁的成品**；没有 `--input` 时直接报错。CLI 先按仓库固定的版本和 SHA-256 校验输入，再调用已有的补丁脚本，并且总是把本地文件作为输入传进去，补丁脚本不会自己去下载：

| 平台 | 输入 | 校验依据 | 调用的脚本 |
| --- | --- | --- | --- |
| `android` | `.xapk` / `.apks` / `.apk`，1.26.0（build 3212） | `patch-android.mjs --verify-only` 与 `android/recipes/manifest.json` 的包名、界面包摘要 | `android/release/patch-android.mjs` |
| `mac` | Apple Silicon `.dmg` 或 `.app` | `mac/patchers/desktop/**/supported.json` | `mac/patchers/desktop/patch.mjs`（需在 macOS 上运行） |
| `windows` | x64 `Setup.exe`、`app-64.7z` 或安装目录 | `windows/patchers/desktop/**/supported.json` | `windows/patchers/desktop/patch.mjs`（需在 Windows 上运行，或加 `--allow-cross-platform`） |
| `linux` | `.deb`（x64 / arm64） | `linux/patchers/desktop/*/supported.json` | `linux/patchers/desktop/patch.mjs` |
| `web` | Windows x64 `Setup.exe` | Windows 固定摘要，且版本在 `web/patchers/supported.json` 中 | `web/patchers/patch.mjs` |
| `ios` | 已解密的 `.ipa` | 由 `patch-ios.py` 按 Info.plist 与固定摘要校验 | `ios/release/patch-ios.py` |

安卓打包前会先做与 `doctor` 相同的签名检查，正式密钥不符时直接停止；`--keystore`、`--dev-signing` 原样传给 `patch-android.mjs`。`--dry-run` 只校验输入并显示将运行的命令。`--` 之后的参数原样交给补丁脚本，例如 `-- --app-version 1.3.1` 或 `-- --rokbot-build 2`。产物和一份 `rokbot-pack.json`（输入版本与摘要）写到 `<输出目录>/<平台>/`。

生成的客户端只装在自己的设备上，或由 Host 管理员在管理页「客户端更新」发布，不要公开分发。各平台的细节见对应目录的 README 和 [客户端获取](clients.md)。

## 实例目录里的文件

| 文件 | 说明 |
| --- | --- |
| `.env` | Host 配置，权限 600。镜像模式按 `.env.images.example` 生成，源码模式由 `host/deploy.py init` 生成 |
| `docker-compose.images.yml` | 镜像模式的 Compose 文件（从仓库复制）。源码模式直接使用仓库里的 `host/release/compose.yaml` |
| `rokbot.json` | CLI 状态：部署方式、项目名、源码目录，权限 600 |
| `rollback.json` | 镜像模式最近一次 `update` 的回滚标签与备份位置，权限 600 |
| `backups/` | 数据卷备份 |

对话、配对、模型 Key 等数据都在 Docker 数据卷（`<项目>_host-data`、`<项目>_box-home`、`<项目>_box-workspace`）里，`down` 和 `update` 都不会删除它们。已经用 `install-images.sh` 或 `host/deploy.py` 部署过的实例，直接用 `--home` 指向原实例目录即可接管，CLI 会从 `.env` 识别部署方式。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `ROKBOT_HOME` | 默认实例目录 |
| `ROKBOT_ADMIN_PASSWORD` | `admin` 使用的密码（不在命令行里传） |
| `ROKBOT_ANDROID_DEV_SIGNING=1` | 显式允许安卓临时开发签名 |
| `ROKBOT_CLI_DEBUG=1` | 出错时打印调用栈 |

## 开发

测试在 `scripts/cli/tests/`：

```bash
node --test scripts/cli/tests/*.test.mjs
# 有官方安卓原包时，额外验证真实输入的识别
ROKBOT_ANDROID_TEST_XAPK=/path/to/official.xapk node --test scripts/cli/tests/*.test.mjs
```
