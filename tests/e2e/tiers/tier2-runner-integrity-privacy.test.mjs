import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const tier = 2;
export const name = 'tier2-runner-integrity-privacy';

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

async function invokeRunnerApi(repoRoot, code, extraEnv = {}) {
  const runnerUrl = pathToFileURL(path.join(repoRoot, 'tests/e2e/runner.mjs')).href;
  const full = `import { parseArgs, discoverTierModules, runE2ESuite } from ${JSON.stringify(runnerUrl)};\n${code}`;
  return spawnAsync(process.execPath, ['--input-type=module', '-e', full], {
    cwd: repoRoot,
    env: cleanRunnerEnv(extraEnv),
    encoding: 'utf8',
    timeout: 20000,
  });
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F12 — Opaque-Box E2E Runner & Mode Contracts (T2-F12-01..05)
  // =========================================================================

  test('T2-F12-01', 'Runner CLI exits with code 2 on invalid --tier, --mode & unknown flags', async () => {
    const runnerPath = path.join(ctx.repoRoot, 'tests/e2e/runner.mjs');
    for (const args of [['--tier', '9'], ['--mode', 'bogus'], ['--unknown-flag']]) {
      const res = await spawnAsync(process.execPath, [runnerPath, ...args], {
        cwd: ctx.repoRoot,
        env: cleanRunnerEnv(),
        encoding: 'utf8',
        timeout: 10000,
      });
      ctx.assert.equal(res.status, 2, `Expected exit 2 for ${args.join(' ')}, got ${res.status} (${res.stderr})`);
      ctx.assert.match(res.stderr, /^Error:/);
    }
  });

  test('T2-F12-02', 'Runner --mode live without ROKBOT_E2E_HOST_URL exits with code 2 and parseArgs throws', async () => {
    const runnerPath = path.join(ctx.repoRoot, 'tests/e2e/runner.mjs');
    const res = await spawnAsync(process.execPath, [runnerPath, '--mode', 'live'], {
      cwd: ctx.repoRoot,
      env: cleanRunnerEnv(),
      encoding: 'utf8',
      timeout: 10000,
    });
    ctx.assert.equal(res.status, 2);
    ctx.assert.match(res.stderr, /ROKBOT_E2E_HOST_URL/);

    const apiRes = await invokeRunnerApi(
      ctx.repoRoot,
      `try { parseArgs(['--mode', 'live']); process.exit(1); } catch (e) { process.stdout.write(e.message); }`,
    );
    ctx.assert.equal(apiRes.status, 0, apiRes.stderr);
    ctx.assert.match(apiRes.stdout, /ROKBOT_E2E_HOST_URL/);
  });

  test('T2-F12-03', 'Empty requested tier returns exitCode: 1, ok: false and diagnostic report.error', async (t) => {
    const emptyDir = await t.createTempDir('f12-empty-tier-');
    const res = await invokeRunnerApi(
      ctx.repoRoot,
      `const out = await runE2ESuite({ tiers: [4], mode: 'harness', tiersDir: ${JSON.stringify(emptyDir)}, silent: true });
       process.stdout.write(JSON.stringify(out));`,
    );
    ctx.assert.equal(res.status, 0, res.stderr);
    const { exitCode, report } = JSON.parse(res.stdout);
    ctx.assert.equal(exitCode, 1);
    ctx.assert.equal(report.ok, false);
    ctx.assert.equal(report.summary.total, 0);
    ctx.assert.match(String(report.error || ''), /No E2E tests executed/);
  });

  test('T2-F12-04', 'Module contract violations (mismatched tier, empty name, missing registerTests, duplicate id) reject cleanly', async (t) => {
    const cases = [
      {
        filename: 'tier1-bad-tier.test.mjs',
        code: 'export const tier = 2;\nexport const name = "bad";\nexport function registerTests() {}\n',
        match: /exported tier must equal 1/,
      },
      {
        filename: 'tier1-empty-name.test.mjs',
        code: 'export const tier = 1;\nexport const name = "";\nexport function registerTests() {}\n',
        match: /non-empty name/,
      },
      {
        filename: 'tier1-no-reg.test.mjs',
        code: 'export const tier = 1;\nexport const name = "noreg";\n',
        match: /registerTests/,
      },
      {
        filename: 'tier1-dup-id.test.mjs',
        code: [
          'export const tier = 1;',
          'export const name = "dup";',
          'export function registerTests(test) {',
          '  test("DUP-1", "first", async () => {});',
          '  test("DUP-1", "second", async () => {});',
          '}',
        ].join('\n'),
        match: /Duplicate test id: DUP-1/,
      },
    ];

    for (const c of cases) {
      const dir = await t.createTempDir('f12-contract-');
      await writeFile(path.join(dir, c.filename), c.code, 'utf8');
      const res = await invokeRunnerApi(
        ctx.repoRoot,
        `try {
           await runE2ESuite({ tiers: [1], mode: 'harness', tiersDir: ${JSON.stringify(dir)}, silent: true });
           process.exit(1);
         } catch (err) {
           process.stdout.write(err.message);
         }`,
      );
      ctx.assert.equal(res.status, 0, res.stderr);
      ctx.assert.match(res.stdout, c.match);
    }
  });

  test('T2-F12-05', 't.after() executes in LIFO order across pass, fail & skip, and throwing in t.after fails a passing test', async (t) => {
    const dir = await t.createTempDir('f12-lifo-');
    const logPath = path.join(dir, 'events.json');
    const modCode = [
      `import { writeFileSync } from 'node:fs';`,
      `const log = [];`,
      `export const tier = 1;`,
      `export const name = 'lifo';`,
      `export function registerTests(test) {`,
      `  test('L-PASS', 'pass lifo', async (tc) => {`,
      `    tc.after(() => log.push('pass-1'));`,
      `    tc.after(() => log.push('pass-2'));`,
      `  });`,
      `  test('L-FAIL', 'fail lifo', async (tc) => {`,
      `    tc.after(() => log.push('fail-1'));`,
      `    tc.after(() => log.push('fail-2'));`,
      `    throw new Error('boom');`,
      `  });`,
      `  test('L-SKIP', 'skip lifo', async (tc) => {`,
      `    tc.after(() => log.push('skip-1'));`,
      `    tc.after(() => log.push('skip-2'));`,
      `    tc.skip('not applicable');`,
      `  });`,
      `  test('L-HOOK-ERR', 'hook throw turns pass into fail', async (tc) => {`,
      `    tc.after(() => {`,
      `      log.push('hook-throw');`,
      `      writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(log));`,
      `      throw new Error('cleanup failed');`,
      `    });`,
      `  });`,
      `}`,
    ].join('\n');
    await writeFile(path.join(dir, 'tier1-lifo.test.mjs'), modCode, 'utf8');

    const res = await invokeRunnerApi(
      ctx.repoRoot,
      `const out = await runE2ESuite({ tiers: [1], mode: 'harness', tiersDir: ${JSON.stringify(dir)}, silent: true });
       process.stdout.write(JSON.stringify(out));`,
    );
    ctx.assert.equal(res.status, 0, res.stderr);
    const { exitCode, report } = JSON.parse(res.stdout);
    ctx.assert.equal(exitCode, 1);
    ctx.assert.equal(report.summary.passed, 1);
    ctx.assert.equal(report.summary.failed, 2);
    ctx.assert.equal(report.summary.skipped, 1);
    const hookErrRes = report.results.find((r) => r.id === 'L-HOOK-ERR');
    ctx.assert.equal(hookErrRes.status, 'fail');
    ctx.assert.match(hookErrRes.error, /cleanup failed/);

    const recorded = JSON.parse(await readFile(logPath, 'utf8'));
    ctx.assert.deepEqual(recorded, ['pass-2', 'pass-1', 'fail-2', 'fail-1', 'skip-2', 'skip-1', 'hook-throw']);
  });

  // =========================================================================
  // Feature F13 — Verification Integrity & Reporting Contracts (T2-F13-01..05)
  // =========================================================================

  test('T2-F13-01', 'Report secret-leak guard rejects runE2ESuite when inner failure leaks adminPassword, Bearer or sk- key', async (t) => {
    const dir = await t.createTempDir('f13-leak-');
    const modCode = [
      'export const tier = 1;',
      'export const name = "leak-probe";',
      'export function registerTests(test, innerCtx) {',
      '  test("LEAK-1", "leaks secrets into error", async () => {',
      '    const fakeKey = ["sk", "innerleaktest", "0123456789abcdef"].join("-");',
      '    throw new Error(`leaked pw=${innerCtx.adminPassword} key=${fakeKey}`);',
      '  });',
      '}',
    ].join('\n');
    await writeFile(path.join(dir, 'tier1-leak.test.mjs'), modCode, 'utf8');

    const res = await invokeRunnerApi(
      ctx.repoRoot,
      `try {
         await runE2ESuite({ tiers: [1], mode: 'harness', tiersDir: ${JSON.stringify(dir)}, silent: true });
         process.exit(1);
       } catch (err) {
         process.stdout.write(err.message);
       }`,
    );
    ctx.assert.equal(res.status, 0, res.stderr);
    ctx.assert.match(res.stdout, /Secret hygiene check failed in E2E report/);
    ctx.assert.equal(res.stdout.includes('RokBotAdmin!2026'), false);
  });

  test('T2-F13-02', 'ctx.assert.assertStatus and assertJsonSchema fail with informative mismatch diagnostics', async () => {
    ctx.assert.throws(
      () => ctx.assert.assertStatus({ status: 403, text: '{"error":"forbidden"}' }, [200, 201], 'Probe'),
      /Probe: Expected HTTP 200\|201, got 403 \(\{"error":"forbidden"\}\)/,
    );

    ctx.assert.throws(
      () => ctx.assert.assertJsonSchema({ a: 'ok' }, { a: 'string', b: 'number' }, 'MissingKey'),
      /MissingKey: root\.b is required/,
    );
    ctx.assert.throws(
      () => ctx.assert.assertJsonSchema({ a: 123 }, { a: 'string' }, 'WrongType'),
      /WrongType: root\.a must have typeof string/,
    );
    ctx.assert.throws(
      () => ctx.assert.assertJsonSchema([], 'object', 'ArrayNotObject'),
      /ArrayNotObject: root must be an object/,
    );
  });

  test('T2-F13-03', 't.skip() marks status="skip" with reason, summary.skipped===1 & ok===true while running t.after cleanup', async (t) => {
    const dir = await t.createTempDir('f13-skip-');
    const modCode = [
      'export const tier = 1;',
      'export const name = "skip-check";',
      'export function registerTests(test) {',
      '  test("SK-1", "skip test", async (tc) => {',
      '    tc.after(() => {});',
      '    tc.skip("live fault unsupported");',
      '  });',
      '}',
    ].join('\n');
    await writeFile(path.join(dir, 'tier1-skip.test.mjs'), modCode, 'utf8');

    const res = await invokeRunnerApi(
      ctx.repoRoot,
      `const out = await runE2ESuite({ tiers: [1], mode: 'harness', tiersDir: ${JSON.stringify(dir)}, silent: true });
       process.stdout.write(JSON.stringify(out));`,
    );
    ctx.assert.equal(res.status, 0, res.stderr);
    const { exitCode, report } = JSON.parse(res.stdout);
    ctx.assert.equal(exitCode, 0);
    ctx.assert.equal(report.ok, true);
    ctx.assert.equal(report.summary.skipped, 1);
    ctx.assert.equal(report.results[0].status, 'skip');
    ctx.assert.equal(report.results[0].reason, 'live fault unsupported');
  });

  test('T2-F13-04', 'runner.mjs --self-check --json emits strictly parseable single-JSON rokbot-e2e-report/v1 on stdout', async () => {
    const runnerPath = path.join(ctx.repoRoot, 'tests/e2e/runner.mjs');
    const res = await spawnAsync(process.execPath, [runnerPath, '--self-check', '--mode', 'harness', '--json'], {
      cwd: ctx.repoRoot,
      env: cleanRunnerEnv(),
      encoding: 'utf8',
      timeout: 20000,
    });
    ctx.assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    ctx.assert.equal(parsed.schema, 'rokbot-e2e-report/v1');
    ctx.assert.equal(parsed.ok, true);
    ctx.assert.equal(parsed.selfCheck, true);
    ctx.assert.ok(parsed.summary.passed >= 4);
    ctx.assert.equal(parsed.summary.failed, 0);
  });

  test('T2-F13-05', 'openSse nextEvent peek ({ consume: false }), consume ({ consume: true }) & timeout rejection integrity', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureDeviceSession(ctx, client, { deviceName: 'SSE Cursor Tester' });

    let liveAgentId = null;
    if (!ctx.harness) {
      const loc = await client.localStatus();
      ctx.assert.assertStatus(loc, 200);
      if (loc.json?.needsModel) {
        t.skip('Live Host has needsModel=true; cannot stream sendPrompt');
      }
      const created = await client.apiCall('createAgent', { name: 'SSE Cursor Bot', description: '' });
      if (created.status === 503) {
        t.skip('Live Host core is disconnected (503)');
      }
      ctx.assert.assertStatus(created, 200);
      liveAgentId = created.json?.id;
      ctx.assert.ok(typeof liveAgentId === 'string' && liveAgentId.length > 0);
      t.after(() => client.apiCall('deleteAgents', { ids: [liveAgentId] }).catch(() => {}));
    }

    const sse = await client.openSse('/events');
    t.after(() => sse.close());

    if (ctx.harness) {
      ctx.harness.emitEvent('test-chan', { seq: 1 });
      ctx.harness.emitEvent('test-chan', { seq: 2 });
    } else {
      const promptRes = await client.apiCall('sendPrompt', {
        agentId: liveAgentId,
        clientNonce: randomUUID(),
        prompt: 'Reply with OK.',
        directAddressedAcceptance: true,
      });
      ctx.assert.assertStatus(promptRes, 200);
    }

    const waitMs = ctx.harness ? 2000 : 15000;
    const peeked = await sse.nextEvent((ev) => Boolean(ev.data?.channel), waitMs, { consume: false });
    ctx.assert.ok(peeked);
    ctx.assert.equal(sse.readIndex, 0, 'consume:false must not advance readIndex');

    const consumed1 = await sse.nextEvent((ev) => Boolean(ev.data?.channel), waitMs, { consume: true });
    ctx.assert.equal(sse.readIndex, 1);
    ctx.assert.deepEqual(consumed1, peeked);

    await ctx.assert.rejects(
      () => sse.nextEvent((ev) => ev.data?.channel === 'never-emitted-channel', 120),
      /Timed out waiting for SSE event/,
    );
  });

  // =========================================================================
  // Feature F14 — Live Emulator & Local Host E2E Readiness (T2-F14-01..06)
  // =========================================================================

  test('T2-F14-01', '/connect/pair enforces credential exclusivity, platform, deviceName, clientDeviceId & key single-use', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for consecutive /connect/pair validation');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await client.adminLogin(ctx.adminPassword);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const pk = keyRes.json.pairingKey;

    const resetRL = () => ctx.harness?.resetRateLimits();

    ctx.assert.assertStatus(
      await client.request('POST', '/connect/pair', { auth: false, body: { pairingKey: pk, password: ctx.adminPassword, deviceName: 'Both' } }),
      400,
    );
    resetRL();
    ctx.assert.assertStatus(
      await client.request('POST', '/connect/pair', { auth: false, body: { deviceName: 'Neither' } }),
      400,
    );
    resetRL();
    ctx.assert.assertStatus(
      await client.pairWithKey({ pairingKey: pk, deviceName: 'RawAndroid', platform: 'android' }),
      400,
    );
    resetRL();
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: pk, deviceName: '   ' }), 400);
    resetRL();
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: pk, deviceName: 'n'.repeat(81) }), 400);
    resetRL();
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: pk, deviceName: 'BadId', clientDeviceId: 'bad id!' }), 400);
    resetRL();

    ctx.assert.assertStatus(await client.pairWithPassword({ password: 'WrongAdminPassword!1', deviceName: 'WrongPw' }), 401);
    resetRL();

    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: pk, deviceName: 'Once' }), 201);
    resetRL();
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: pk, deviceName: 'Twice' }), 401);
  });

  test('T2-F14-02', 'Rate limiting returns 429 on >6 /connect/pair attempts, >5 password pairs & >5 admin logins', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    for (let i = 0; i < 6; i++) {
      const r = await client.pairWithKey({ pairingKey: `BAD00${i}`, deviceName: `RL-${i}` });
      ctx.assert.assertStatus(r, 401);
    }
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: 'BAD006', deviceName: 'RL-6' }), 429);

    ctx.harness.resetRateLimits();

    for (let i = 0; i < 5; i++) {
      const r = await client.pairWithPassword({ password: 'WrongPassword!1', deviceName: `PWL-${i}` });
      ctx.assert.assertStatus(r, 401);
    }
    ctx.assert.assertStatus(await client.pairWithPassword({ password: 'WrongPassword!1', deviceName: 'PWL-5' }), 429);

    ctx.harness.resetRateLimits();

    for (let i = 0; i < 5; i++) {
      const r = await client.adminLogin('WrongPassword!1');
      ctx.assert.assertStatus(r, 401);
    }
    ctx.assert.assertStatus(await client.adminLogin('WrongPassword!1'), 429);
  });

  test('T2-F14-03', 'MAX_DEVICES=100 returns 409 on 101st device & revokeDevice destroys active /events and /notifications/events SSE', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await client.adminLogin(ctx.adminPassword);
    let firstPair = null;
    for (let i = 0; i < 100; i++) {
      if (i % 4 === 0) ctx.harness.resetRateLimits();
      const p = await client.pairWithPassword({
        password: ctx.adminPassword,
        deviceName: `Device-${i}`,
        platform: 'desktop',
        clientDeviceId: `cap-dev-${i}`,
      });
      ctx.assert.assertStatus(p, 201);
      if (i === 0) firstPair = p.json;
    }

    ctx.harness.resetRateLimits();
    const overflow = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Device-101',
      platform: 'desktop',
      clientDeviceId: 'cap-dev-100',
    });
    ctx.assert.assertStatus(overflow, 409);

    const devClient = client.withDeviceToken(firstPair.token, firstPair.deviceId);
    t.after(() => devClient.close());
    const evSse = await devClient.openSse('/events');
    const notifSse = await devClient.openSse('/notifications/events');
    t.after(async () => {
      await evSse.close();
      await notifSse.close();
    });

    ctx.assert.assertStatus(await client.revokeDevice(firstPair.deviceId), 200);
    ctx.assert.assertStatus(await devClient.localStatus(), 401);

    await ctx.assert.rejects(
      () => evSse.nextEvent(() => false, 150),
      /Timed out/,
    );
  });

  test('T2-F14-04', 'federationRole="member" blocks /connect/pair, /web/api/pair & device-authenticated APIs with 403', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await client.adminLogin(ctx.adminPassword);
    const pair = await client.pairWithPassword({ password: ctx.adminPassword, deviceName: 'PreMember' });
    ctx.assert.assertStatus(pair, 201);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);

    ctx.harness.setFederationRole('member');

    ctx.assert.assertStatus(await client.localStatus(), 403);
    ctx.assert.assertStatus(await client.pairWithKey({ pairingKey: keyRes.json.pairingKey, deviceName: 'BlockedPair' }), 403);
    ctx.assert.assertStatus(await client.webPair({ pairingKey: keyRes.json.pairingKey, deviceName: 'BlockedWeb' }), 403);
  });

  test('T2-F14-05', 'PUT /local/device rejects invalid push providers & private/loopback/credential/non-HTTP push URLs (400)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureDeviceSession(ctx, client, { deviceName: 'Push Guard Device' });

    ctx.assert.assertStatus(await client.updateDevice({ push: { provider: 'sms' } }), 400);

    const badUrls = [
      'http://127.0.0.1/hook',
      'http://169.254.169.254/latest',
      'http://localhost/hook',
      'https://user:pass@public.example/hook',
      'ftp://public.example/hook',
    ];
    for (const webhookUrl of badUrls) {
      const res = await client.updateDevice({ push: { provider: 'webhook', webhookUrl } });
      ctx.assert.assertStatus(res, 400, `Expected 400 for push webhookUrl=${webhookUrl}`);
    }
  });

  test('T2-F14-06', 'x-rokbot-foreground: 1 is ignored for desktop devices and suppresses mobile bypassForeground=false test push', async (t) => {
    if (!ctx.harness) t.skip('Requires harness pushSink simulation without dialing external webhook');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const deskPair = await client.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Desktop FG',
      platform: 'desktop',
      clientDeviceId: 'desk-fg-01',
    });
    ctx.assert.assertStatus(deskPair, 201);
    const deskClient = client.withDeviceToken(deskPair.json.token, deskPair.json.deviceId);
    t.after(() => deskClient.close());
    await deskClient.updateDevice({ push: { provider: 'webhook', webhookUrl: 'https://push.example.com/desk' } });
    const deskNotif = await deskClient.openSse('/notifications/events', { headers: { 'x-rokbot-foreground': '1' } });
    t.after(() => deskNotif.close());

    const deskPushRes = await deskClient.testDevicePush({ bypassForeground: false });
    ctx.assert.assertStatus(deskPushRes, 200);
    ctx.assert.equal(deskPushRes.json.status, 'sent');

    const mobClient = createClient(ctx);
    t.after(() => mobClient.close());
    const mobPair = await mobClient.pairWithPassword({
      password: ctx.adminPassword,
      deviceName: 'Android FG',
      platform: 'desktop',
      clientKind: 'android',
      clientDeviceId: 'android-fg-01',
    });
    ctx.assert.assertStatus(mobPair, 201);
    await mobClient.updateDevice({ push: { provider: 'ntfy', ntfyUrl: 'https://ntfy.example.com/rokbot' } });
    const mobNotif = await mobClient.openSse('/notifications/events', { headers: { 'x-rokbot-foreground': '1' } });
    t.after(() => mobNotif.close());

    const suppressed = await mobClient.testDevicePush({ bypassForeground: false });
    ctx.assert.assertStatus(suppressed, 200);
    ctx.assert.equal(suppressed.json.status, 'skipped');
    ctx.assert.equal(suppressed.json.reason, 'foreground');
  });

  // =========================================================================
  // Feature F15 — Privacy, Secret-Hygiene & Documentation Contracts (T2-F15-01..05)
  // =========================================================================

  test('T2-F15-01', 'assertNoSecrets catches all secret classes without echoing plaintext secret values', async () => {
    const explicit = 'ExplicitSecretValue#98765';
    const samples = [
      { label: 'explicit', payload: `val=${explicit}`, extras: [explicit], forbidden: explicit },
      { label: 'pem', payload: '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----', extras: [], forbidden: 'MHcCAQEE' },
      { label: 'bearer', payload: 'Authorization: Bearer AbCdEfGhIjKlMnOpQrStUv12', extras: [], forbidden: 'AbCdEfGhIjKlMnOpQrStUv12' },
      { label: 'sk', payload: `key=${['sk', 'projtest', 'abcdef1234567890abcd'].join('-')}`, extras: [], forbidden: 'abcdef1234567890abcd' },
      { label: 'sk-ant', payload: `key=${['sk', 'ant', 'api03test1234567890'].join('-')}`, extras: [], forbidden: 'api03test1234567890' },
      { label: 'xai', payload: `key=${['xai', 'secretvalue1234567890'].join('-')}`, extras: [], forbidden: 'secretvalue1234567890' },
      { label: 'ghp', payload: `key=${['ghp', '1234567890abcdefghij1234'].join('_')}`, extras: [], forbidden: '1234567890abcdefghij1234' },
      { label: 'akia', payload: `id=${'AKIA' + 'IOSFODNN7EXAMPLE'}`, extras: [], forbidden: 'IOSFODNN7EXAMPLE' },
      { label: 'env', payload: 'OPENAI_API_KEY=secret-env-val-9999', extras: [], forbidden: 'secret-env-val-9999' },
      { label: 'cookie-admin', payload: 'Cookie: rokbot_admin=AdminCookieVal123456', extras: [], forbidden: 'AdminCookieVal123456' },
      { label: 'cookie-web', payload: 'Cookie: rokbot_web=WebCookieVal123456', extras: [], forbidden: 'WebCookieVal123456' },
      { label: 'key-apiKey', payload: { apiKey: 'plain-key-val' }, extras: [], forbidden: 'plain-key-val' },
      { label: 'key-privateKeyPem', payload: { privateKeyPem: 'raw-pem-val' }, extras: [], forbidden: 'raw-pem-val' },
      { label: 'key-password', payload: { password: 'raw-password-val' }, extras: [], forbidden: 'raw-password-val' },
      { label: 'key-token', payload: { token: 'raw-token-val' }, extras: [], opts: { forbidTokenKey: true }, forbidden: 'raw-token-val' },
    ];

    for (const s of samples) {
      let err = null;
      try {
        ctx.assert.assertNoSecrets(s.payload, s.extras, s.opts || {});
      } catch (e) {
        err = e;
      }
      ctx.assert.ok(err, `Expected assertNoSecrets failure for ${s.label}`);
      ctx.assert.equal(err.message.includes(s.forbidden), false, `Error message leaked secret for ${s.label}`);
    }
  });

  test('T2-F15-02', 'Error responses (400, 401, 403, 404, 502) never echo submitted passwords, apiKeys or pairingKeys', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    if (ctx.harness) {
      const badAdminPw = 'SubmittedWrongAdminPw!9988';
      const r401 = await client.adminLogin(badAdminPw);
      ctx.assert.assertStatus(r401, 401);
      ctx.assert.equal(r401.text.includes(badAdminPw), false);

      const badPk = 'BADPAIRSECRET99';
      const r401Pair = await client.pairWithKey({ pairingKey: badPk, deviceName: 'EchoProbe' });
      ctx.assert.assertStatus(r401Pair, 401);
      ctx.assert.equal(r401Pair.text.includes(badPk), false);

      await ensureAdminSession(ctx, client);
      const pkRes = await client.createPairingKey();
      await client.pairWithKey({ pairingKey: pkRes.json.pairingKey, deviceName: 'EchoGuest' });
      const wrongStepUp = 'WrongStepUpSecret!7766';
      const r403 = await client.getLocalModel({ adminPassword: wrongStepUp });
      ctx.assert.assertStatus(r403, 403);
      ctx.assert.equal(r403.text.includes(wrongStepUp), false);
    }

    await ensureDeviceSession(ctx, client, { deviceName: 'EchoPwDev' });
    const submittedApiKey = ['sk', 'echo', 'testkey1234567890'].join('-');
    const r400 = await client.putLocalModel(
      { apiFormat: 'openai', baseUrl: 'ftp://invalid.example/v1', model: 'gpt-4o', apiKey: submittedApiKey },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(r400, ctx.harness ? 400 : [400, 403]);
    ctx.assert.equal(r400.text.includes(submittedApiKey), false);

    if (ctx.harness) {
      ctx.harness.setModelTestFault({ status: 502, message: 'Upstream failure' });
      const r502 = await client.testModel({ model: 'gpt-4o', apiKey: submittedApiKey }, { adminPassword: ctx.adminPassword });
      ctx.assert.assertStatus(r502, 502);
      ctx.assert.equal(r502.text.includes(submittedApiKey), false);
    }

    if (ctx.harness) {
      const r404 = await client.getUpdateManifest('windows');
      ctx.assert.assertStatus(r404, 404);
      ctx.assert.assertNoSecrets(r404.text, [ctx.adminPassword, submittedApiKey], { forbidTokenKey: true });
    }

    const r404File = await client.getFileContent('99999999-9999-4999-8999-999999999999', 'missing.txt');
    ctx.assert.assertStatus(r404File, ctx.harness ? 404 : [404, 503]);
    ctx.assert.assertNoSecrets(r404File.text, [ctx.adminPassword, submittedApiKey], { forbidTokenKey: true });
  });

  test('T2-F15-03', 'Unauthenticated callers receive 401 on all protected device and admin endpoints', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const checks = [
      client.localStatus({ auth: false }),
      client.getLocalModel({ auth: false }),
      client.getDevice({ auth: false }),
      client.listFiles('11111111-1111-4111-8111-111111111111', { auth: false }),
      client.adminStatus(),
      client.listDevices(),
      client.adminListUpdates(),
    ];
    for (const p of checks) {
      ctx.assert.assertStatus(await p, 401);
    }
  });

  test('T2-F15-04', 'Admin CSRF/Origin enforcement (403) and adminLogout session cookie revocation (401)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    ctx.assert.assertStatus(await client.adminLogin(ctx.adminPassword, { csrf: false }), 403);
    ctx.assert.assertStatus(await client.adminLogin(ctx.adminPassword, { origin: 'https://evil.example' }), 403);

    ctx.assert.assertStatus(await client.adminLogin(ctx.adminPassword), 200);
    ctx.assert.assertStatus(await client.adminStatus(), 200);

    ctx.assert.assertStatus(await client.createPairingKey({ csrf: false }), 403);
    ctx.assert.assertStatus(await client.adminPublishUpdate({ platform: 'android', version: '1.0.0' }, { origin: 'https://evil.example' }), 403);
    ctx.assert.assertStatus(await client.adminDeleteUpdate('android', 'rel-1', { csrf: false }), 403);

    const logout = await client.adminLogout();
    ctx.assert.assertStatus(logout, 200);
    ctx.assert.equal(client.cookies.has('rokbot_admin'), false);
    ctx.assert.assertStatus(await client.adminStatus(), 401);
  });

  test('T2-F15-05', 'assertNoSecrets handles circular object graphs cleanly and detects secrets inside raw Buffers', async () => {
    const cleanCircular = { name: 'rokbot', nested: {} };
    cleanCircular.self = cleanCircular;
    cleanCircular.nested.parent = cleanCircular;
    ctx.assert.assertNoSecrets(cleanCircular, ['SecretNotPresent123'], { forbidTokenKey: true });

    const dirtyCircular = { name: 'rokbot', apiKey: 'circular-secret-key-val' };
    dirtyCircular.self = dirtyCircular;
    ctx.assert.throws(() => ctx.assert.assertNoSecrets(dirtyCircular), /Sensitive key "apiKey"/);

    const bufSecret = Buffer.from('payload with Bearer BuffTokenSecret123456 inside', 'utf8');
    ctx.assert.throws(() => ctx.assert.assertNoSecrets(bufSecret), /Leaked Bearer authorization token/);
  });
}
