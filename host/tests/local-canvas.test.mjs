import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compileCanvas } from '../server/canvas-compile.mjs';
import { CanvasLinkOrigins, CanvasStore, canvasView, resolveCanvasOrigin } from '../server/canvas-store.mjs';
import { CANVAS_FRAME_SANDBOX, routeCanvas } from '../server/canvas-http.mjs';
import { applyCanvasEdits, createLocalCanvasTools, LOCAL_CANVAS_TOOL_NAMES } from '../runtime/local-canvas-tools.mjs';
import { CANVAS_SDK_GUIDE } from '../server/canvas-sdk/guide.mjs';

export const SAMPLE_CANVAS = `import { Page, Stack, Row, Card, CardHeader, CardBody, Text, Stat, Button, BarChart, Table, useState } from "cursor/canvas";

const rows = [
  { region: "华东", orders: 1280 },
  { region: "华南", orders: 960 },
  { region: "华北", orders: 740 },
];

export default function SalesBoard() {
  const [count, setCount] = useState(0);
  return (
    <Page title="区域订单看板">
      <Stack gap={16}>
        <Row gap={12}>
          <Stat label="总订单" value="2,980" />
          <Stat label="点击次数" value={String(count)} />
        </Row>
        <Button onClick={() => setCount((n) => n + 1)}>加一</Button>
        <Card>
          <CardHeader>各区域订单</CardHeader>
          <CardBody>
            <BarChart categories={rows.map((r) => r.region)} series={[{ name: "订单", data: rows.map((r) => r.orders) }]} />
          </CardBody>
        </Card>
        <Table headers={["区域", "订单"]} rows={rows.map((r) => [r.region, String(r.orders)])} />
        <Text tone="secondary">数据来源：示例数据</Text>
      </Stack>
    </Page>
  );
}
`;

const fakeProtoLibrary = () => {
  const proto = (typeName) => class { constructor(init = {}) { Object.assign(this, init); this.typeName = typeName; } };
  const tf = Object.fromEntries(['ToolCall', 'McpToolCall', 'McpArgs', 'McpToolResult', 'McpSuccess',
    'McpToolResultContentItem', 'McpTextContent'].map((n) => [n, proto(n)]));
  return { getToolFrameworkRecoveryBindings: () => tf };
};

