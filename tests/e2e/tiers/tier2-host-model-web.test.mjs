export const tier = 2;
export const name = 'tier2-host-model-web';

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
  const cache = !pairOpts.forceNew ? getLiveCache(ctx) : null;
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
        deviceName: pairOpts.deviceName || 'Tier2 Host Device',
        platform: pairOpts.platform || 'desktop',
        ...(pairOpts.clientKind ? { clientKind: pairOpts.clientKind } : {}),
        ...(pairOpts.clientDeviceId ? { clientDeviceId: pairOpts.clientDeviceId } : {}),
      };
  const pairRes = await client.pairWithPassword(body);
  ctx.assert.assertStatus(pairRes, 201);
  if (cache) {
    cache.deviceToken = pairRes.json.token;
    cache.deviceId = pairRes.json.deviceId;
  }
  return pairRes.json;
}

async function ensureWebSession(ctx, client, t = null) {
  const cache = getLiveCache(ctx);
  if (cache?.webCookie) {
    client.cookies.set('rokbot_web', cache.webCookie);
    return { status: 200, ok: true, cached: true };
  }
  if (!ctx.harness) {
    const ws = await client.webSession();
    ctx.assert.assertStatus(ws, 200);
    if (ws.json?.available === false) {
      if (t) t.skip('Web client bundle is not installed on live Host');
      return { status: 409, ok: false, json: { available: false } };
    }
  }
  await ensureAdminSession(ctx, client);
  const openRes = await client.adminOpenWebClient({
    deviceName: 'RokBot E2E Shared Web',
    clientDeviceId: 'rokbot-e2e-shared-web',
  });
  if (!ctx.harness && openRes.status === 409) {
    if (t) t.skip('Web client bundle is not installed on live Host');
    return openRes;
  }
  ctx.assert.assertStatus(openRes, [200, 201]);
  if (cache) {
    const cookieVal = client.cookies.get('rokbot_web');
    if (cookieVal) cache.webCookie = cookieVal;
  }
  return openRes;
}

async function pairPasswordDevice(client, ctx, opts = {}) {
  return ensureDeviceSession(ctx, client, opts);
}

