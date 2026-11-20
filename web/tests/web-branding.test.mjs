import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function walkFiles(dir, relativePrefix = '') {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.cache' || entry.name === 'output') continue;
    const rel = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(full, rel));
    else if (entry.isFile()) files.push({ rel, full });
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

const CATEGORY_A_RE = new RegExp([
  ['prok', 'bot'].join(''),
  ['ferret', 'geek'].join(''),
  ['ahaduo', 'duoduo'].join(''),
  'grokbot_admin',
  'grokbot_web',
  'grokbot_vnc',
  'x-grokbot',
  'GROKBOT_',
  'PROKBOT_',
  'grokbot-web',
  'grokbot-android',
  'grokbot-app',
  'grokbot-host',
  'grokbot-box',
  'GrokBotLocal',
  '__grokbot',
  'grokbotActivityTime',
  'grokbotWebview',
  'grokbotWeb',
  'grokText',
  'grokbot\\.notify',
  'grokbot-bot-profile',
  'grokbot-nav-back',
  'grokbot-phone',
  'grokbot-view-',
  'grokbot-swipe-',
  'grokbot-subpage-',
  'grokbot-computer-stage',
  'grokbot-marketplace-entry',
  'grokbot-sheet-in',
  'grokbot-compat-',
  '--grokbot-',
  'data-grokbot-',
].join('|'), 'i');

// Every remaining /grok/i occurrence in web/ must be an explicit Category-B upstream constant
// or an explicitly documented legacy read-compat fallback.
const ALLOWED_GROK_TOKENS = [
  // Category-B input / installer / official renderer strings
  { file: /^patchers\/patch\.mjs$/, re: /Grok_Bot_\$\{recommended\}_Setup\.exe|Grok Bot\.exe|Grok Bot \$\{version\}|Grok Bot Windows|Grok Bot/g },
  { file: /^patchers\/renderer-patches\.mjs$/, re: /"Get Grok Bot for mobile"|GrokLocalVersion|GrokOriginalUpdateSettings/g },
  { file: /^README(?:\.en)?\.md$/, re: /Grok_Bot_1\.2\.3_Setup\.exe/g },
  { file: /^tests\/web-patch\.test\.mjs$/, re: /https:\/\/grok\.com|<title>Grok Bot<\/title>|\['GROKBOT', 'ADMIN_PASSWORD'\]|GrokLocalVersion/g },

  // Category-B Electron preload / renderer / RPC / CSS identifiers
  { file: /^client\/bridge\.js$/, re: /grok_bot_box_harness_turns_blocked|Grok Bot Computer Use/g },
  { file: /^client\/services\.js$/, re: /proAndSuperGrokPlansGrantAccess|(?:list|upload|delete)GrokBot(?:AgentFiles|AgentFile|UserStoreFiles|UserStoreFile)|getGrokBotTermsRecord|markGrokBotTerms/g },
  { file: /^client\/(?:layout\.js|android\.css)$/, re: /sand-grok-bot-mark/g },

  // Documented legacy read-compat fallbacks
  { file: /^client\/native\.js$/, re: /grokbot\.clientDeviceId/g },
  { file: /^client\/bridge\.js$/, re: /grokbot-local:locale/g },
  { file: /^client\/services\.js$/, re: /grokbot-local:/g },
];

test('web/ contains zero unexempted Category-A branding leftovers', async () => {
  const files = await walkFiles(webRoot);
  const violations = [];
  for (const { rel, full } of files) {
    if (rel === 'tests/web-branding.test.mjs') continue;
    const lines = (await readFile(full, 'utf8')).split(/\r?\n/);
    lines.forEach((line, idx) => {
      const match = CATEGORY_A_RE.exec(line);
      if (match) violations.push(`${rel}:${idx + 1}: matched ${match[0]} in ${line.trim()}`);
    });
  }
  assert.deepEqual(violations, []);
});

test('every remaining /grok/i occurrence in web/ is on the explicit Category-B or legacy-fallback allowlist', async () => {
  const files = await walkFiles(webRoot);
  const unexpected = [];
  for (const { rel, full } of files) {
    if (rel === 'tests/web-branding.test.mjs') continue;
    const lines = (await readFile(full, 'utf8')).split(/\r?\n/);
    const rules = ALLOWED_GROK_TOKENS.filter(rule => rule.file.test(rel));
    lines.forEach((line, idx) => {
      if (!/grok/i.test(line)) return;
      let masked = line;
      for (const rule of rules) {
        masked = masked.replace(rule.re, match => '_'.repeat(match.length));
      }
      if (/grok/i.test(masked)) {
        unexpected.push(`${rel}:${idx + 1}: unallowlisted grok token in ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(unexpected, []);
});
