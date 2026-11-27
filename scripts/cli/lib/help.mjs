// Help text. Chinese output, English command names. Only `pack` names the official input package.
export const MAIN_HELP = `rokbot：RokBot 自部署与本地打包命令行工具

用法：rokbot <命令> [选项]
      rokbot help <命令>      查看某个命令的详细说明

部署
  init        交互式向导：选择镜像模式或源码模式，生成 Host 配置（.env）和 Compose 文件
  up          启动 Host 和执行桌面（box）
  down        停止服务（保留容器和数据卷）
  status      容器状态、管理页地址、管理员是否已设置
  logs        查看日志
  update      更新：先打回滚标签并备份数据卷，再拉新代码或新镜像并重启
  rollback    镜像模式下切回上一次 update 之前的镜像
  admin       管理员密码：首次设置（强随机或自己输入）、重置

检查与打包
  doctor      检查 Node、Docker、磁盘、端口、证书、安卓签名密钥
  pack        用本地的官方原版安装包生成客户端（android/mac/windows/linux/web/ios），输出到 ./dist

通用选项
  --home <目录>   实例目录（.env、Compose 文件、备份），默认 ~/rokbot，也可用 ROKBOT_HOME
  -h, --help      显示帮助
  --version       显示 CLI 版本

示例
  rokbot init                       按向导完成配置
  rokbot init --yes --mode image    非交互，全部使用默认值
  rokbot up && rokbot admin         启动并设置管理员密码
  rokbot pack android --input ~/Downloads/原版.xapk

密码和密钥不会作为命令行参数接收，也不会写进日志；配置文件权限为 600。`;

