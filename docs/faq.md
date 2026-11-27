# 常见问题与合规说明

[返回首页](../README.md) · [English](faq.en.md) · [部署指南](deployment.md) · [客户端获取](clients.md) · [安全策略](../SECURITY.md)

## 常见问题

**没有公网 IP，怎么在外面访问？**

在管理页「远程访问」开启内置的 Tailcat，不需要 Tailscale 账号；也可以用 Tailscale、VPN 或 HTTPS 反向代理。网页版不支持 Tailcat，外网使用网页版请用 VPN 或 HTTPS 域名。不要把管理页直接暴露到公网，见 [`SECURITY.md`](../SECURITY.md)。

**为什么手机在局域网里连不上 Host？**

`ROKBOT_LISTEN_ADDRESS` 默认是 `127.0.0.1`，只有本机能访问。局域网使用时，把它改成服务器的局域网 IP（或在防火墙后用 `0.0.0.0`）。注意，Docker 发布的端口会绕过 ufw 等主机防火墙。

**ARM 服务器能部署吗？**

能。Host 镜像支持 `linux/arm64`；执行桌面 `box` 只有 `linux/amd64` 镜像，需要在宿主机开启 binfmt/QEMU，Apple Silicon 上可以用 Rosetta。

**为什么仓库里没有客户端安装包？**

本仓库只分发本项目自己编写的代码和文档，不包含原版程序文件，也不提供打过补丁的安装包。你可以自备官方安装包，用补丁工具在本机构建；也可以从自己 Host 的管理员那里获取，管理员在管理页「客户端更新」发布。两种方式见[获取客户端](clients.md#获取客户端)，原因见下方[分发与合规说明](#分发与合规说明)。

**API Key 存在哪里？会被读出来吗？**

API Key 保存在 Host 数据卷的 `/data/model.env`。管理接口和客户端只能看到「是否已设置」，读不到 Key 本身。

**怎么备份数据？**

数据在 `host-data`（挂载为 `/data`）、`box-home` 和 `box-workspace` 三个数据卷里。用 `host/deploy.py` 部署时，可以运行 `python3 host/deploy.py backup`，恢复步骤见 [`docs/AI-INSTALL.md`](AI-INSTALL.md#volume-recovery)。备份里有对话记录和 Key，请妥善保管。不要运行 `docker compose down -v`，它会删除数据卷。

## 分发与合规说明

- 本项目不分发第三方客户端的二进制文件。仓库中只有本项目自己编写的 Host 源码、镜像构建脚本、补丁工具、构建脚本和文档；原版安装包需要使用者自行取得。
- RokBot 使用 [ProkBot Noncommercial License 1.0](../LICENSE)。允许个人使用、自托管、学习、修改和非商业分发；禁止任何商业用途，包括出售或付费授权、付费托管和付费服务、集成到商业产品、企业内部使用，以及通过广告等方式变现。完整条款以 [LICENSE](../LICENSE) 为准，衍生关系和第三方组件见 [NOTICE](../NOTICE)。
- 补丁工具仅供个人学习和自托管使用。[LICENSE](../LICENSE) 允许的非商业分发只适用于本项目自己的代码，不涵盖原版程序的任何内容。
- 使用原版客户端及其补丁时，请遵守原客户端的许可条款和相关服务条款。
- 用补丁工具生成的客户端、网页版界面包和内置界面包的镜像，只用于你自己的 Host，请勿公开传播。通过 Host 分发安装包时，渠道和使用范围由该 Host 的管理员负责。
- 以上说明不构成法律意见。具体能否使用，请以原客户端的许可条款和你所在地区的法律为准。
