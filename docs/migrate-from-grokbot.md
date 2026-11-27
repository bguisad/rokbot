# 从 Grok Bot 迁移

[返回 README](../README.md) · [客户端](clients.md) · [技术文档](ARCHITECTURE.md)

把 Grok Bot 里的 Bot 搬到你自己的 RokBot：Bot 列表（名字、简介、指令、头像、设置）、每个 Bot 的记忆、共享用户记忆、技能、例程、参考资料，以及可选的聊天记录。有两种方式，可以单独用，也可以一起用：

| | 方式一：一键物理迁移 | 方式二：prompt 导出 |
| --- | --- | --- |
| 原理 | 读取本机 Grok Bot 数据目录里的缓存 | 让 Grok Bot 按 RokBot 的格式自己导出，上传到一次性地址 |
| 能迁移 | Bot 列表、指令、头像形状和颜色、通知和侧栏设置、最近的聊天记录缓存、例程名称、需要重新授权的应用 | 档案、记忆、技能、例程（含 prompt 和触发时间）、参考资料、共享用户记忆、共享技能、聊天记录 |
| 在哪用 | 桌面客户端（macOS / Windows / Linux）；网页管理后台上传 ZIP | 网页管理后台、桌面客户端、安卓、iOS |

Grok Bot 的记忆、技能、例程内容和资料库文件保存在 Grok Bot 云端，本机只有缓存，所以**完整迁移需要方式二**。方式一适合先把 Bot 和对话记录快速搬过来；之后再用方式二补齐记忆和技能。两种方式导入同一个 Bot 时会合并到同一个 RokBot Bot，不会产生重复。

## 方式一：一键物理迁移

### 桌面客户端

打开「设置 → 通用 → 迁移 → 打开迁移向导」（macOS 也可以在菜单栏「RokBot → 从 Grok Bot 迁移…」打开）。向导会自动查找本机的数据目录：

| 系统 | Grok Bot 数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/Grok Bot` |
| Windows | `%APPDATA%\Grok Bot` |
| Linux | `~/.config/Grok Bot`（设置了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/Grok Bot`） |

同一位置的 `Grok Bot Local` 是旧版 RokBot 桌面客户端的目录，格式相同，也会列出来。找不到时可以手动「选择目录」，或「选择 ZIP 或 JSON 文件」。

点「扫描并加入待导入」后，客户端只读取 `sand-client-persistence/*.blob`（或旧版的 `local-client-persistence.json`）和目录根部的 `rokbot-migrate*.json`，打包后上传到 Host。`sand-secrets.json`、`connection.json`、`Cookies`、`automation-webhook-keys/`、浏览器存储等**不会被打开**，只记录它们是否存在，用来提示你哪些授权需要重新填写。客户端不会修改、移动或删除 Grok Bot 目录里的任何文件。

### 网页管理后台

在管理页「Bot 与数据 → 从 Grok Bot 迁移 → 上传迁移包」（地址 `/admin#/bots/migrate`，旧链接 `/admin?view=migrate` 会自动跳转）选择文件：

- 把整个 Grok Bot 数据目录打包成 ZIP 上传（Finder「压缩」、Windows「发送到 → 压缩文件夹」都可以），目录外面多一层文件夹也没关系；
- 也可以上传 Bot 导出的 `rokbot-migrate.json`，或把多个导出文件和数据目录放进同一个 ZIP。

上传以请求体流式写入 Host 磁盘，**不设文件大小上限**；Host 只读取 ZIP 中需要的条目，缓存、图片等其他内容不会被解压。

## 方式二：让 Grok Bot 导出

