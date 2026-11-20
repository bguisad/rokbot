import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const tier = 1;
export const name = 'tier1-runner-integrity-privacy';

function spawnAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const { timeout, encoding = 'utf8', ...spawnOpts } = opts;
    const child = spawn(cmd, args, {
      ...spawnOpts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const outChunks = [];
    const errChunks = [];
    let timedOut = false;
    let settled = false;
    let timer = null;
    let killTimer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const stdoutBuf = Buffer.concat(outChunks);
      const stderrBuf = Buffer.concat(errChunks);
      resolve({
        status: result.status ?? null,
        signal: result.signal ?? null,
        stdout: encoding ? stdoutBuf.toString(encoding) : stdoutBuf,
        stderr: encoding ? stderrBuf.toString(encoding) : stderrBuf,
        error: result.error ?? null,
      });
    };

    child.stdout?.on('data', (chunk) => outChunks.push(chunk));
    child.stderr?.on('data', (chunk) => errChunks.push(chunk));
    child.on('error', (err) => finish({ status: null, signal: null, error: err }));
    child.on('close', (code, signal) => {
      const err = timedOut ? new Error(`Process timed out after ${timeout}ms`) : null;
      finish({ status: code, signal, error: err });
    });

    if (typeof timeout === 'number' && timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch {}
        killTimer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch {}
        }, 1000);
        killTimer.unref?.();
      }, timeout);
      timer.unref?.();
    }
  });
}

const LIVE_CACHE_SYM = Symbol.for('rokbot.e2e.s2.liveCache');

function getLiveCache(ctx) {
  if (ctx.harness) return null;
  let wm = globalThis[LIVE_CACHE_SYM];
  if (!wm) {
    wm = new WeakMap();
    globalThis[LIVE_CACHE_SYM] = wm;
  }
  let entry = wm.get(ctx);
  if (!entry) {
    entry = { adminCookie: null, deviceToken: ctx.deviceToken || null, deviceId: null, webCookie: null };
    wm.set(ctx, entry);
  }
  return entry;
}

async function ensureAdminSession(ctx, client) {
  const cache = getLiveCache(ctx);
  if (cache?.adminCookie) {
    client.cookies.set('rokbot_admin', cache.adminCookie);
    return { status: 200, ok: true, cached: true };
  }
  const login = await client.adminLogin(ctx.adminPassword);
  ctx.assert.assertStatus(login, 200);
  if (cache) {
    const cookieVal = client.cookies.get('rokbot_admin');
    if (cookieVal) cache.adminCookie = cookieVal;
  }
  return login;
}

function createClient(ctx, opts = {}) {
  const client = ctx.createClient(
    ctx.harness && opts.deviceToken === undefined ? { deviceToken: null, ...opts } : opts,
  );
  if (ctx.harness && opts.deviceToken === undefined) {
    client.setBearerToken(null, null);
  }
  return client;
}

async function resetHarnessState(ctx) {
  if (!ctx.harness) return;
  await ctx.harness.resetState();
  ctx.harness.setModelAuthPolicy({
    allowEnv: true,
    allowDeviceModelConfig: true,
    allowGuestModelConfig: false,
  });
}

async function ensureDeviceSession(ctx, client, pairOpts = {}) {
  if (!ctx.harness && ctx.deviceToken && !pairOpts.forceNew) {
    client.setBearerToken(ctx.deviceToken);
    return { token: ctx.deviceToken, deviceId: null, cached: true };
  }
  if (ctx.harness) {
    client.setBearerToken(null, null);
  }
  const cache = getLiveCache(ctx);
  if (cache?.deviceToken) {
    client.setBearerToken(cache.deviceToken, cache.deviceId);
    return { token: cache.deviceToken, deviceId: cache.deviceId, cached: true };
  }
  const body = !ctx.harness
    ? {
        password: ctx.adminPassword,
        deviceName: 'RokBot E2E Shared Live Device',
        platform: 'desktop',
        clientDeviceId: 'rokbot-e2e-shared-live-device',
      }
    : {
        password: ctx.adminPassword,
        deviceName: pairOpts.deviceName || 'RokBot E2E Shared Device',
        platform: pairOpts.platform || 'desktop',
        ...(pairOpts.clientKind !== undefined ? { clientKind: pairOpts.clientKind } : {}),
        ...(pairOpts.clientDeviceId !== undefined ? { clientDeviceId: pairOpts.clientDeviceId } : {}),
        ...(pairOpts.bundleId !== undefined ? { bundleId: pairOpts.bundleId } : {}),
      };
  const pairRes = await client.pairWithPassword(body);
  ctx.assert.assertStatus(pairRes, 201);
  if (cache) {
    cache.deviceToken = pairRes.json.token;
    cache.deviceId = pairRes.json.deviceId;
  }
  return pairRes.json;
}

function cleanRunnerEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:ROKBOT|GROKBOT|PROKBOT)_/.test(key)) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

async function invokeRunnerApi(repoRoot, fnSource, payload = {}) {
  const runnerUrl = pathToFileURL(path.join(repoRoot, 'tests', 'e2e', 'runner.mjs')).href;
  const script = [
    `import { discoverTierModules, parseArgs, runE2ESuite } from ${JSON.stringify(runnerUrl)};`,
    'const payload = JSON.parse(process.argv[1]);',
    `const result = await (${fnSource})(payload, { discoverTierModules, parseArgs, runE2ESuite });`,
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const res = await spawnAsync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(payload)], {
    env: cleanRunnerEnv(),
    encoding: 'utf8',
    timeout: 25000,
  });
  if (res.status !== 0) {
    throw new Error(`Runner API subprocess failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return JSON.parse(res.stdout);
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F12: Opaque-Box E2E Runner & Mode Contracts (T1-F12-01..05)
  // =========================================================================

  test('T1-F12-01', 'Runner CLI --help exits 0 and documents tier/mode/repo-check/json/filter/self-check', async () => {
    const runnerPath = path.join(ctx.repoRoot, 'tests', 'e2e', 'runner.mjs');
    const res = await spawnAsync('node', [runnerPath, '--help'], {
      env: cleanRunnerEnv(),
      encoding: 'utf8',
      timeout: 10000,
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    for (const flag of ['--tier', '--mode', '--repo-check', '--json', '--filter', '--self-check', 'ROKBOT_E2E_HOST_URL']) {
      ctx.assert.ok(res.stdout.includes(flag), `Help output missing ${flag}`);
    }
  });

  test('T1-F12-02', 'Runner CLI --self-check --json --mode harness exits 0 with valid rokbot-e2e-report/v1', async () => {
    const runnerPath = path.join(ctx.repoRoot, 'tests', 'e2e', 'runner.mjs');
    const res = await spawnAsync('node', [runnerPath, '--self-check', '--json', '--mode', 'harness'], {
      env: cleanRunnerEnv(),
      encoding: 'utf8',
      timeout: 30000,
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    const report = JSON.parse(res.stdout);
    ctx.assert.equal(report.schema, 'rokbot-e2e-report/v1');
    ctx.assert.equal(report.ok, true);
    ctx.assert.equal(report.selfCheck, true);
    ctx.assert.equal(report.mode, 'harness');
    ctx.assert.ok(report.summary.passed >= 4);
    ctx.assert.equal(report.summary.failed, 0);
    ctx.assert.equal(report.summary.skipped, 0);
  });

  test('T1-F12-03', 'discoverTierModules filters requested tiers and sorts deterministically', async (t) => {
    const tmp = await t.createTempDir('t1-f12-03-');
    await writeFile(path.join(tmp, 'tier3-c.test.mjs'), 'export const tier=3;\n', 'utf8');
    await writeFile(path.join(tmp, 'tier1-b.test.mjs'), 'export const tier=1;\n', 'utf8');
    await writeFile(path.join(tmp, 'tier1-a.test.mjs'), 'export const tier=1;\n', 'utf8');
    await writeFile(path.join(tmp, 'tier2-skip.test.mjs'), 'export const tier=2;\n', 'utf8');
    await writeFile(path.join(tmp, 'ignored-helper.mjs'), 'export const helper=1;\n', 'utf8');

    const mods = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { discoverTierModules }) => discoverTierModules([1, 3], p.tmp)',
      { tmp },
    );
    ctx.assert.deepEqual(
      mods.map((m) => m.filename),
      ['tier1-a.test.mjs', 'tier1-b.test.mjs', 'tier3-c.test.mjs'],
    );
  });

  test('T1-F12-04', 'runE2ESuite passes full ctx contract and cleans up test temp dirs after completion', async (t) => {
    const tmp = await t.createTempDir('t1-f12-04-');
    const markerFile = path.join(tmp, 'created-dir-path.txt');
    const modCode = [
      "import { writeFileSync } from 'node:fs';",
      'export const tier = 1;',
      "export const name = 'synthetic-ctx';",
      'export function registerTests(test, ctx) {',
      "  test('SYN-01', 'Check ctx surface and tempDir tracking', async (subT) => {",
      "    const d = await subT.createTempDir('inner-syn-');",
      `    writeFileSync(${JSON.stringify(markerFile)}, d, 'utf8');`,
      "    ctx.assert.equal(ctx.mode, 'harness');",
      '    ctx.assert.ok(ctx.baseUrl.startsWith("http://127.0.0.1:"));',
      '    ctx.assert.ok(ctx.harness && typeof ctx.harness.resetState === "function");',
      '    ctx.assert.ok(typeof ctx.createClient === "function");',
      '    ctx.assert.ok(ctx.cryptoDelta && ctx.repoChecks && ctx.assert);',
      '  });',
      '}',
      '',
    ].join('\n');
    await writeFile(path.join(tmp, 'tier1-ctx.test.mjs'), modCode, 'utf8');

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1], tiersDir: p.tmp, mode: "harness", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 0);
    ctx.assert.equal(report.ok, true);
    ctx.assert.equal(report.summary.passed, 1);

    const innerTempDir = await readFile(markerFile, 'utf8');
    ctx.assert.equal(existsSync(innerTempDir), false, 'Runner must remove tracked temp dirs in cleanup()');
  });

  test('T1-F12-05', '--filter substring matching and parseArgs CLI parsing contract', async (t) => {
    const parsed = await invokeRunnerApi(
      ctx.repoRoot,
      'async (_p, { parseArgs }) => parseArgs(["--tier", "3,1", "--mode", "harness", "--repo-check", "--json", "--filter", "Target"])',
    );
    ctx.assert.deepEqual(parsed.tiers, [1, 3]);
    ctx.assert.equal(parsed.mode, 'harness');
    ctx.assert.equal(parsed.repoCheck, true);
    ctx.assert.equal(parsed.json, true);
    ctx.assert.equal(parsed.filter, 'target');

    const tmp = await t.createTempDir('t1-f12-05-');
    await writeFile(
      path.join(tmp, 'tier1-filter.test.mjs'),
      [
        'export const tier = 1;',
        "export const name = 'filter-suite';",
        'export function registerTests(test) {',
        "  test('FLT-01', 'Alpha Target Case', async () => {});",
        "  test('FLT-02', 'Beta Other Case', async () => {});",
        '}',
      ].join('\n'),
      'utf8',
    );

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1], tiersDir: p.tmp, mode: "harness", filter: "TARGET", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 0);
    ctx.assert.equal(report.summary.total, 1);
    ctx.assert.equal(report.results[0].id, 'FLT-01');
  });

  // =========================================================================
  // Feature F13: Verification Integrity & Reporting Contracts (T1-F13-01..05)
  // =========================================================================

  test('T1-F13-01', 'rokbot-e2e-report/v1 structural completeness across multi-tier runE2ESuite', async (t) => {
    const tmp = await t.createTempDir('t1-f13-01-');
    await writeFile(
      path.join(tmp, 'tier1-a.test.mjs'),
      "export const tier = 1; export const name = 't1'; export function registerTests(test) { test('R-01', 'Pass 1', async () => {}); }\n",
      'utf8',
    );
    await writeFile(
      path.join(tmp, 'tier2-b.test.mjs'),
      "export const tier = 2; export const name = 't2'; export function registerTests(test) { test('R-02', 'Pass 2', async () => {}); }\n",
      'utf8',
    );

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1, 2], tiersDir: p.tmp, mode: "harness", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 0);
    ctx.assert.assertJsonSchema(report, {
      schema: 'string',
      ok: 'boolean',
      mode: 'string',
      repoCheck: 'boolean',
      selfCheck: 'boolean',
      durationMs: 'number',
      summary: { total: 'number', passed: 'number', failed: 'number', skipped: 'number' },
      tiers: {
        '1': { total: 'number', passed: 'number', failed: 'number', skipped: 'number' },
        '2': { total: 'number', passed: 'number', failed: 'number', skipped: 'number' },
      },
      results: 'array',
    });
    ctx.assert.equal(report.schema, 'rokbot-e2e-report/v1');
    ctx.assert.equal(report.results.length, 2);
  });

  test('T1-F13-02', 'ctx.assert.assertStatus and ctx.assert.assertJsonSchema accept valid contracts', async () => {
    ctx.assert.assertStatus({ status: 200, text: '{}' }, 200);
    ctx.assert.assertStatus({ status: 201, text: '{}' }, [200, 201]);

    ctx.assert.assertJsonSchema(
      {
        ok: true,
        count: 3,
        label: 'RokBot',
        items: ['a'],
        meta: { nested: 'ok', extra: null },
      },
      {
        ok: 'boolean',
        count: 'number',
        label: 'string',
        items: 'array',
        meta: { nested: 'string', extra: 'any' },
      },
    );
  });

  test('T1-F13-03', 'Strict failure propagation: failing test yields exitCode 1, ok false & error details', async (t) => {
    const tmp = await t.createTempDir('t1-f13-03-');
    await writeFile(
      path.join(tmp, 'tier1-fail.test.mjs'),
      [
        'export const tier = 1;',
        "export const name = 'fail-suite';",
        'export function registerTests(test, ctx) {',
        "  test('FAIL-01', 'Intentional failure', async () => { ctx.assert.equal(1, 2, 'boom-mismatch'); });",
        '}',
      ].join('\n'),
      'utf8',
    );

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1], tiersDir: p.tmp, mode: "harness", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 1);
    ctx.assert.equal(report.ok, false);
    ctx.assert.equal(report.summary.failed, 1);
    ctx.assert.equal(report.results[0].status, 'fail');
    ctx.assert.ok(report.results[0].error.includes('boom-mismatch'));
  });

  test('T1-F13-04', 'Per-tier accounting invariant across pass, fail, and skip outcomes', async (t) => {
    const tmp = await t.createTempDir('t1-f13-04-');
    await writeFile(
      path.join(tmp, 'tier1-mix.test.mjs'),
      [
        'export const tier = 1;',
        "export const name = 'mix1';",
        'export function registerTests(test) {',
        "  test('M-01', 'Pass', async () => {});",
        "  test('M-02', 'Skip', async (st) => { st.skip('intentional'); });",
        '}',
      ].join('\n'),
      'utf8',
    );
    await writeFile(
      path.join(tmp, 'tier2-mix.test.mjs'),
      [
        'export const tier = 2;',
        "export const name = 'mix2';",
        'export function registerTests(test, ctx) {',
        "  test('M-03', 'Fail', async () => { ctx.assert.fail('expected-fail'); });",
        '}',
      ].join('\n'),
      'utf8',
    );

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1, 2], tiersDir: p.tmp, mode: "harness", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 1);
    const tierSum = Object.values(report.tiers).reduce((acc, s) => acc + s.total, 0);
    ctx.assert.equal(report.summary.total, tierSum);
    ctx.assert.equal(
      report.summary.passed + report.summary.failed + report.summary.skipped,
      report.summary.total,
    );
    ctx.assert.equal(report.tiers['1'].passed, 1);
    ctx.assert.equal(report.tiers['1'].skipped, 1);
    ctx.assert.equal(report.tiers['2'].failed, 1);
  });

  test('T1-F13-05', 'harness.getAuditLog records HTTP mutations and auth failures without secret leakage', async (t) => {
    if (!ctx.harness) t.skip('Requires harness audit log inspection');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const unauth = await client.localStatus({ auth: false });
    ctx.assert.assertStatus(unauth, 401);

    const noCsrf = await client.adminLogin(ctx.adminPassword, { csrf: false });
    ctx.assert.assertStatus(noCsrf, 403);

    const login = await client.adminLogin(ctx.adminPassword);
    ctx.assert.assertStatus(login, 200);

    const key = await client.createPairingKey();
    ctx.assert.assertStatus(key, 201);

    const pair = await client.pairWithKey({ pairingKey: key.json.pairingKey, deviceName: 'Audit Device' });
    ctx.assert.assertStatus(pair, 201);

    const log = ctx.harness.getAuditLog();
    ctx.assert.ok(log.some((e) => e.status === 401 && e.actorKind === 'anon'));
    ctx.assert.ok(log.some((e) => e.status === 403));
    ctx.assert.ok(log.some((e) => e.status === 200 && e.actorKind === 'admin'));
    ctx.assert.ok(log.some((e) => e.status === 201 && e.path === '/connect/pair'));
    ctx.assert.assertNoSecrets(log, [ctx.adminPassword, pair.json.token, key.json.pairingKey], { forbidTokenKey: true });
  });

  // =========================================================================
  // Feature F14: Live Emulator & Local Host E2E Readiness (T1-F14-01..05)
  // =========================================================================

  test('T1-F14-01', 'Full pairing flow (pairingKey & admin password) returns gatewayUrl & notificationUrl', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for dual key+password pairing; live pairing covered by T1-F09-02, T1-F10-04 & T1-F14-03');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);

    const pairKey = await client.pairWithKey({
      pairingKey: keyRes.json.pairingKey,
      deviceName: 'Emulator Pixel 9',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'emu-5554-01',
    });
    ctx.assert.assertStatus(pairKey, 201);
    ctx.assert.assertJsonSchema(pairKey.json, {
      deviceId: 'string',
      token: 'string',
      gatewayUrl: 'string',
      notificationUrl: 'string',
    });
    if (ctx.harness || pairKey.json.reused !== undefined) {
      ctx.assert.equal(pairKey.json.reused, false);
    }

    const conn = await client.connectStatus();
    ctx.assert.assertStatus(conn, 200);
    ctx.assert.equal(conn.json.connected, true);
    ctx.assert.equal(conn.json.deviceId, pairKey.json.deviceId);

    const client2 = createClient(ctx, { deviceToken: null });
    t.after(() => client2.close());
    const pairPw = await client2.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Admin Desktop',
      platform: 'desktop',
      clientDeviceId: 'desktop-pw-01',
    });
    ctx.assert.assertStatus(pairPw, 201);
    const loc = await client2.localStatus();
    ctx.assert.assertStatus(loc, 200);
    ctx.assert.equal(loc.json.canConfigureModel, true);
  });

  test('T1-F14-02', 'clientDeviceId dedup per platform rotates token & isolates distinct platforms', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for 4-device multi-platform dedup');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const sharedCid = 'shared-hw-id-001';
    const a1 = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android Phone',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: sharedCid,
    });
    ctx.assert.assertStatus(a1, 201);
    const oldToken = a1.json.token;

    const a2 = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android Phone Re-paired',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: sharedCid,
    });
    ctx.assert.assertStatus(a2, 201);
    if (ctx.harness || a2.json.reused !== undefined) {
      ctx.assert.equal(a2.json.reused, true);
    }
    ctx.assert.equal(a2.json.deviceId, a1.json.deviceId);
    ctx.assert.notEqual(a2.json.token, oldToken);

    const oldAuth = await client.localStatus({ bearer: oldToken });
    ctx.assert.assertStatus(oldAuth, 401);

    // Same clientDeviceId on iOS and Desktop creates separate deviceIds
    const iosClient = createClient(ctx, { deviceToken: null });
    t.after(() => iosClient.close());
    const i1 = await iosClient.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'iOS Device',
      platform: 'ios',
      clientDeviceId: sharedCid,
    });
    ctx.assert.assertStatus(i1, 201);
    if (ctx.harness || i1.json.reused !== undefined) {
      ctx.assert.equal(i1.json.reused, false);
    }
    ctx.assert.notEqual(i1.json.deviceId, a1.json.deviceId);

    const deskClient = createClient(ctx, { deviceToken: null });
    t.after(() => deskClient.close());
    const d1 = await deskClient.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Desktop Device',
      platform: 'desktop',
      clientDeviceId: sharedCid,
    });
    ctx.assert.assertStatus(d1, 201);
    if (ctx.harness || d1.json.reused !== undefined) {
      ctx.assert.equal(d1.json.reused, false);
    }
    ctx.assert.notEqual(d1.json.deviceId, a1.json.deviceId);
    ctx.assert.notEqual(d1.json.deviceId, i1.json.deviceId);
  });

  test('T1-F14-03', 'Admin device management lifecycle (list without hashes -> revoke -> 401)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    const keyRes = await client.createPairingKey();
    const pair = await client.pairWithKey({
      pairingKey: keyRes.json.pairingKey,
      deviceName: 'Revokable Phone',
      platform: 'desktop',
      clientKind: 'android',
    });
    ctx.assert.assertStatus(pair, 201);
    let revoked = false;
    t.after(async () => {
      if (!ctx.harness && !revoked && pair.json?.deviceId) {
        await client.revokeDevice(pair.json.deviceId).catch(() => {});
      }
    });

    const list = ctx.harness ? await client.listDevices() : await client.adminStatus();
    ctx.assert.assertStatus(list, 200);
    const dev = list.json.devices.find((d) => d.id === pair.json.deviceId);
    ctx.assert.ok(dev);
    ctx.assert.equal(dev.hash, undefined);
    ctx.assert.equal(dev.tokenHash, undefined);
    ctx.assert.equal(dev.passwordHash, undefined);
    ctx.assert.assertNoSecrets(list.json, [ctx.adminPassword, pair.json.token], { forbidTokenKey: true });

    const rev = await client.revokeDevice(pair.json.deviceId);
    ctx.assert.assertStatus(rev, 200);
    revoked = true;
    ctx.assert.equal(rev.json.ok, true);

    const after = await client.localStatus();
    ctx.assert.assertStatus(after, 401);
  });

  test('T1-F14-04', 'Push config (PUT /local/device) & POST /local/device/push/test delivers via pushSink', async (t) => {
    if (!ctx.harness) t.skip('Requires harness pushSink simulation without dialing external webhook');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const delivered = [];
    if (ctx.harness) {
      ctx.harness.setPushSink((entry) => delivered.push(entry));
    }

    const pair = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Push Android',
      platform: 'desktop',
      clientKind: 'android',
    });
    ctx.assert.assertStatus(pair, 201);

    const put = await client.updateDevice({
      push: { provider: 'ntfy', ntfyUrl: 'https://ntfy.example.com/rokbot-topic' },
    });
    ctx.assert.assertStatus(put, 200);
    ctx.assert.equal(put.json.push.provider, 'ntfy');
    ctx.assert.equal(put.json.push.enabled, true);

    const getDev = await client.getDevice();
    ctx.assert.assertStatus(getDev, 200);
    ctx.assert.equal(getDev.json.push.provider, 'ntfy');

    const testPush = await client.testDevicePush({ agentId: 'rokbot-main' });
    ctx.assert.assertStatus(testPush, 200);
    ctx.assert.equal(testPush.json.status, 'sent');
    if (ctx.harness) {
      ctx.assert.equal(delivered.length, 1);
      ctx.assert.equal(delivered[0].deviceId, pair.json.deviceId);
    }
  });

  test('T1-F14-05', 'Notifications SSE, x-rokbot-foreground suppression & Last-Event-ID replay', async (t) => {
    if (!ctx.harness) t.skip('Requires harness notification/push sink simulation');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const pair = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Foreground Android',
      platform: 'desktop',
      clientKind: 'android',
    });
    ctx.assert.assertStatus(pair, 201);
    await client.updateDevice({
      push: { provider: 'webhook', webhookUrl: 'https://push.example.com/android-hook' },
    });

    const sse1 = await client.openSse('/notifications/events', {
      headers: { 'x-rokbot-foreground': '1' },
    });
    const n1 = ctx.harness.publishNotification({ title: 'Msg 1', body: 'First' });
    const ev1 = await sse1.nextEvent((e) => e.event === 'notification' && e.data?.id === n1.id, 3000);
    ctx.assert.equal(ev1.data.title, 'Msg 1');

    const hist = ctx.harness.getPushHistory();
    ctx.assert.ok(hist.suppressed.some((s) => s.deviceId === pair.json.deviceId && s.reason === 'foreground'));
    await sse1.close();

    // Publish while disconnected; reconnect with Last-Event-ID and check /notifications?after=
    const n2 = ctx.harness.publishNotification({ title: 'Msg 2', body: 'Missed' });
    const sse2 = await client.openSse('/notifications/events', { lastEventId: n1.id });
    t.after(() => sse2.close());
    const ev2 = await sse2.nextEvent((e) => e.event === 'notification' && e.data?.id === n2.id, 3000);
    ctx.assert.equal(ev2.data.title, 'Msg 2');

    const deltaList = await client.getNotifications(n1.id);
    ctx.assert.assertStatus(deltaList, 200);
    ctx.assert.equal(deltaList.json.items.some((it) => it.id === n2.id), true);
    ctx.assert.equal(deltaList.json.items.some((it) => it.id === n1.id), false);
  });

  // =========================================================================
  // Feature F15: Privacy, Secret-Hygiene & Documentation Contracts (T1-F15-01..05)
  // =========================================================================

  test('T1-F15-01', 'Zero plaintext secrets across Host public, device & admin JSON responses', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const apiKeySecret = 'sk-tier1-audit-secret-987654';
    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    await ensureDeviceSession(ctx, client, { deviceName: 'Secret Audit Device' });

    if (ctx.harness) {
      await client.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: apiKeySecret,
      });
    }

    const locStatus = await client.localStatus();
    ctx.assert.assertStatus(locStatus, 200);
    const devicesRes = ctx.harness ? await client.listDevices() : await client.adminStatus();
    ctx.assert.assertStatus(devicesRes, 200);
    const dp = devicesRes.json?.model?.devicePolicy;
    const hostAllowsDeviceModel = !dp || (dp.envAllowed !== false && dp.allowDeviceModelConfig !== false);
    const canCheckModel = ctx.harness
      || Boolean(locStatus.json?.canConfigureModel)
      || (hostAllowsDeviceModel && locStatus.json?.pairedWith !== 'password' && Boolean(ctx.adminPassword));
    const endpoints = [
      await client.health(),
      await client.connectStatus(),
      locStatus,
      ...(canCheckModel
        ? [await client.getLocalModel(ctx.adminPassword ? { adminPassword: ctx.adminPassword } : {})]
        : []),
      devicesRes,
      await client.adminListUpdates(),
    ];
    const forbidden = [ctx.adminPassword, apiKeySecret, client.deviceToken].filter(Boolean);
    for (const res of endpoints) {
      ctx.assert.assertStatus(res, 200);
      ctx.assert.assertNoSecrets(res.json, forbidden, { forbidTokenKey: true });
    }
    if (!ctx.harness && !hostAllowsDeviceModel) {
      const blockedModelRes = await client.getLocalModel(ctx.adminPassword ? { adminPassword: ctx.adminPassword } : {});
      ctx.assert.assertStatus(blockedModelRes, 403);
      ctx.assert.assertNoSecrets(blockedModelRes.json ?? blockedModelRes.text, forbidden, { forbidTokenKey: true });
    }
    ctx.assert.ok(Array.isArray(devicesRes.json?.devices), 'Expected devicesRes.json.devices to be an array');
    ctx.assert.ok(devicesRes.json.devices.length > 0, 'Expected at least 1 paired device in devices list');
    ctx.assert.equal(
      devicesRes.json.devices.every((d) => d.hash === undefined && d.tokenHash === undefined && d.passwordHash === undefined),
      true,
      'Device entries must not expose hash, tokenHash, or passwordHash',
    );
    if (Array.isArray(devicesRes.json?.pairingKeys)) {
      ctx.assert.equal(
        devicesRes.json.pairingKeys.every((k) => k.hash === undefined && k.keyHash === undefined),
        true,
        'Pairing key entries must not expose hash or keyHash',
      );
    }
  });

  test('T1-F15-02', 'assertNoSecrets permits properly redacted placeholders, hasApiKey & publicKeyPem', async () => {
    const safePayload = {
      config: {
        providers: [{ id: 'oai', apiKey: '***', hasApiKey: true }],
        backup: { apiKey: '[REDACTED]', note: 'REDACTED' },
      },
      envTemplate: 'ROKBOT_ADMIN_PASSWORD=${ROKBOT_ADMIN_PASSWORD}\nOPENAI_API_KEY=[REDACTED]\n',
      publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...\n-----END PUBLIC KEY-----',
    };
    ctx.assert.assertNoSecrets(safePayload, ['RealSecretShouldNotMatch'], { forbidTokenKey: true });
  });

  test('T1-F15-03', 'Mandatory HTTP security headers verified across public, device & admin endpoints', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureAdminSession(ctx, client);
    await ensureDeviceSession(ctx, client, { deviceName: 'Header Probe' });

    const responses = [
      await client.health(),
      await client.connectStatus({ auth: false }),
      await client.localStatus(),
      await client.adminSession(),
    ];
    for (const res of responses) {
      ctx.assert.assertStatus(res, 200);
      ctx.assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      ctx.assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      ctx.assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      ctx.assert.ok((res.headers.get('cache-control') || '').includes('no-store'));
    }
  });

  test('T1-F15-04', 'Clean E2E report output passes assertNoSecrets with forbidTokenKey enabled', async (t) => {
    const tmp = await t.createTempDir('t1-f15-04-');
    await writeFile(
      path.join(tmp, 'tier1-clean.test.mjs'),
      [
        'export const tier = 1;',
        "export const name = 'clean-report';",
        'export function registerTests(test, ctx) {',
        "  test('CLN-01', 'Pair and check status cleanly', async (st) => {",
        '    const c = ctx.createClient();',
        '    st.after(() => c.close());',
        '    const p = await c.pairWithPassword({ password: ctx.adminPassword, deviceName: "Clean" });',
        '    ctx.assert.assertStatus(p, 201);',
        '  });',
        '}',
      ].join('\n'),
      'utf8',
    );

    const { exitCode, report } = await invokeRunnerApi(
      ctx.repoRoot,
      'async (p, { runE2ESuite }) => runE2ESuite({ tiers: [1], tiersDir: p.tmp, mode: "harness", silent: true })',
      { tmp },
    );
    ctx.assert.equal(exitCode, 0);
    ctx.assert.assertNoSecrets(report, [ctx.adminPassword], { forbidTokenKey: true, label: 'synthetic report' });
  });

  test('T1-F15-05', 'Repo & documentation secret hygiene (.gitignore rules, READMEs & .env.images.example)', async (t) => {
    const tmp = await t.createTempDir('t1-f15-05-');
    const sampleGitignore = '.env\n.env.*\n!.env.*.example\n.admin-password\n*.pem\n*.key\nmodel.env\nauth.json\n';
    const sampleDoc = '# RokBot\nClone https://github.com/hongfaqiu/rokbot\n';
    await writeFile(path.join(tmp, '.gitignore'), sampleGitignore, 'utf8');
    await writeFile(path.join(tmp, 'README.md'), sampleDoc, 'utf8');
    ctx.assert.assertNoSecrets(sampleDoc, [], { label: 'sample README' });

    const gitignorePath = path.join(ctx.repoRoot, '.gitignore');
    if (existsSync(gitignorePath)) {
      const gi = await readFile(gitignorePath, 'utf8');
      for (const pat of ['.env', '.admin-password', '*.pem', '*.key', 'model.env', 'auth.json']) {
        ctx.assert.ok(gi.includes(pat), `.gitignore must ignore ${pat}`);
      }
    }

    for (const rel of [
      'tests/e2e/README.md',
      'README.md',
      'README.en.md',
      'host/release/.env.images.example',
    ]) {
      const full = path.join(ctx.repoRoot, rel);
      if (existsSync(full)) {
        const text = await readFile(full, 'utf8');
        ctx.assert.assertNoSecrets(text, [], { label: rel });
      }
    }

    if (ctx.repoCheck) {
      for (const docRel of ['README.md', 'README.en.md']) {
        const docText = await readFile(path.join(ctx.repoRoot, docRel), 'utf8');
        ctx.assert.ok(/rokbot/i.test(docText), `${docRel} must mention rokbot`);
      }
      const ls = await spawnAsync('git', ['ls-files', '.env', '.admin-password', 'model.env', 'auth.json'], {
        cwd: ctx.repoRoot,
        encoding: 'utf8',
      });
      ctx.assert.equal(ls.status, 0);
      ctx.assert.equal(ls.stdout.trim(), '', `Sensitive files must not be tracked in git: ${ls.stdout}`);
    }
  });
}
