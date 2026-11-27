# 架构概览

[返回首页](../README.md) · [English](architecture-overview.en.md) · [完整技术架构](ARCHITECTURE.md) · [补丁维护流程](PATCHING_WORKFLOW.md)

```mermaid
flowchart LR
  subgraph Clients["客户端"]
    Desktop["macOS / Windows / Linux 客户端"]
    Mobile["iOS / Android 客户端"]
    Web["网页版 (:18081)"]
  end

  subgraph HostC["host 容器"]
    Admin["管理服务 (:18080)<br/>登录 / 配对 / 配置 / 推送 / 更新"]
    Core["原版 Host<br/>Agent / 工具 / 上下文 / 定时任务"]
    Adapter["模型适配层<br/>路由 / 备用 / 自动审查"]
    Admin --> Core --> Adapter
  end

  Desktop --> Admin
  Mobile --> Admin
  Web --> Admin
  Adapter --> Models["你的模型接口<br/>Chat / Responses / Anthropic"]
  Core --> Box["box 容器<br/>Linux 桌面 + VNC"]
  Core -.经客户端反向连接.-> PC["你的 Mac / Windows 电脑"]
  Admin --> Push["APNs / Bark / ntfy 等推送"]
  Admin <--> Tailcat["Tailcat 加密组网"]
```

- **Host**：原版 Node.js 程序，只替换和官方服务绑定的部分（身份验证、Agent 身份、模型调用、MCP 配置），外面加一层管理服务。
- **执行电脑**：官方 Linux 桌面镜像，原样运行在 Docker 里；也可以让 Agent 操作你自己的电脑。
- **客户端**：保留原版界面，补丁让它只连接你的 Host。补丁只做「复制」和「新增」两种操作，每一段都先校验原文件的哈希，不反编译、不重写原版程序。

更多实现细节、功能对照与目录结构见 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)，各平台补丁基线与维护流程见 [`docs/PATCHING_WORKFLOW.md`](PATCHING_WORKFLOW.md)。