1. 在迁移页面选择导出范围：「当前 Bot」把 prompt 发给每个 Bot，各自导出自己；「所有 Bot」发给一个能看到所有 Bot 的总管 Bot。
2. 点「生成上传地址并复制 prompt」。Host 生成一个一次性上传地址 `POST /api/migrate/inbox/<令牌>`：**24 小时有效、可多次上传、随时可以在页面上撤销**。prompt 里写明了 JSON 格式、版本号和上传命令。
3. 把 prompt 贴给 Grok Bot。Bot 整理好 `rokbot-migrate.json` 后用 HTTP POST 上传（JSON 请求体或 multipart 表单都可以）。上传成功的包会出现在「待导入」。
4. 如果 Grok Bot 访问不到你的 Host（例如 Host 只在内网），它会把文件发给你；在网页管理后台或桌面客户端「选择 ZIP 或 JSON 文件」手动上传即可。也可以用「只复制 prompt（不带上传地址）」直接走这条路。

安卓在「设置 → 连接与诊断 → 数据迁移 → 从 Grok Bot 迁移」，iOS 在连接页的「从 Grok Bot 迁移」按钮：可以复制迁移 prompt、管理上传地址、查看待导入并确认导入。手机不读取电脑上的数据目录。

## 预览和导入

每个迁移包导入前都要预览：

1. **选择内容**：勾选要迁移的 Bot，以及记忆、技能、例程、参考资料、聊天记录、共享用户记忆、共享技能。聊天记录默认不迁移。
2. **处理冲突**：已有同名 Bot 时可以「重命名」（默认，新建为「名称（迁移）」）、「跳过」或「覆盖」（合并到现有 Bot 并更新它的简介、指令和头像）。这一步也会列出需要你重新填写的密钥和授权。
3. **导入结果**：每个 Bot 新建或更新了什么、新增了多少记忆 / 技能 / 例程 / 文件，以及没有迁移的内容。

迁移后的内容在 RokBot 中这样保存：

| 内容 | 位置 |
| --- | --- |
| Bot 名称、简介、指令、头像形状和颜色、侧栏隐藏和更新通知 | Bot 资料 |
| 头像图片（导出中带了图片时） | Bot 头像 |
| 记忆（profile / log） | 该 Bot 的记忆 |
| 共享用户记忆 | Host 的用户记忆 |
| Bot 的技能 | 该 Bot 的技能（导入的 frontmatter 会被丢弃，只保留正文） |
| 共享技能 | 管理页「技能」，**默认停用**，确认后再启用 |
| 例程 | 该 Bot 的例程，**全部暂停**；cron 触发保留时间，其他触发方式需要手动设置 |
| 参考资料 | 该 Bot 的资料库（单个文件最大 20 MiB，每个 Bot 最多 100 个文件 / 100 MiB） |
| 聊天记录 | 资料库文件「Grok Bot 聊天记录.md」，仅作参考，不会写入对话 |

### 重复导入

导入可以重复执行，结果不变：

- 每个来源 Bot 有固定的标识（Grok Bot 的 Bot ID；导出中没有 ID 时用名称）。第一次导入后 Host 记下它对应的 RokBot Bot，以后再导入同一个 Bot（无论来自数据目录还是 prompt 导出）都只补充新增的记忆、技能、例程和文件。
- 你在 RokBot 里删掉的记忆或例程，再次导入时不会被恢复；你手动启用的例程也不会被重新暂停。
- 如果迁移过的 Bot 被删除了，再次导入会重新创建它。

## 安全

迁移进来的数据一律当作不可信数据处理：

- 只接受 `schema: "rokbot.migrate"`、`version: 1` 的文件；字段按白名单读取，未定义的字段会被忽略并在预览中提示；`__proto__`、`constructor`、`prototype` 这类字段、过深的嵌套、带路径的文件名和可执行文件会让整个文件被拒绝。
- 文本里像 API Key、令牌、私钥的内容会被替换为「[已移除疑似密钥]」；`secrets` 中只保留名称、用途和使用者，任何值都会被丢弃。
- 导入不会执行文件中的任何指令；例程导入后保持暂停，共享技能导入后保持停用。
- 上传地址的令牌是 32 字节随机数，24 小时后失效，可随时撤销；Host 只在设备或管理员已登录的接口中显示它。设备不能直接调用 Host 内部的导入方法。