async function pairGuestDevice(client, ctx, deviceName = 'Tier2 Guest Device') {
  await ensureAdminSession(ctx, client);
  const keyRes = await client.createPairingKey();
  ctx.assert.assertStatus(keyRes, 201);
  const pair = await client.pairWithKey({
    pairingKey: keyRes.json.pairingKey,
    deviceName,
    platform: 'desktop',
  });
  ctx.assert.assertStatus(pair, 201);
  return pair.json;
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F4 — Host & Box Upgrade (2bb5e41) & Core Runtime (T2-F04-01..06)
  // =========================================================================

  test('T2-F04-01', 'Admin-only RPCs and connector mutation return 403 for device Bearer clients', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);

    const r1 = await client.apiCall('importLocalSharedBot', { name: 'forbidden' });
    ctx.assert.assertStatus(r1, 403);

    const r2 = await client.apiCall('localApplicationRpc', { action: 'restart' });
    ctx.assert.assertStatus(r2, 403);

    const r3 = await client.request('POST', '/local/connectors', { body: { id: 'github', enabled: false } });
    ctx.assert.assertStatus(r3, 403);
  });

  test('T2-F04-02', 'ExternalShell localExec rejects ambiguous multi-machine (409) and offline/missing target (404)', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);

    ctx.harness.setDefaultMachineId('');
    ctx.harness.setComputers([
      { id: 'm-online-1', label: 'Mac 1', connected: true, platform: 'darwin', capabilities: ['exec'] },
      { id: 'm-online-2', label: 'Win 2', connected: true, platform: 'win32', capabilities: ['exec'] },
      { id: 'm-offline-3', label: 'Linux 3', connected: false, platform: 'linux', capabilities: ['exec'] },
    ]);

    const ambiguous = await client.apiCall('localExec', { command: 'whoami' });
    ctx.assert.assertStatus(ambiguous, 409);

    const offline = await client.apiCall('localExec', { computerId: 'm-offline-3', command: 'whoami' });
    ctx.assert.assertStatus(offline, 404);

    const unknown = await client.apiCall('localExec', { computerId: 'does-not-exist', command: 'whoami' });
    ctx.assert.assertStatus(unknown, 404);
  });

  test('T2-F04-03', 'sendPrompt returns 409 when needsModel is true', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    ctx.harness.setNeedsModel(true);

    const res = await client.apiCall('sendPrompt', { prompt: 'hello' });
    ctx.assert.assertStatus(res, 409);
    ctx.assert.match(String(res.json?.error || ''), /Model/i);
  });

  test('T2-F04-04', 'Library /local/files rejects path traversal (400), unknown agent (404), >20 MiB (413) & missing file (404)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    const created = await client.apiCall('createAgent', { name: 'File Boundary Bot' });
    ctx.assert.assertStatus(created, 200);
    const agentId = created.json.id;
    t.after(async () => {
      await client.apiCall('deleteAgents', { ids: [agentId] }).catch(() => {});
    });

    for (const badName of ['../secret.txt', 'sub/file.txt', 'a\\b.txt', '']) {
      const res = await client.uploadFile({
        agentId,
        fileName: badName,
        base64: Buffer.from('x').toString('base64'),
        contentType: 'text/plain',
      });
      ctx.assert.assertStatus(res, 400, `Expected 400 for fileName=${JSON.stringify(badName)}`);
    }

    const badAgent = await client.uploadFile({
      agentId: '99999999-9999-4999-8999-999999999999',
      fileName: 'ok.txt',
      base64: Buffer.from('ok').toString('base64'),
      contentType: 'text/plain',
    });
    ctx.assert.assertStatus(badAgent, 404);

    // >20 MiB decoded file payload (base64.length > Math.ceil(20 MiB / 3) * 4)
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 3, 0x61);
    const overRes = await client.uploadFile({
      agentId,
      fileName: 'huge.bin',
      base64: oversized.toString('base64'),
      contentType: 'application/octet-stream',
    });
    ctx.assert.assertStatus(overRes, 413);

    const missingContent = await client.getFileContent(agentId, 'missing.txt');
    ctx.assert.assertStatus(missingContent, 404);
  });

  test('T2-F04-05', '/connect/attachment enforces file:// scheme (400), agents/ sandbox (403), media allowlist (415) & existence (404)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);

    const nonFile = await client.readAttachment('https://example.com/a.png');
    ctx.assert.assertStatus(nonFile, 400);

    const outside = await client.readAttachment('file:///etc/passwd');
    ctx.assert.assertStatus(outside, 403);

    if (ctx.harness) {
      const agentsRes = await client.apiCall('listAgents');
      ctx.assert.assertStatus(agentsRes, 200);
      const agentId = agentsRes.json[0].id;

      const txtUrl = await ctx.harness.seedAttachment(agentId, 'note.txt', Buffer.from('plain text'));
      const txtRes = await client.readAttachment(txtUrl);
      ctx.assert.assertStatus(txtRes, 415);

      const svgUrl = await ctx.harness.seedAttachment(agentId, 'vector.svg', Buffer.from('<svg/>'));
      const svgRes = await client.readAttachment(svgUrl);
      ctx.assert.assertStatus(svgRes, 415);

      const missingUrl = txtUrl.replace('note.txt', 'does-not-exist.png');
      const missingRes = await client.readAttachment(missingUrl);
      ctx.assert.assertStatus(missingRes, 404);
    }
  });

  test('T2-F04-06', 'Unauthenticated and malformed Bearer requests are rejected with 401 across device routes & /events SSE', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    for (const bearerOpt of [null, 'invalid-short', 'invalid-bearer-token-1234567890']) {
      ctx.assert.assertStatus(await client.getComputers({ bearer: bearerOpt }), 401);
      ctx.assert.assertStatus(await client.listFiles('11111111-1111-4111-8111-111111111111', { bearer: bearerOpt }), 401);
      ctx.assert.assertStatus(await client.getVoiceStatus({ bearer: bearerOpt }), 401);
      ctx.assert.assertStatus(await client.listConnectors({ bearer: bearerOpt }), 401);
    }

    await ctx.assert.rejects(
      () => client.openSse('/events', { headers: { authorization: 'Bearer bogus-token-1234567890' } }),
      /SSE connect failed \(401\)/,
    );
  });

  // =========================================================================
  // Feature F5 — Host In-App Model Config & Onboarding API (T2-F05-01..06)
  // =========================================================================

  test('T2-F05-01', 'Guest device blocked (403) on /local/model* unless valid x-rokbot-admin-password or allowGuestModelConfig', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation & guest model policy hooks');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairGuestDevice(client, ctx, 'Guest Phone');

    ctx.assert.assertStatus(await client.getLocalModel(), 403);
    ctx.assert.assertStatus(
      await client.putLocalModel({
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-guest-blocked-123456',
      }),
      403,
    );
    ctx.assert.assertStatus(await client.probeModelCatalog({ apiKey: 'sk-guest-blocked-123456' }), 403);
    ctx.assert.assertStatus(await client.testModel({ model: 'gpt-4o', apiKey: 'sk-guest-blocked-123456' }), 403);

    // Wrong step-up admin password stays 403
    ctx.assert.assertStatus(await client.getLocalModel({ adminPassword: 'WrongPassword!99' }), 403);

    // Valid step-up header unlocks guest device
    const stepUpGet = await client.getLocalModel({ adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(stepUpGet, 200);

    if (ctx.harness) {
      ctx.harness.setModelAuthPolicy({ allowGuestModelConfig: true });
      const policyUnlocked = await client.getLocalModel();
      ctx.assert.assertStatus(policyUnlocked, 200);
    }
  });

  test('T2-F05-02', 'Host-level allowDeviceModelConfig=false / allowEnv=false disables /local/model even for password-paired devices', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);

    ctx.harness.setModelAuthPolicy({ allowDeviceModelConfig: false });
    const st1 = await client.localStatus();
    ctx.assert.assertStatus(st1, 200);
    ctx.assert.equal(st1.json.canConfigureModel, false);
    ctx.assert.assertStatus(await client.getLocalModel({ adminPassword: ctx.adminPassword }), 403);

    ctx.harness.setModelAuthPolicy({ allowDeviceModelConfig: true, allowEnv: false });
    const st2 = await client.localStatus();
    ctx.assert.assertStatus(st2, 200);
    ctx.assert.equal(st2.json.canConfigureModel, false);
    ctx.assert.assertStatus(await client.putLocalModel({ model: 'gpt-4o' }, { adminPassword: ctx.adminPassword }), 403);
  });

  test('T2-F05-03', 'PUT /local/model rejects invalid baseUrl schemes, credentials, query, fragment, newlines & unknown apiFormat', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    if (!ctx.harness) {
      const loc = await client.localStatus();
      ctx.assert.assertStatus(loc, 200);
      if (loc.json?.pairedWith === 'pairing-key' || !loc.json?.canConfigureModel) {
        t.skip('Live Host device lacks unconditional model config permission (canConfigureModel=false or pairing-key)');
      }
    }

    const badUrls = [
      '',
      '   ',
      'ftp://api.openai.com/v1',
      'https://user:pass@api.openai.com/v1',
      'https://api.openai.com/v1?q=1',
      'https://api.openai.com/v1#frag',
      'https://api.openai.com/v1\nX-Injected: 1',
    ];
    for (const badUrl of badUrls) {
      const res = await client.putLocalModel(
        {
          apiFormat: 'openai',
          baseUrl: badUrl,
          model: 'gpt-4o',
          apiKey: 'sk-valid-shape-1234567890',
        },
        { adminPassword: ctx.adminPassword },
      );
      ctx.assert.assertStatus(res, 400, `Expected 400 for baseUrl=${JSON.stringify(badUrl)}`);
    }

    const badFmt = await client.putLocalModel(
      {
        apiFormat: 'bedrock',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-valid-shape-1234567890',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(badFmt, 400);
  });

  test('T2-F05-04', 'PUT /local/model rejects missing initial apiKey, empty model, empty providers/profiles & unknown providerId', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    if (ctx.harness) {
      ctx.harness.setNeedsModel(true);
    } else {
      const loc = await client.localStatus();
      ctx.assert.assertStatus(loc, 200);
      if (loc.json?.pairedWith === 'pairing-key' || !loc.json?.canConfigureModel) {
        t.skip('Live Host device lacks unconditional model config permission (canConfigureModel=false or pairing-key)');
      }
    }

    // No prior key exists when needsModel === true
    if (ctx.harness) {
      const noKey = await client.putLocalModel(
        { apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
        { adminPassword: ctx.adminPassword },
      );
      ctx.assert.assertStatus(noKey, 400);
    }

    const emptyModel = await client.putLocalModel(
      { apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', model: '   ', apiKey: 'sk-test-1234567890abcdef' },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(emptyModel, 400);

    const emptyProv = await client.putLocalModel(
      {
        version: 1,
        migrateLegacyRouting: true,
        providers: [],
        profiles: [{ id: 'p1', name: 'Prof 1', providerId: 'x', model: 'gpt-4o' }],
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(emptyProv, 400);

    const emptyProf = await client.putLocalModel(
      {
        version: 1,
        migrateLegacyRouting: true,
        providers: [{ id: 'p1', name: 'P1', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-1234567890abcdef' }],
        profiles: [],
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(emptyProf, 400);

    const unknownProv = await client.putLocalModel(
      {
        version: 1,
        migrateLegacyRouting: true,
        providers: [{ id: 'p1', name: 'P1', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test-1234567890abcdef' }],
        profiles: [{ id: 'prof1', name: 'Prof 1', providerId: 'missing-prov', model: 'gpt-4o' }],
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(unknownProv, 400);
  });

  test('T2-F05-05', '/local/model/catalog & /local/model/test propagate upstream faults (502/503) and reject missing credentials (400)', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    ctx.harness.setNeedsModel(true);

    // Missing both supplied & saved apiKey -> 400
    ctx.assert.assertStatus(await client.probeModelCatalog({ baseUrl: 'https://api.openai.com/v1' }), 400);
    ctx.assert.assertStatus(await client.testModel({ model: 'gpt-4o' }), 400);

    // Upstream faults -> 502 / 503
    ctx.harness.seedUpstreamCatalog(null, { status: 502, message: 'Upstream catalog unreachable' });
    const catErr = await client.probeModelCatalog({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-probe-fault-12345678',
    });
    ctx.assert.assertStatus(catErr, 502);

    ctx.harness.setModelTestFault({ status: 503, message: 'Upstream model test timeout' });
    const testErr = await client.testModel({
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-probe-fault-12345678',
    });
    ctx.assert.assertStatus(testErr, 503);
  });

  test('T2-F05-06', 'PUT /local/model reports reload.status === "error" and diagnostic message on reload failure', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx);
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await pairPasswordDevice(client, ctx);
    ctx.harness.setModelReloadBehavior({ mode: 'error' });

    const res = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
        apiKey: 'sk-reload-err-12345678',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(res, 200);
    ctx.assert.equal(res.json.reload.status, 'error');
    ctx.assert.ok(typeof res.json.reload.error === 'string' && res.json.reload.error.length > 0);
  });

  // =========================================================================
  // Feature F9 — Web Client 1.2.3 Upgrade, Logo & Model UI (T2-F09-01..05)
  // =========================================================================

  test('T2-F09-01', 'Missing x-rokbot-web: 1 header rejected with 403 on /web/api/* and cookie-authenticated device routes', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureAdminSession(ctx, client);
    let pairingKey = 'DUMMY1';
    if (ctx.harness) {
      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      pairingKey = keyRes.json.pairingKey;
    }

    const pairNoHdr = await client.request('POST', '/web/api/pair', {
      auth: false,
      web: false,
      webHeader: false,
      body: { pairingKey, deviceName: 'NoHdr' },
    });
    ctx.assert.assertStatus(pairNoHdr, 403);

    // Pair validly to obtain rokbot_web cookie, then strip x-rokbot-web
    if (ctx.harness) {
      const pairOk = await client.webPair({ pairingKey, deviceName: 'ValidWeb' });
      ctx.assert.assertStatus(pairOk, 201);
    } else {
      await ensureWebSession(ctx, client, t);
    }

    ctx.assert.assertStatus(await client.localStatus({ bearer: null, webHeader: false }), 403);
    ctx.assert.assertStatus(await client.apiCall('listAgents', {}, { bearer: null, webHeader: false }), 403);

    const logoutNoHdr = await client.request('POST', '/web/api/logout', {
      auth: false,
      web: false,
      webHeader: false,
      body: {},
    });
    ctx.assert.assertStatus(logoutNoHdr, 403);
  });

  test('T2-F09-02', 'Cross-origin Origin: https://evil.example rejected with 403 on Web pair, logout & session APIs', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureAdminSession(ctx, client);
    let pairingKey = 'DUMMY1';
    if (ctx.harness) {
      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      pairingKey = keyRes.json.pairingKey;
    }

    const evilHeaders = { origin: 'https://evil.example', 'x-rokbot-web': '1' };
    const evilPair = await client.request('POST', '/web/api/pair', {
      auth: false,
      headers: evilHeaders,
      body: { pairingKey, deviceName: 'EvilOrigin' },
    });
    ctx.assert.assertStatus(evilPair, 403);

    if (ctx.harness) {
      const okPair = await client.webPair({ pairingKey, deviceName: 'LegitWeb' });
      ctx.assert.assertStatus(okPair, 201);
    } else {
      await ensureWebSession(ctx, client, t);
    }

    const evilStatus = await client.localStatus({ bearer: null, headers: evilHeaders });
    ctx.assert.assertStatus(evilStatus, 403);

    const evilLogout = await client.request('POST', '/web/api/logout', {
      auth: false,
      headers: evilHeaders,
      body: {},
    });
    ctx.assert.assertStatus(evilLogout, 403);
  });

  test('T2-F09-03', 'webClientAvailable === false disables manifest, web pairing, admin web open & existing web cookies', async (t) => {
    if (!ctx.harness) t.skip('Requires harness fault injection');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureAdminSession(ctx, client);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const okPair = await client.webPair({ pairingKey: keyRes.json.pairingKey, deviceName: 'PreDisableWeb' });
    ctx.assert.assertStatus(okPair, 201);

    ctx.harness.setWebClientAvailable(false);

    ctx.assert.assertStatus(await client.getWebManifest(), 404);
    const keyRes2 = await client.createPairingKey();
    ctx.assert.assertStatus(await client.webPair({ pairingKey: keyRes2.json.pairingKey, deviceName: 'DisabledWeb' }), 404);
    ctx.assert.assertStatus(await client.adminOpenWebClient(), [404, 409]);
    ctx.assert.assertStatus(await client.localStatus({ bearer: null }), 403);
  });

  test('T2-F09-04', 'Web pairing rejects invalid/reused pairingKey (401), bad deviceName (400) & member federationRole (403)', async (t) => {
    if (!ctx.harness) t.skip('Requires harness rate-limit isolation for consecutive /web/api/pair validation');
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    await ensureAdminSession(ctx, client);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);
    const pk = keyRes.json.pairingKey;

    ctx.assert.assertStatus(await client.webPair({ pairingKey: 'BOGUS1', deviceName: 'Web 1' }), 401);
    ctx.assert.assertStatus(await client.webPair({ pairingKey: pk, deviceName: '' }), 400);
    ctx.assert.assertStatus(await client.webPair({ pairingKey: pk, deviceName: 'x'.repeat(81) }), 400);

    // Consume key once, then reuse
    ctx.assert.assertStatus(await client.webPair({ pairingKey: pk, deviceName: 'Web First' }), 201);
    ctx.assert.assertStatus(await client.webPair({ pairingKey: pk, deviceName: 'Web Reuse' }), 401);

    if (ctx.harness) {
      ctx.harness.setFederationRole('member');
      const keyRes2 = await client.createPairingKey();
      ctx.assert.assertStatus(await client.webPair({ pairingKey: keyRes2.json.pairingKey, deviceName: 'Member Web' }), 403);
    }
  });

  test('T2-F09-05', 'POST /admin/api/web-client/open requires admin session (401) and x-rokbot-csrf: 1 (403)', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    // Unauthenticated with CSRF -> 401
    ctx.assert.assertStatus(await client.adminOpenWebClient(), 401);

    // Logged in without CSRF -> 403
    await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(await client.adminOpenWebClient({}, { csrf: false }), 403);
  });
}