async function runTool(tools, name, args) {
  const tool = tools.find((item) => item.name === name);
  assert.ok(tool, `missing tool ${name}`);
  const merged = [];
  const handler = {
    executeToolCall: async (_ctx, pending, callId, promiseFn, mergeFn) => {
      assert.equal(pending.tool.case, 'mcpToolCall');
      assert.equal(pending.tool.value.args.toolCallId, callId);
      const result = await promiseFn({});
      merged.push(mergeFn(result));
      return result;
    },
  };
  const out = await tool.execute({}, handler, (async function* () { yield JSON.stringify(args); })(), { toolCallId: `call-${name}` });
  // McpToolResult -> McpSuccess -> McpToolResultContentItem -> McpTextContent
  assert.equal(out.typeName, 'McpToolResult');
  assert.equal(out.result.case, 'success');
  assert.equal(out.result.value.typeName, 'McpSuccess');
  const text = out.result.value.content.map((item) => {
    assert.equal(item.typeName, 'McpToolResultContentItem');
    assert.equal(item.content.case, 'text');
    assert.equal(item.content.value.typeName, 'McpTextContent');
    return item.content.value.text;
  }).join('\n');
  assert.equal(merged[0].tool.value.result, out);
  assert.equal((await tool.render({}, out)).content[0].text, text);
  return text;
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${server.address().port}`)));
}

test('compileCanvas bundles a cursor/canvas TSX module offline and reports errors with positions', async () => {
  const ok = await compileCanvas(SAMPLE_CANVAS);
  assert.equal(ok.ok, true, ok.detail);
  assert.ok(ok.code.length > 1000);
  assert.ok(!/\brequire\(["']react/.test(ok.code), 'React must be bundled, not required');
  assert.ok(!/\bimport\s*\(|\bfrom\s*["']https?:/.test(ok.code), 'no runtime imports');

  const missingDefault = await compileCanvas('export const X = 1;');
  assert.equal(missingDefault.ok, false);
  assert.match(missingDefault.detail, /export default/);

  const network = await compileCanvas('import x from "lodash";\nexport default function A() { return x; }');
  assert.equal(network.ok, false);
  assert.match(network.detail, /Cannot import "lodash"/);

  const relative = await compileCanvas('import x from "./helper";\nexport default function A() { return x; }');
  assert.equal(relative.ok, false);
  assert.match(relative.detail, /Cannot import "\.\/helper"/);

  const syntax = await compileCanvas('export default function A() {\n  return <div>;\n}\n');
  assert.equal(syntax.ok, false);
  assert.ok([1, 2].includes(syntax.diagnostics[0].range.start.line), 'diagnostic points at the broken JSX');
  assert.match(syntax.detail, /^\d+:\d+ /);
});

test('CanvasStore creates, updates in place, keeps the token and never stores a broken revision', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new CanvasStore(dir, { compile: compileCanvas });
  const created = await store.write({ agentId: 'bot-a', title: '  测试\n画布 ', source: SAMPLE_CANVAS });
  assert.equal(created.ok, true);
  assert.equal(created.created, true);
  assert.equal(created.meta.title, '测试 画布');
  assert.match(created.meta.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(created.meta.version, 1);
  assert.equal(created.meta.visibility, 'private', 'a new canvas is private');
  assert.equal(await store.byToken(created.meta.token), null, 'a private canvas has no public link');
  assert.deepEqual(await store.byAnyToken(created.meta.token), created.meta);

  const updated = await store.write({ agentId: 'bot-a', canvasId: created.meta.id, source: SAMPLE_CANVAS.replace('区域订单看板', '订单看板 v2') });
  assert.equal(updated.ok, true);
  assert.equal(updated.created, false);
  assert.equal(updated.meta.id, created.meta.id);
  assert.equal(updated.meta.token, created.meta.token);
  assert.equal(updated.meta.title, '测试 画布');
  assert.equal(updated.meta.version, 2);
  assert.equal(updated.meta.visibility, 'private');
  assert.match(await store.readSource(created.meta.id), /订单看板 v2/);

  // Publish, unpublish, publish again (same link), then a new link (the old one is gone for good).
  const published = await store.setVisibility(created.meta.id, 'public');
  assert.equal(published.visibility, 'public');
  assert.ok(published.publishedAtMs > 0);
  assert.equal((await store.byToken(created.meta.token))?.id, created.meta.id);
  const kept = await store.write({ agentId: 'bot-a', canvasId: created.meta.id, source: SAMPLE_CANVAS.replace('区域订单看板', '订单看板 v2') });
  assert.equal(kept.meta.visibility, 'public', 'an update keeps the visibility');
  assert.equal((await store.setVisibility(created.meta.id, 'private')).visibility, 'private');
  assert.equal(await store.byToken(created.meta.token), null);
  await store.setVisibility(created.meta.id, 'public');
  assert.equal((await store.byToken(created.meta.token))?.id, created.meta.id);
  const rotated = await store.regenerateToken(created.meta.id);
  assert.notEqual(rotated.token, created.meta.token);
  assert.equal(await store.byToken(created.meta.token), null);
  assert.equal(await store.byAnyToken(created.meta.token), null);
  assert.equal((await store.byToken(rotated.token))?.id, created.meta.id);
  await assert.rejects(store.setVisibility(created.meta.id, 'team'), /Invalid canvas visibility/);
  assert.equal(await store.setVisibility('00000000-0000-4000-8000-000000000000', 'public'), null);
  await store.setVisibility(created.meta.id, 'private');
  const view = canvasView(await store.readMeta(created.meta.id), 'https://h.example/');
  assert.equal(view.publicUrl, null);
  assert.equal(view.appUrl, `https://h.example/canvas/app/${created.meta.id}`);
  assert.ok(!JSON.stringify(view).includes(rotated.token), 'a private canvas view never carries its token');

  const broken = await store.write({ agentId: 'bot-a', canvasId: created.meta.id, source: 'export default function A() { return <div>; }' });
  assert.equal(broken.ok, false);
  assert.equal(broken.reason, 'compile_failed');
  assert.match(await store.readSource(created.meta.id), /订单看板 v2/);
  assert.equal((await store.readMeta(created.meta.id)).version, 3);

  const foreign = await store.write({ agentId: 'bot-b', canvasId: created.meta.id, source: SAMPLE_CANVAS });
  assert.equal(foreign.reason, 'not_found');
  assert.equal((await store.write({ agentId: 'bot-a', source: 'x'.repeat(600 * 1024) })).reason, 'too_large');

  // Concurrent creates never lose a token.
  const many = await Promise.all([1, 2, 3, 4].map((n) => store.write({ agentId: 'bot-a', title: `并发 ${n}`, source: SAMPLE_CANVAS })));
  for (const result of many) assert.ok(await store.byAnyToken(result.meta.token));
  assert.equal((await store.list({ agentId: 'bot-a' })).length, 5);
  assert.equal(await store.byToken('A'.repeat(43)), null);
  assert.equal(await store.byToken('../../etc/passwd'), null);
});