## 迁移文件格式（rokbot.migrate v1）

```json
{
  "schema": "rokbot.migrate",
  "version": 1,
  "source": { "product": "Grok Bot", "exportedAt": "2026-11-27T09:00:00Z", "exportedBy": "Bot 名称" },
  "bots": [{
    "sourceId": "Grok Bot 的 Bot ID（可选）",
    "name": "Bot 名称",
    "title": "一句话简介",
    "description": "系统提示词 / 指令原文",
    "avatar": { "shape": "可选", "color": "可选", "imageBase64": "PNG / JPEG / WebP 的 Base64（可选）" },
    "settings": { "notificationsEnabled": true, "notifyOnUpdates": false, "hiddenFromSidebar": false },
    "memory": [{ "kind": "profile", "content": "…", "createdAt": "2026-10-01" }, { "kind": "log", "content": "…" }],
    "skills": [{ "name": "…", "description": "…", "content": "SKILL.md 正文" }],
    "routines": [{ "name": "…", "prompt": "…", "trigger": { "type": "cron", "schedule": "0 9 * * 1-5" }, "timeZone": "Asia/Shanghai" }],
    "files": [{ "name": "资料.md", "text": "…" }, { "name": "图.png", "contentType": "image/png", "base64": "…" }],
    "chat": [{ "role": "user", "text": "…", "at": "2026-11-26T08:00:00Z" }],
    "secrets": [{ "name": "GITHUB_TOKEN", "description": "用途", "usedBy": "哪个技能或例程" }]
  }],
  "userMemory": [{ "kind": "profile", "content": "…" }],
  "skills": [{ "name": "…", "description": "…", "content": "…" }],
  "secrets": [{ "name": "…" }]
}
```

`trigger.type` 可以是 `cron`（5 段 cron 表达式）、`webhook` 或 `manual`；无法识别的触发时间会写进例程说明，例程以手动触发导入。单个 JSON 文件最大 512 MiB，更大的数据请按 Bot 分成多个文件，放进同一个 ZIP 上传。

## 接口

| 接口 | 认证 | 作用 |
| --- | --- | --- |
| `GET /admin/api/migrate`、`/local/migrate` | 管理员会话 / 设备凭据 | 待导入列表和上传地址 |
| `POST …/migrate/tokens`、`DELETE …/migrate/tokens/<id>` | 同上 | 生成（返回 prompt）/ 撤销上传地址 |
| `GET …/migrate/prompt?tokenId=&scope=single\|all` | 同上 | 迁移 prompt |
| `POST …/migrate/packages?name=` | 同上 | 上传迁移包（请求体为 ZIP 或 JSON，不限大小） |
| `GET` / `DELETE …/migrate/packages/<id>` | 同上 | 预览 / 删除 |
| `POST …/migrate/packages/<id>/import` | 同上 | 导入，返回报告 |
| `GET` / `POST /api/migrate/inbox/<令牌>` | 令牌 | 检查地址 / 上传迁移文件 |

实现在 `host/server/migrate*.mjs`（解析、校验、待导入、导入编排）和 `host/runtime/migrate-import.mjs`（在原版 Host 中创建或更新 Bot、记忆、技能和例程）；向导界面 `host/server/public/migrate-wizard.js` 由管理页和桌面客户端共用。

## 已知限制

- 方式一只能拿到本机缓存：聊天记录是每个 Bot 最近的一段，例程只有名称；记忆、技能、例程内容和资料库文件需要方式二。
- 侧栏分组、语音音色等客户端设置不迁移；应用（MCP）连接、Webhook 密钥和账号登录状态需要在 RokBot 中重新授权。
- 聊天记录以资料库文件保存，不会还原成 RokBot 里的对话。
- prompt 导出的质量取决于 Grok Bot 能读到多少自己的数据；导入前请在预览中检查数量。