export const COMMAND_HELP = {
  init: `用法：rokbot init [选项]

在终端里运行时逐项询问；加 --yes 或在非终端环境中运行时使用参数和默认值。
已有 .env 的实例目录不会被覆盖。

部署方式
  --mode <image|source>   image：拉取仓库发布的预构建镜像（默认）
                          source：git clone / pull 仓库，由 host/deploy.py 在本机构建
  --src <目录>            源码模式的代码目录，默认 <实例目录>/src；已是 git 仓库时执行 pull --ff-only
  --repo <URL>            源码仓库地址，默认 https://github.com/hongfaqiu/rokbot.git
  --ref <分支或标签>      clone 时检出的分支或标签
  --host-image <镜像>     镜像模式的 Host 镜像（可换成镜像加速地址）
  --box-image <镜像>      镜像模式的执行桌面镜像
  --host-only             源码模式：执行桌面部署在另一台机器（分机部署）

Host 配置
  --listen <IP>           监听地址，默认 127.0.0.1；专网访问填服务器专网 IP（需同时给 --public-url）
  --port <端口>           管理端口，默认 18080
  --web-port <端口>       网页版端口，默认管理端口 + 1
  --public-url <URL>      客户端实际输入的地址，例如 https://bot.example.com
  --web-public-url <URL>  网页版单独的地址（反向代理后用独立子域名时）
  --tz <时区>             容器时区，默认 Asia/Singapore
  --project <名称>        Compose 项目名（也是数据卷前缀），默认 rokbot

其他
  --no-pull               镜像模式：只写配置，不拉取镜像
  --start                 完成后立即启动
  --dry-run               只显示将要执行的步骤和 .env 预览，不写文件、不联网
  -y, --yes               不询问，使用参数和默认值`,

  up: `用法：rokbot up [选项] [-- host/deploy.py up 的参数]

镜像模式：运行 host/release/install-images.sh --local，本机已有镜像时不重新拉取。
源码模式：首次由 host/deploy.py up 构建并启动；之后直接启动已有容器并等待健康检查。

  --pull       镜像模式：即使本机已有镜像也重新拉取（建议改用 rokbot update）
  --no-wait    源码模式：启动后不等待健康检查`,

  down: `用法：rokbot down [选项]

停止 Host 和执行桌面。从不删除数据卷。

  --remove     镜像模式：同时移除容器和网络（数据卷保留，rokbot up 会重新创建容器）`,

  status: `用法：rokbot status [--json]

显示各服务容器的状态与健康检查、镜像、管理页地址，以及管理员是否已设置。`,

  logs: `用法：rokbot logs [host|box] [选项]

  -f, --follow      持续输出
  --tail <行数|all> 默认 100 行`,

  update: `用法：rokbot update [选项] [-- host/deploy.py update 的参数]

镜像模式：给当前镜像打回滚标签 rokbot-rollback/<项目>-<服务>:<时间>，用 host/release/backup.py
备份全部数据卷到 <实例目录>/backups/，然后拉取新镜像并重启。之后可用 rokbot rollback 切回。
源码模式：给当前提交打 git 标签 rokbot-rollback-<时间>，git pull --ff-only，再运行
host/deploy.py update（构建候选镜像、停止、备份数据卷、切换）。

  --no-pull     不拉取新代码或新镜像，只用本地已有的版本重新部署
  --no-backup   镜像模式：跳过数据卷备份（不推荐）`,

  rollback: `用法：rokbot rollback

镜像模式：把 .env 中的镜像指向最近一次 rokbot update 打的回滚标签并重启。
新版本若已迁移数据，旧镜像可能无法读取；稳妥做法是把备份恢复到新项目（见 docs/AI-INSTALL.md）。
源码模式请用 git 回滚标签。`,

  admin: `用法：rokbot admin [选项]

Host 未设置管理员时：用容器内的一次性初始化码（/data/setup-key）完成首次设置。
默认生成 24 位强随机密码，只在终端显示一次；也可以自己输入（不回显）。
Host 只保存 scrypt 哈希；密码不会作为命令行参数、不写日志、不落盘。

  --reset               重置密码：停止 Host，把新密码的哈希写入数据卷，所有管理页登录失效
  --status              只查看管理员是否已设置
  --setup-key           在终端显示一次性初始化码（用于在浏览器里手动设置）
  --prompt              自己输入密码（输入两次，不回显）
  --generate            生成随机密码（不询问）
  --password-file <文件> 从文件读取密码（也可用环境变量 ROKBOT_ADMIN_PASSWORD）
  --save-to <新文件>    把生成的密码写入一个新文件（权限 600）而不是显示在终端
  -y, --yes             不询问，直接生成随机密码

密码需要 12–128 个字符。输出不是终端时不会打印生成的密码。`,

  doctor: `用法：rokbot doctor [选项]

检查 Node.js（20+）、Docker 与 Compose v2（2.26+）、git / python3、磁盘空间、管理端口和网页版端口、
对外 HTTPS 地址的证书，以及安卓正式签名密钥。

安卓签名规则与 android/release/signing-guard.mjs 一致：默认要求 ~/.rokbot-local/android-signing.json
存在，且证书 SHA-256 与 android/release/signing-pin.json 一致（46214d3d 开头），否则判为失败。
只有显式加 --dev-signing 或设置 ROKBOT_ANDROID_DEV_SIGNING=1 时才降为提示，此时打出的 APK 不能作为正式版发布。

  --keystore <文件>   指定签名密钥文件
  --dev-signing       显式允许临时开发签名密钥
  --skip-network      不连接对外地址检查证书
  --deep              源码模式：再运行 host/deploy.py doctor（架构与执行桌面兼容性探针）
  --json              输出 JSON

有失败项时退出码为 1。`,

  pack: `用法：rokbot pack <平台> --input <官方原版安装包路径> [选项] [-- 补丁脚本的其他参数]

平台：android、mac、windows、linux、web、ios

输入必须是你自己从官方渠道下载的 Grok Bot 官方原版安装包（本地路径）。本工具不下载原版，
也不提供打过补丁的成品。CLI 先按仓库固定的版本与 SHA-256 校验输入，再调用仓库已有的补丁脚本：

  android   android/release/patch-android.mjs   .xapk / .apks / .apk（1.26.0，build 3212）
  mac       mac/patchers/desktop/patch.mjs       Apple Silicon .dmg 或 .app（需在 macOS 上运行）
  windows   windows/patchers/desktop/patch.mjs   x64 Setup.exe / app-64.7z / 安装目录（需在 Windows 上运行）
  linux     linux/patchers/desktop/patch.mjs     .deb（x64 / arm64）
  web       web/patchers/patch.mjs               Windows x64 Setup.exe（网页版界面取自其中）
  ios       ios/release/patch-ios.py             已解密的 .ipa（1.27.0 / 1.26.0 / 1.16.0）

  -i, --input <路径>      官方原版安装包（必填）
  -o, --output <目录>     输出根目录，默认 ./dist（实际输出到 <目录>/<平台>/）
  --force                 覆盖已有输出（android / linux / web）
  --keystore <文件>       android：正式签名密钥，默认 ~/.rokbot-local/android-signing.json
  --dev-signing           android：显式允许临时开发签名（产物不能作为正式版发布）
  --allow-cross-platform  windows：在非 Windows 系统上生成
  --dry-run               只校验输入并显示将运行的命令

示例
  rokbot pack android --input ~/Downloads/原版-1.26.0.xapk
  rokbot pack web --input ~/Downloads/原版-Setup.exe -- --app-version 1.3.1`,
};

export function helpFor(command) {
  return COMMAND_HELP[command] ?? null;
}