test('canvas link origin: configured public URL, then the client address last seen, then loopback', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-origin-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(await resolveCanvasOrigin(dir, {}), 'http://127.0.0.1:8000');
  const origins = new CanvasLinkOrigins(dir);
  origins.observe('http://192.168.1.20:8000', false);
  origins.observe('javascript:alert(1)', false);
  await origins.pending;
  assert.equal(await resolveCanvasOrigin(dir, {}), 'http://192.168.1.20:8000');
  assert.equal(await resolveCanvasOrigin(dir, { ROKBOT_PUBLIC_URL: 'https://bot.example/x' }), 'https://bot.example');
});

test('local canvas tools: registration, create, update, edit, read and list through McpToolResult text', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-tools-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ROKBOT_PUBLIC_URL: 'https://rokbot.example' };
  const { tools } = createLocalCanvasTools({ library: fakeProtoLibrary(), dataDir: dir, agentId: 'bot-a', env });
  assert.deepEqual(tools.map((tool) => tool.name), LOCAL_CANVAS_TOOL_NAMES);
  const write = tools.find((tool) => tool.name === 'WriteCanvas');
  assert.deepEqual(write.parameters.jsonSchema.required, ['contents']);
  assert.deepEqual(Object.keys(write.parameters.jsonSchema.properties), ['contents', 'canvas_id', 'title']);
  const description = write.descriptionGenerator();
  assert.ok(description.includes('cursor/canvas'));
  assert.ok(description.includes(CANVAS_SDK_GUIDE.slice(0, 40)));
  for (const tool of tools) {
    assert.ok(!/grok/i.test(tool.descriptionGenerator()), `${tool.name} description must not name the upstream product`);
  }

  const saved = await runTool(tools, 'WriteCanvas', { title: '订单看板', contents: SAMPLE_CANVAS });
  assert.match(saved, /^Canvas saved: "订单看板"\./);
  const canvasId = /canvas_id: ([0-9a-f-]{36})/.exec(saved)[1];
  const url = /URL: (\S+)/.exec(saved)[1];
  assert.equal(url, `https://rokbot.example/canvas/app/${canvasId}`, 'the model gets the in-app link, not a public one');
  assert.ok(saved.includes(`[订单看板](${url})`));
  assert.match(saved, /visibility: private/);
  assert.match(saved, /The canvas is private/);

  const rewritten = await runTool(tools, 'WriteCanvas', { canvas_id: canvasId, contents: SAMPLE_CANVAS.replace('加一', '再来一次') });
  assert.match(rewritten, /Canvas updated: "订单看板"/);
  assert.ok(rewritten.includes(`URL: ${url}`), 'an update keeps the same link');
  assert.match(rewritten, /version: 2/);

  const aliasSource = await runTool(tools, 'WriteCanvas', { title: '别名', source: SAMPLE_CANVAS });
  assert.match(aliasSource, /Canvas saved: "别名"/);

  const edited = await runTool(tools, 'EditCanvas', { canvas_id: canvasId, old_string: '再来一次', new_string: '点我' });
  assert.match(edited, /version: 3/);
  const multi = await runTool(tools, 'EditCanvas', { canvas_id: canvasId, edits: [{ old_string: '华东', new_string: '东部', replace_all: true }, { old_string: '点我', new_string: '点一下' }] });
  assert.match(multi, /version: 4/);
  const noMatch = await runTool(tools, 'EditCanvas', { canvas_id: canvasId, old_string: '不存在的文字', new_string: 'x' });
  assert.match(noMatch, /Canvas was not saved: a replacement did not match/);
  const badEdit = await runTool(tools, 'EditCanvas', { canvas_id: canvasId, old_string: 'return (', new_string: 'return (<' });
  assert.match(badEdit, /did not compile/);
  assert.match(badEdit, /No url was produced/);
  assert.match(badEdit, / > +\d+ \| /, 'compile errors quote the offending line');

  const read = await runTool(tools, 'ReadCanvas', { url });
  assert.ok(read.includes('点一下') && read.includes('东部'));
  assert.ok(read.startsWith(`Canvas "订单看板" (${url}):`));
  assert.equal(await runTool(tools, 'ReadCanvas', { canvas_id: canvasId }), read);
  assert.match(await runTool(tools, 'ReadCanvas', {}), /Provide a canvas_id/);

  const listed = await runTool(tools, 'ListCanvases', { query: '订单' });
  assert.ok(listed.includes(canvasId) && listed.includes(url));
  assert.ok(listed.includes('visibility: private') && !listed.includes('public_url'));
  assert.ok(!listed.includes('别名'));

  // Once the user publishes it, the model sees the public link too, and can read by it.
  const store = new CanvasStore(dir, { compile: compileCanvas });
  const shared = await store.setVisibility(canvasId, 'public');
  const listedPublic = await runTool(tools, 'ListCanvases', { query: '订单' });
  assert.ok(listedPublic.includes(`public_url: https://rokbot.example/canvas/${shared.token}`));
  assert.equal(await runTool(tools, 'ReadCanvas', { url: `https://rokbot.example/canvas/${shared.token}` }), read);

  // Another bot can neither list nor edit this bot's canvases.
  const other = createLocalCanvasTools({ library: fakeProtoLibrary(), dataDir: dir, agentId: 'bot-b', env }).tools;
  assert.equal(await runTool(other, 'ListCanvases', {}), 'No canvases match.');
  assert.match(await runTool(other, 'EditCanvas', { canvas_id: canvasId, old_string: '点一下', new_string: 'x' }), /no canvas with that id/);

  assert.deepEqual(applyCanvasEdits('a b a', [{ old_string: 'a', new_string: 'c' }]).ok, false);
  assert.equal(applyCanvasEdits('a b a', [{ old_string: 'a', new_string: '$&$&', replace_all: true }]).source, '$&$& b $&$&');
});

