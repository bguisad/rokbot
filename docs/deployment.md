# 部署指南

[返回首页](../README.md) · [English](deployment.en.md) · [客户端获取](clients.md) · [AI 助手部署手册](AGENT_DEPLOY.md) · [高级运维与备份](AI-INSTALL.md)

RokBot 是一个面向个人的自托管 AI 助手。Agent 服务端（Host）和 Bot 的执行桌面（`box`）都用 Docker 部署在你自己的机器上，模型调用走你配置的 OpenAI 或 Anthropic 兼容接口。macOS、Windows、Linux、Android、iOS 客户端和网页版只连接你自己的 Host。对话、文件、配置和 API Key 都保存在 Host 的数据卷里。

## 1. 部署 Host 和执行容器

准备一台装好 Docker（含 Compose v2）的 Linux 或 macOS 服务器。本仓库是私有仓库，匿名访问 `raw.githubusercontent.com` 会失败，所以先 clone 仓库（需要访问权限），再在本地运行安装脚本：

```bash
# 克隆仓库；已登录 GitHub CLI 时可以用 gh
gh repo clone hongfaqiu/rokbot rokbot-src
# 没有 gh 时用 git：git clone https://github.com/hongfaqiu/rokbot.git rokbot-src

mkdir rokbot && cd rokbot
bash ../rokbot-src/host/release/install-images.sh --local
```

`--local` 让脚本直接复制仓库里的 `docker-compose.images.yml` 和 `.env.images.example`，不再联网下载这两个文件。预构建镜像同样需要访问权限，拉取前先登录 GHCR，令牌需要 `read:packages` 权限：

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <GitHub 用户名> --password-stdin
```

无法拉取镜像时，可以改为在服务器上从源码构建，见 [`docs/AI-INSTALL.md`](AI-INSTALL.md)。

脚本依次完成以下工作：

1. 生成 `.env`（权限 0600）并填好随机密钥；
2. 拉取镜像；
3. 启动 Host 和 `box` 容器；
4. 如果 Compose 支持，等待健康检查通过；
5. 打印管理页和网页版的地址。

> [!TIP]
> - **交给 AI 部署**：把 [`docs/AGENT_DEPLOY.md`](AGENT_DEPLOY.md) 发给 Claude Code、Cursor、Codex 等 AI 编程助手，它会按手册完成环境检查、部署和验收。
> - **常用参数**：
>   - 上面的命令已经带了 `--local`；去掉它，脚本会改从 `raw.githubusercontent.com` 下载模板，私有仓库下匿名访问会失败；
>   - 想先改配置再启动，用 `--prepare-only`，改完后去掉它重新运行（保留 `--local`）；
>   - 离线环境，先用 `docker load` 导入镜像，再用 `--offline`。
> - **镜像加速和代理**：在 `.env` 中设置 `ROKBOT_HOST_IMAGE` / `ROKBOT_BOX_IMAGE` 换成镜像地址，或设置 `HTTP_PROXY` / `HTTPS_PROXY`。

## 2. 初始化 Host 并连接客户端

1. 读取一次性初始化密钥：
   ```bash
   docker compose --env-file .env -f docker-compose.images.yml exec -T host cat /data/setup-key
   ```
2. 用浏览器打开管理页 `http://127.0.0.1:18080/admin`，输入初始化密钥，设置管理员密码（12–128 位）。
3. 连接客户端：
   - **原生客户端**：先按[客户端获取与构建](clients.md#获取客户端)取得客户端。在管理页「设备与通知」创建 6 位配对码，在 macOS、Windows、Linux、Android 或 iOS 客户端中输入 Host 地址和配对码；也可以直接用管理员密码登录。
   - **网页版**：默认启用，地址是 `http://127.0.0.1:18081/web/`。预构建镜像不包含网页版界面包，第一次使用前需要按 [`web/README.md`](../web/README.md) 生成界面包，并在管理页「网页版」上传。

## 3. 配置模型

在管理页「对话模型」（`/admin?view=model`），或用管理员密码配对的客户端设置里：

1. 添加模型服务：选择接口格式（OpenAI Chat、OpenAI Responses 或 Anthropic），填写 Base URL 和 API Key；
2. 读取模型列表，创建模型档案并测试连接；
3. 设置默认路由；需要时，为单个 Bot 或 6 个调用场景单独设置路由和备用模型。

保存后就可以创建 Bot、开始对话了。

## 进阶部署与运维

- AI 编程助手执行手册（环境检查、预构建镜像、源码构建、发版与排障）：[`docs/AGENT_DEPLOY.md`](AGENT_DEPLOY.md)
- 使用 `host/deploy.py` 源码部署、分机部署与数据卷备份恢复：[`docs/AI-INSTALL.md`](AI-INSTALL.md)
- 外网访问、局域网连接与数据备份常见问题：[`docs/faq.md`](faq.md)
- 部署安全建议与漏洞报告：[`SECURITY.md`](../SECURITY.md)
