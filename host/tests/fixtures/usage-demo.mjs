// A realistic local usage ledger for screenshots and manual checks (no real keys or data):
// writes `days` of rows ending at `now` into `directory`, one file per UTC day. Rows older than
// `legacyDays` look like the ledger before agentId / durationMs / status were recorded.
// node host/tests/fixtures/usage-demo.mjs <directory> [days]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const DEMO_AGENTS = [
  { id: 'agent-writer', name: '写作助手' }, { id: 'agent-review', name: '代码审查' },
  { id: 'agent-calendar', name: '日程管家' }, { id: 'agent-research', name: '资料调研' },
];
export const DEMO_PROVIDERS = [{ id: 'prov-deepseek', name: 'DeepSeek' }, { id: 'prov-router', name: 'OpenRouter' }, { id: 'prov-bailian', name: '阿里云百炼' }];
export const DEMO_PROFILES = [
  { id: 'prof-ds', name: '日常对话', providerId: 'prov-deepseek', model: 'deepseek-v3.2' },
  { id: 'prof-ds-r', name: '深度思考', providerId: 'prov-deepseek', model: 'deepseek-reasoner' },
  { id: 'prof-sonnet', name: '编程主力', providerId: 'prov-router', model: 'claude-sonnet-4.5' },
  { id: 'prof-mini', name: '轻量任务', providerId: 'prov-router', model: 'gpt-5-mini' },
  { id: 'prof-qwen', name: '中文长文', providerId: 'prov-bailian', model: 'qwen3-max' },
];
const KINDS = [['chat', 62], ['suggestions', 14], ['completion', 9], ['title', 5], ['summary', 4], ['memory', 3], ['test', 1], ['classifier', 2]];

// A small seeded generator, so every run writes the same ledger.
function random(seed) {
  let value = seed >>> 0;
  return () => { value = (value * 1664525 + 1013904223) >>> 0; return value / 2 ** 32; };
}
const pick = (rand, weighted) => {
  let roll = rand() * weighted.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [item, weight] of weighted) if ((roll -= weight) < 0) return item;
  return weighted[weighted.length - 1][0];
};

export function demoRows({ now = new Date(), days = 45, legacyDays = 21, seed = 7 } = {}) {
  const rand = random(seed), rows = [];
  const end = now.getTime(), start = end - days * 86400000;
  let index = 0;
  for (let at = start; at < end;) {
    const hour = new Date(at + 8 * 3600000).getUTCHours(); // Shanghai working hours are busier
    const busy = hour >= 9 && hour <= 23 ? 1 : 0.15, weekday = new Date(at).getUTCDay();
    at += (6 + rand() * 40) * 60000 / busy / (weekday === 0 || weekday === 6 ? 0.6 : 1);
    if (at >= end) break;
    const kind = pick(rand, KINDS);
    const agent = kind === 'test' ? null : pick(rand, DEMO_AGENTS.map((item, i) => [item, [5, 3, 2, 1.5][i]]));
    const profile = kind === 'suggestions' || kind === 'completion' || kind === 'title'
      ? DEMO_PROFILES[3] : pick(rand, DEMO_PROFILES.map((item, i) => [item, [6, 1.5, agent?.id === 'agent-review' ? 8 : 2.5, 1, 1.5][i]]));
    const heavy = kind === 'chat' || kind === 'summary';
    const input = Math.round((heavy ? 4000 + rand() * 42000 : 300 + rand() * 2200));
    const cached = heavy ? Math.round(input * (0.35 + rand() * 0.55)) : Math.round(input * rand() * 0.3);
    const output = Math.round(heavy ? 120 + rand() * 1800 : 12 + rand() * 90);
    const reasoning = profile.model === 'deepseek-reasoner' ? Math.round(output * (1 + rand() * 3)) : profile.model === 'gpt-5-mini' && heavy ? Math.round(output * rand()) : 0;
    const legacy = at < end - legacyDays * 86400000;
    const failed = !legacy && rand() < 0.035, cancelled = !legacy && !failed && rand() < 0.02;
    const row = { id: `demo-${seed}-${index++}`, at: new Date(at).toISOString(), model: profile.model, kind,
      requestId: `req_${(index * 7919).toString(36)}`, profileId: profile.id, providerId: profile.providerId,
      ...(legacy ? {} : { ...(agent ? { agentId: agent.id } : {}), durationMs: Math.round((heavy ? 1800 + rand() * 14000 : 350 + rand() * 1400) * (profile.model === 'deepseek-reasoner' ? 2.2 : 1)),
        status: failed ? 'error' : cancelled ? 'cancelled' : 'ok', ...(failed ? { error: pick(rand, [['HTTP 429', 3], ['HTTP 503', 2], ['timeout', 2]]) } : {}) }),
      ...(failed ? { input: 0, output: 0, total: 0, cached: 0, cacheWrite: 0, reasoning: 0 }
        : { input, output: output + reasoning, total: input + output + reasoning, cached, cacheWrite: profile.model === 'claude-sonnet-4.5' ? Math.round(input * 0.08) : 0, reasoning }) };
    rows.push(row);
  }
  return rows;
}

export async function writeDemoLedger(directory, options) {
  await mkdir(directory, { recursive: true });
  const files = new Map();
  for (const row of demoRows(options)) {
    const day = row.at.slice(0, 10);
    files.set(day, (files.get(day) ?? '') + JSON.stringify(row) + '\n');
  }
  for (const [day, text] of files) await writeFile(join(directory, `${day}.jsonl`), text);
  return files.size;
}

export const DEMO_NAMES = {
  agents: new Map(DEMO_AGENTS.map(item => [item.id, item.name])),
  profiles: new Map(DEMO_PROFILES.map(item => [item.id, item.name])),
  providers: new Map(DEMO_PROVIDERS.map(item => [item.id, item.name])),
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const count = await writeDemoLedger(process.argv[2], { days: Number(process.argv[3] ?? 45) });
  console.log(`${count} files`);
}