test('canvas HTTP route: token access, 404s, sandbox and CSP headers', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new CanvasStore(dir, { compile: compileCanvas });
  const { meta } = await store.write({ agentId: 'bot-a', title: '<b>标题</b>', source: SAMPLE_CANVAS.replace('数据来源：示例数据', '{"</script><script>alert(1)</script>"}') });
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const authorize = () => request.headers.authorization === 'Bearer good';
    if (!(await routeCanvas(request, response, url.pathname, url, { store, authorize }))) { response.writeHead(418); response.end(); }
  });
  const base = await listen(server);
  t.after(() => new Promise((done) => server.close(done)));

  // Private (the default): the public link and the in-app link without a credential are the same 404.
  const privatePage = await fetch(`${base}/canvas/${meta.token}`);
  assert.equal(privatePage.status, 404);
  const notFoundHtml = await privatePage.text();
  assert.match(notFoundHtml, /画布不存在或未公开/);
  assert.ok(!notFoundHtml.includes('标题'), 'a 404 never reveals the canvas');
  assert.equal((await fetch(`${base}/canvas/${meta.token}/frame`)).status, 404);
  assert.equal((await fetch(`${base}/canvas/app/${meta.id}`)).status, 404);
  assert.equal((await fetch(`${base}/canvas/app/${meta.id}/frame`, { headers: { authorization: 'Bearer bad' } })).status, 404);
  assert.equal(await (await fetch(`${base}/canvas/app/${meta.id}`)).text(), notFoundHtml, 'unknown, private and unauthorized look alike');
  // Signed in: the in-app link opens the private canvas.
  const appPage = await fetch(`${base}/canvas/app/${meta.id}?theme=dark`, { headers: { authorization: 'Bearer good' } });
  assert.equal(appPage.status, 200);
  const appHtml = await appPage.text();
  assert.ok(appHtml.includes(`/canvas/app/${meta.id}/frame?theme=dark`) && appHtml.includes('私有'));
  assert.ok(!appHtml.includes(meta.token), 'the in-app page never carries the public token');
  const appFrame = await fetch(`${base}/canvas/app/${meta.id}/frame`, { headers: { authorization: 'Bearer good' } });
  assert.equal(appFrame.status, 200);
  assert.match(appFrame.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.equal((await fetch(`${base}/canvas/app/00000000-0000-4000-8000-000000000000`, { headers: { authorization: 'Bearer good' } })).status, 404);

  await store.setVisibility(meta.id, 'public');
  const page = await fetch(`${base}/canvas/${meta.token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const pageCsp = page.headers.get('content-security-policy');
  assert.match(pageCsp, /default-src 'none'/);
  assert.match(pageCsp, /connect-src 'none'/);
  assert.match(pageCsp, /script-src 'nonce-[^']+'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  const html = await page.text();
  assert.ok(html.includes(`sandbox="${CANVAS_FRAME_SANDBOX}"`));
  assert.ok(!CANVAS_FRAME_SANDBOX.includes('allow-same-origin'), 'the canvas frame must never share the Host origin');
  assert.ok(!/allow-top-navigation|allow-popups-to-escape|allow-forms/.test(CANVAS_FRAME_SANDBOX));
  assert.ok(html.includes('&lt;b&gt;标题&lt;/b&gt;') && !html.includes('<b>标题</b>'), 'title is escaped');
  assert.ok(html.includes('lang="zh-CN"') && html.includes('刷新') && html.includes('RokBot 画布'));
  assert.ok(html.includes('data-theme') || html.includes('dataset.theme'));
  assert.ok(html.includes('[data-theme="dark"]'), 'dark theme tokens are present');
  assert.ok(!/grok/i.test(html));

  const frame = await fetch(`${base}/canvas/${meta.token}/frame?theme=dark`);
  assert.equal(frame.status, 200);
  const frameCsp = frame.headers.get('content-security-policy');
  assert.match(frameCsp, /^sandbox allow-scripts/);
  assert.ok(!frameCsp.includes('allow-same-origin'));
  assert.match(frameCsp, /connect-src 'none'/);
  assert.match(frameCsp, /form-action 'none'/);
  assert.match(frameCsp, /frame-ancestors 'self'/);
  assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
  const frameHtml = await frame.text();
  const nonce = /script-src 'nonce-([^']+)'/.exec(frameCsp)[1];
  assert.ok(frameHtml.includes(`<script nonce="${nonce}">`));
  assert.ok(!frameHtml.includes('</script><script>alert(1)'), 'source text cannot close the inline script');

  const head = await fetch(`${base}/canvas/${meta.token}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  for (const path of [`/canvas/${'A'.repeat(43)}`, '/canvas/short', `/canvas/${meta.token}/source.canvas.tsx`, '/canvas/', `/canvas/${meta.token}/../tokens.json`]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('content-security-policy'), /^default-src 'none'/);
  }
  assert.equal((await fetch(`${base}/canvas/${meta.token}`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/other`)).status, 418);
  // Unpublished: the public link is 404 again at once.
  await store.setVisibility(meta.id, 'private');
  assert.equal((await fetch(`${base}/canvas/${meta.token}`)).status, 404);
  assert.equal((await fetch(`${base}/canvas/${meta.token}/frame`)).status, 404);
});

test('selfhost service: private by default, signed-in devices only, public while shared, API needs a device', async (t) => {
  const { createSelfHostServer } = await import('../server/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'rok0c0canvas-service-'));
  const core = http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('null'); });
  const coreUrl = await listen(core);
  const host = await createSelfHostServer({ dataDir: dir, hostUrl: coreUrl, vncUrl: coreUrl, forkVncUrl: coreUrl, internalToken: 'a'.repeat(40) });
  await host.start(0, '127.0.0.1', 0);
  t.after(async () => { await host.close(); await new Promise((done) => core.close(done)); await rm(dir, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${host.server.address().port}`, webOrigin = `http://127.0.0.1:${host.webServer.address().port}`;
  await host.auth.setup(host.auth.setupKey, 'demo-admin-password');
  // An app device (bearer on the main listener) and a web client session (cookie on the web listener).
  const app = await host.auth.pair({ pairingKey: (await host.auth.createPairing()).pairingKey, deviceName: 'Demo Mac', platform: 'desktop' });
  const browser = await host.auth.pair({ pairingKey: (await host.auth.createPairing()).pairingKey, deviceName: 'Web client · Demo' }, { web: true });
  // The web listener accepts its cookie only while a web client bundle is installed and enabled;
  // no renderer is needed for canvas routes, so the test stands in for an installed bundle.
  Object.defineProperty(host.webClient, 'available', { get: () => true });
  const bearer = { authorization: `Bearer ${app.token}` };
  const cookie = { cookie: `rokbot_web=${browser.token}` };
  const webApi = { ...cookie, 'x-rokbot-web': '1' };

  const store = new CanvasStore(dir, { compile: compileCanvas });
  const { meta } = await store.write({ agentId: 'a0a0-0001', title: '服务测试', source: SAMPLE_CANVAS });
  await store.write({ agentId: 'b0b0-0002', title: '别的 Bot', source: SAMPLE_CANVAS });
  const status = async (url, headers = {}, init = {}) => (await fetch(url, { headers, redirect: 'manual', ...init })).status;

  // 1. Private, not signed in: every link is 404, on both listeners.
  for (const base of [origin, webOrigin]) {
    assert.equal(await status(`${base}/canvas/${meta.token}`), 404, `${base} public link of a private canvas`);
    assert.equal(await status(`${base}/canvas/${meta.token}/frame`), 404);
    assert.equal(await status(`${base}/canvas/app/${meta.id}`), 404, `${base} in-app link without a credential`);
    assert.equal(await status(`${base}/canvas/app/${meta.id}/frame`), 404);
  }
  // 2. Signed in: the app's bearer on the main listener, the browser's cookie on the web listener.
  assert.equal(await status(`${origin}/canvas/app/${meta.id}/frame`, bearer), 200);
  assert.equal(await status(`${origin}/canvas/app/${meta.id}`, bearer), 200);
  assert.equal(await status(`${webOrigin}/canvas/app/${meta.id}/frame`, cookie), 200);
  const webPage = await fetch(`${webOrigin}/canvas/app/${meta.id}`, { headers: cookie });
  assert.equal(webPage.status, 200);
  assert.ok((await webPage.text()).includes('服务测试'));
  // Credentials stay on their own listener, and a wrong or revoked one is the same 404.
  assert.equal(await status(`${webOrigin}/canvas/app/${meta.id}/frame`, bearer), 404, 'apps use the main listener');
  assert.equal(await status(`${origin}/canvas/app/${meta.id}/frame`, cookie), 404, 'the main listener ignores the web cookie');
  assert.equal(await status(`${origin}/canvas/app/${meta.id}/frame`, { authorization: `Bearer ${'x'.repeat(43)}` }), 404);
  assert.equal(await status(`${origin}/canvas/${meta.token}`, bearer), 404, 'signing in does not open a private public link');

  // 3. The API: a device is required; list per Bot; no token while private.
  assert.equal(await status(`${origin}/local/canvases?agentId=a0a0-0001`), 401);
  assert.equal(await status(`${origin}/local/canvases/${meta.id}`), 401);
  assert.equal(await status(`${origin}/local/canvases/${meta.id}/visibility`, { 'content-type': 'application/json' }, { method: 'POST', body: '{"visibility":"public"}' }), 401);
  assert.equal(await status(`${origin}/local/canvases/${meta.id}`, {}, { method: 'DELETE' }), 401);
  assert.equal(await status(`${webOrigin}/local/canvases?agentId=a0a0-0001`, cookie), 403, 'the web API wants its header');
  assert.equal(await status(`${origin}/local/canvases?agentId=../x`, bearer), 400);
  const listedResponse = await fetch(`${origin}/local/canvases?agentId=a0a0-0001`, { headers: bearer });
  const listed = await listedResponse.json();
  assert.equal(listedResponse.status, 200, JSON.stringify(listed));
  assert.deepEqual(listed.canvases.map((item) => item.title), ['服务测试']);
  const [item] = listed.canvases;
  assert.equal(item.visibility, 'private');
  assert.equal(item.publicUrl, null);
  assert.equal(item.appUrl, `${origin}/canvas/app/${meta.id}`);
  assert.ok(!JSON.stringify(listed).includes(meta.token));
  const webListed = await (await fetch(`${webOrigin}/local/canvases?agentId=a0a0-0001`, { headers: webApi })).json();
  assert.equal(webListed.canvases[0].appUrl, `${webOrigin}/canvas/app/${meta.id}`, 'in-app links use the caller\'s own origin');
  assert.equal((await (await fetch(`${origin}/local/canvases?agentId=0c0c`, { headers: bearer })).json()).canvases.length, 0);
  assert.equal(await status(`${origin}/local/canvases/00000000-0000-4000-8000-000000000000`, bearer), 404);

  // 4. Shared: anyone with the link, on both listeners; the in-app link still needs a device.
  const post = (path, body, headers = bearer, base = origin) => fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post(`/local/canvases/${meta.id}/visibility`, { visibility: 'team' })).status, 400);
  const shared = (await (await post(`/local/canvases/${meta.id}/visibility`, { visibility: 'public' })).json()).canvas;
  assert.equal(shared.visibility, 'public');
  assert.equal(shared.publicUrl, `${origin}/canvas/${meta.token}`);
  for (const base of [origin, webOrigin]) {
    assert.equal(await status(`${base}/canvas/${meta.token}`), 200, `${base} public link while shared`);
    assert.equal(await status(`${base}/canvas/${meta.token}/frame`), 200);
    assert.equal(await status(`${base}/canvas/app/${meta.id}`), 404, 'the in-app link is never public');
  }
  // 5. Unshared: the public link is 404 at once; the in-app link keeps working for devices.
  const unshared = (await (await post(`/local/canvases/${meta.id}/visibility`, { visibility: 'private' }, webApi, webOrigin)).json()).canvas;
  assert.equal(unshared.visibility, 'private');
  assert.equal(await status(`${origin}/canvas/${meta.token}`), 404);
  assert.equal(await status(`${webOrigin}/canvas/${meta.token}/frame`), 404);
  assert.equal(await status(`${origin}/canvas/app/${meta.id}/frame`, bearer), 200);
  // 6. A new link: the old public link never comes back, even when shared again.
  await post(`/local/canvases/${meta.id}/visibility`, { visibility: 'public' });
  const rotated = (await (await post(`/local/canvases/${meta.id}/link`, {})).json()).canvas;
  assert.notEqual(rotated.publicUrl, shared.publicUrl);
  assert.equal(await status(shared.publicUrl), 404);
  assert.equal(await status(rotated.publicUrl), 200);
  // Forged tokens and ids, path tricks and other methods are 404.
  for (const path of [`/canvas/${'b'.repeat(43)}`, `/canvas/${meta.token.slice(0, 42)}A`, '/canvas/app/not-a-canvas', `/canvas/app/${meta.id}/source.canvas.tsx`, '/canvases/tokens.json', '/canvas/tokens.json'])
    assert.equal(await status(`${origin}${path}`, bearer), 404, path);
  assert.equal(await status(rotated.publicUrl, {}, { method: 'POST' }), 404);
  // 7. Delete: gone for the API, the in-app link and the public link.
  assert.equal((await fetch(`${origin}/local/canvases/${meta.id}`, { method: 'DELETE', headers: bearer })).status, 200);
  assert.equal(await status(rotated.publicUrl), 404);
  assert.equal(await status(`${origin}/canvas/app/${meta.id}/frame`, bearer), 404);
  assert.equal(await status(`${origin}/local/canvases/${meta.id}`, bearer), 404);
  assert.deepEqual((await (await fetch(`${origin}/local/canvases?agentId=a0a0-0001`, { headers: bearer })).json()).canvases, []);
});

