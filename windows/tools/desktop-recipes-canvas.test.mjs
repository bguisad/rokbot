// Canvases in the desktop and web renderer (desktop-recipes/extensions/canvas.js): the link
// classifier and link component hand RokBot in-app canvas links to the canvas card, the Bot
// details get a canvas section, and the stage host is mounted once. The extension's pure helpers
// run here in isolation; the full UI is exercised in the web client (same renderer).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { specForTarget, TARGETS } from './desktop-recipes/spec.mjs';

const source = readFileSync(new URL('./desktop-recipes/extensions/canvas.js', import.meta.url), 'utf8');
const ID = '044e3b41-0828-4466-9f6d-325569f828c6';

function helpers() {
  // No document: the link handler does not install; React parts are never called.
  return new Function('grokText', `${source}\nreturn { rokCanvasLinkId, rokCanvasTime, rokCanvasFullTime, rokCanvasVisibilityLabel };`)((zh) => zh);
}

test('in-app canvas links are recognised on any Host; public, foreign and frame links are not', () => {
  const { rokCanvasLinkId } = helpers();
  assert.equal(rokCanvasLinkId(`http://127.0.0.1:8000/canvas/app/${ID}`), ID);
  assert.equal(rokCanvasLinkId(`https://bot.example/canvas/app/${ID.toUpperCase()}/?x=1`), ID);
  assert.equal(rokCanvasLinkId(`/canvas/app/${ID}`), ID, 'relative links resolve against the page');
  for (const href of [`https://bot.example/canvas/${'a'.repeat(43)}`, `https://bot.example/canvas/app/${ID}/frame`,
    `https://u:p@bot.example/canvas/app/${ID}`, `javascript:alert(1)//canvas/app/${ID}`, `https://cursor.com/canvas/store-1/${ID}`, '', null])
    assert.equal(rokCanvasLinkId(href), null, String(href));
});

test('update times are shown in Beijing time', () => {
  const { rokCanvasTime, rokCanvasFullTime, rokCanvasVisibilityLabel } = helpers();
  const now = Date.parse('2026-11-27T06:00:00Z'); // 14:00 in Beijing
  assert.equal(rokCanvasTime(Date.parse('2026-11-27T05:05:00Z'), now), '今天 13:05');
  assert.equal(rokCanvasTime(Date.parse('2026-11-26T17:30:00Z'), now), '今天 01:30', 'after midnight in Beijing is today');
  assert.equal(rokCanvasTime(Date.parse('2026-11-26T03:30:00Z'), now), '11月26日 11:30');
  assert.equal(rokCanvasTime(Date.parse('2025-03-02T03:30:00Z'), now), '2025年3月2日');
  assert.equal(rokCanvasFullTime(Date.parse('2026-11-26T03:30:00Z')), '2026年11月26日 11:30（北京时间）');
  assert.equal(rokCanvasVisibilityLabel('public'), '公开');
  assert.equal(rokCanvasVisibilityLabel(undefined), '私有');
});

test('the extension follows the official stage and share popover, in Chinese, without emoji or the upstream name', () => {
  for (const text of ['返回聊天', '刷新', '分享', '关闭', '分享“${canvas.title}”', '谁可以访问', '公开访问', '知道链接的任何人 · 无需登录',
    '仅你可见', '复制链接', '在浏览器中打开', '重新生成链接', '旧链接会立即失效', '删除“${canvas.title}”', '删除画布', '画布已删除', '打开', '分享…', '删除…',
    '这个 Bot 创建的画布会显示在这里。', "role: 'switch'", "'aria-checked'", 'Asia/Shanghai'])
    assert.ok(source.includes(text), text);
  const visible = source.replace(/grokText/g, '').replace(/rokCanvasText\('([^']*)', '([^']*)'\)/g, '$1 $2');
  assert.ok(!/grok/i.test(visible), 'no upstream product name');
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(source), 'no emoji');
  assert.ok(!/<input[^>]*checkbox|type: 'checkbox'/.test(source), 'the public access switch is a drawn control');
  assert.match(source, /sandbox: 'allow-scripts allow-modals allow-downloads'/);
  assert.ok(!/allow-same-origin/.test(source), 'canvas frames never share an origin with the app');
});

test('every desktop target wires the canvas card, the stage host, the Bot details section and the extension', () => {
  for (const target of Object.keys(TARGETS)) {
    const app = specForTarget(target).find(entry => entry.path.endsWith(TARGETS[target].chunks.eagerApp));
    const edits = JSON.stringify(app.edits);
    assert.ok(edits.includes('(0,Z.jsx)(RokCanvasStageHost,{})'), target);
    assert.ok(edits.includes('if(rokCanvasLinkId(e)!=null)return{kind:`external`};'), target);
    assert.ok(edits.includes('rokCanvasLinkId(e.href)!=null?(0,Z.jsx)(RokCanvasLinkCard,e):(0,Z.jsx)(CZ_orig,e)'), target);
    assert.ok(edits.includes('(0,Z.jsx)(RokBotCanvasSection,{agentId:n,headingId:`${y}-canvases`})'), target);
    assert.ok(app.edits.some(edit => edit.append === source), `${target} appends canvas.js`);
  }
});
