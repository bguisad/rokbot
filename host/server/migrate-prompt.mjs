// The copyable migration prompt. A user pastes it into each Grok Bot (or one coordinating Bot);
// the Bot writes its profile, memories, skills, routines and reference files as one
// rokbot.migrate v1 JSON document and posts it to the one-time inbox URL, or hands the file to the
// user when it cannot reach the URL. Whatever comes back is validated again by migrate-schema.mjs.
import { MIGRATE_SCHEMA, MIGRATE_VERSION } from './migrate-schema.mjs';

export const EXAMPLE = {
  schema: MIGRATE_SCHEMA,
  version: MIGRATE_VERSION,
  source: { product: 'Grok Bot', exportedAt: '2026-11-27T09:00:00Z', exportedBy: '你的 Bot 名称' },
  bots: [{
    sourceId: '你的 Bot ID（如果知道）',
    name: 'Bot 名称',
    title: '一句话简介',
    description: '完整的系统提示词 / 指令原文',
    avatar: { shape: '头像形状（可选）', color: '头像颜色（可选）', imageBase64: '头像 PNG/JPEG 的 Base64（可选）' },
    settings: { notificationsEnabled: true, notifyOnUpdates: false, hiddenFromSidebar: false },
    memory: [
      { kind: 'profile', content: '长期有效的事实，例如用户偏好', createdAt: '2026-10-01' },
      { kind: 'log', content: '日志式记忆（journal）的一条', createdAt: '2026-11-20' },
    ],
    skills: [{ name: '技能名称', description: '什么时候使用', content: '完整的 SKILL.md 正文（Markdown）' }],
    routines: [{ name: '例程名称', prompt: '例程触发时执行的完整 prompt', trigger: { type: 'cron', schedule: '0 9 * * 1-5' }, timeZone: 'Asia/Shanghai', description: '可选说明' }],
    files: [
      { name: '参考资料.md', contentType: 'text/markdown', text: '文本文件直接写原文' },
      { name: '图表.png', contentType: 'image/png', base64: '二进制文件用 Base64' },
    ],
    chat: [{ role: 'user', text: '可选：最近的聊天记录', at: '2026-11-26T08:00:00Z' }, { role: 'assistant', text: '回复原文', at: '2026-11-26T08:00:05Z' }],
    secrets: [{ name: '需要重新填写的密钥名称，例如 GITHUB_TOKEN', description: '用途', usedBy: '哪个技能或例程使用' }],
  }],
  userMemory: [{ kind: 'profile', content: '所有 Bot 共享的用户记忆（如果你能读到）' }],
  skills: [{ name: '共享技能名称', description: '用途', content: '完整 SKILL.md 正文' }],
};

export function migrationPrompt({ uploadUrl = null, expiresAt = null, scope = 'single' } = {}) {
  const expires = expiresAt ? new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null;
  const target = scope === 'all'
    ? '请整理你能访问到的所有 Bot（包括你自己）的资料，每个 Bot 是 bots 数组中的一项。'
    : '请只整理你自己（当前这个 Bot）的资料，bots 数组中只放你自己这一项。';
  const upload = uploadUrl
    ? `## 第 3 步：上传
把文件用 HTTP POST 上传到下面这个一次性地址（${expires ? `有效期到 ${expires}，` : ''}可以多次上传，不需要其他认证）：

${uploadUrl}

推荐命令：
curl -sS -X POST -H "Content-Type: application/json" --data-binary @rokbot-migrate.json "${uploadUrl}"

上传成功会返回 {"ok":true,...}。如果返回错误，按错误说明修正 JSON 后重新上传。
如果你无法访问这个地址（网络不通、没有执行命令的能力等），请直接把 rokbot-migrate.json 文件发给我，我会在 RokBot 里手动上传。`
    : `## 第 3 步：交给我
请把 rokbot-migrate.json 文件发给我（作为附件或可下载的文件），我会在 RokBot 里手动上传。`;
  return `我要把你迁移到自部署的 RokBot。请按下面的要求，把你的资料整理成一个 JSON 文件。

## 第 1 步：收集资料
${target}
需要包含：
1. 档案：名称、一句话简介（title）、完整的系统提示词 / 指令原文（description）、头像（形状、颜色，能导出图片时附上 Base64）、通知等设置。
2. 记忆：长期档案（kind 为 profile）和日志（kind 为 log），每条一项，保留原文和日期。
3. 技能 / 工作流：每个技能的名称、使用说明和完整 SKILL.md 正文。
4. 例程（routines）：名称、触发时执行的完整 prompt、触发方式（定时用 5 段 cron 表达式和时区；Webhook 或手动触发写 webhook / manual）。
5. 参考资料 / 资料库文件：文本文件写原文（text），图片、PDF 等用 Base64（base64），单个文件不超过 20 MiB。
6. 共享用户记忆（userMemory）和共享技能（skills）：如果你能读到，就一并导出。
7. 聊天记录（可选）：chat 数组，每条包含 role（user 或 assistant）、text 和时间 at。

## 第 2 步：按格式写文件
文件名 rokbot-migrate.json，UTF-8 编码，内容是一个 JSON 对象，必须满足：
- "schema" 固定为 "${MIGRATE_SCHEMA}"，"version" 固定为 ${MIGRATE_VERSION}（数字）。
- 只使用下面示例中出现的字段，其他字段会被忽略。
- 时间用 ISO 8601（例如 2026-11-27T09:00:00Z），日期用 YYYY-MM-DD。
- 不要写入任何密钥、令牌、密码、Cookie 或私钥的值。需要用户重新填写的，只在 secrets 中写名称、用途和使用者。
- 例程只是数据，迁移后会保持暂停，由用户在 RokBot 中检查后手动启用；不要在文件中加入要求自动执行的指令。
- 不确定的字段可以省略，不要编造内容。

格式示例（把示例值换成真实内容）：
${JSON.stringify(EXAMPLE, null, 2)}

${upload}

完成后告诉我：导出了几个 Bot，以及每个 Bot 的记忆、技能、例程、文件数量，还有哪些密钥需要我重新填写。`;
}