test('canvases written before visibility existed are private after the upgrade', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-canvas-legacy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new CanvasStore(dir, { compile: compileCanvas });
  const { meta } = await store.write({ agentId: 'bot-a', title: '旧画布', source: SAMPLE_CANVAS });
  // The previous release wrote meta.json without `visibility`; its links were public.
  const legacy = { ...meta };
  delete legacy.visibility;
  await writeFile(join(dir, 'canvases', meta.id, 'meta.json'), JSON.stringify(legacy));
  assert.equal(await store.byToken(meta.token), null, 'an old public link is 404 until the user shares the canvas again');
  assert.equal(canvasView(await store.readMeta(meta.id), 'http://h').visibility, 'private');
  const shared = await store.setVisibility(meta.id, 'public');
  assert.equal(shared.token, meta.token, 'sharing it again revives the same link');
  assert.equal((await store.byToken(meta.token))?.id, meta.id);
});

const configuredSeed = process.env.ROKBOT_TEST_HOST_SEED;
const configuredArchive = process.env.ROKBOT_TEST_HOST_ARCHIVE;
if (configuredSeed || configuredArchive) {
  test('real 2bb5e41 host offers the local canvas tools and the model can create and update a canvas', async (t) => {
    const { runHostCanvasScenario } = await import('./local-canvas-host-fixture.mjs');
    const result = await runHostCanvasScenario(t, { seed: configuredSeed, archive: configuredArchive, source: SAMPLE_CANVAS });
    for (const name of LOCAL_CANVAS_TOOL_NAMES) assert.ok(result.offered.includes(name), `expected ${name} to be offered; got ${result.offered.join(', ')}`);
    assert.match(result.writeResult, /Canvas saved: "E2E 画布"/);
    assert.match(result.editResult, /version: 2/);
    assert.equal(result.canvases.length, 1);
    assert.match(result.source, /E2E 已更新/);
    assert.match(await readFile(join(result.canvasDir, 'bundle.js'), 'utf8'), /E2E 已更新/);
  });
}


