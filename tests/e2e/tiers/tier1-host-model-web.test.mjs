import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const tier = 1;
export const name = 'tier1-host-model-web';

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

async function ensurePasswordPairedClient(ctx, t, { deviceName = 'Tier1 Device', platform = 'desktop', clientKind } = {}) {
  const client = createClient(ctx);
  t.after(async () => {
    await client.close();
    await resetHarnessState(ctx);
  });

  await ensureDeviceSession(ctx, client, { deviceName, platform, clientKind });
  return client;
}

export function registerTests(test, ctx) {
  // =========================================================================
  // Feature F4: Host & Box Upgrade (2bb5e41) & Core Runtime (T1-F04-01..06)
  // =========================================================================

  test('T1-F04-01', 'Health, local status & host settings metadata (/health, /healthz, /local/status, getHostSettings)', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 Status Probe' });

    const health = await client.health();
    ctx.assert.assertStatus(health, 200);
    ctx.assert.equal(health.json?.ok, true);
    ctx.assert.equal(typeof health.json?.initialized, 'boolean');

    const healthz = await client.request('GET', '/healthz', { auth: false });
    ctx.assert.assertStatus(healthz, 200);
    ctx.assert.equal(healthz.json?.ok, true);

    const status = await client.localStatus();
    ctx.assert.assertStatus(status, 200);
    ctx.assert.assertJsonSchema(status.json, {
      ok: 'boolean',
      initialized: 'boolean',
      needsModel: 'boolean',
      canConfigureModel: 'boolean',
      hostVersion: 'string',
    });
    ctx.assert.equal(status.json.brand, 'RokBot');
    if (ctx.harness) {
      ctx.assert.equal(status.json.hostVersion, '2bb5e41');
    } else {
      ctx.assert.ok(typeof status.json.hostVersion === 'string' && status.json.hostVersion.length > 0);
    }

    const settings = await client.apiCall('getHostSettings');
    ctx.assert.assertStatus(settings, 200);
    if (ctx.harness) {
      ctx.assert.equal(settings.json?.brand, 'RokBot');
      ctx.assert.equal(settings.json?.hostVersion, '2bb5e41');
    } else if (settings.json?.hostVersion !== undefined) {
      ctx.assert.ok(typeof settings.json.hostVersion === 'string' && settings.json.hostVersion.length > 0);
    }
  });

  test('T1-F04-02', 'Bot agent CRUD lifecycle (createAgent -> listAgents -> deleteAgents cleans files)', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 Agent CRUD' });

    const created = await client.apiCall('createAgent', { name: 'RokBot Tier1 Agent' });
    ctx.assert.assertStatus(created, 200);
    const agentId = created.json?.id;
    ctx.assert.ok(typeof agentId === 'string' && agentId.length > 0);
    t.after(() => client.apiCall('deleteAgents', { ids: [agentId] }).catch(() => {}));
    ctx.assert.equal(created.json.name, 'RokBot Tier1 Agent');

    const list1 = await client.apiCall('listAgents');
    ctx.assert.assertStatus(list1, 200);
    ctx.assert.ok(Array.isArray(list1.json));
    ctx.assert.ok(list1.json.some((a) => a.id === agentId));

    const up = await client.uploadFile({
      agentId,
      fileName: 'scratch.txt',
      base64: Buffer.from('agent-scoped-file').toString('base64'),
      contentType: 'text/plain',
    });
    ctx.assert.assertStatus(up, 200);

    const del = await client.apiCall('deleteAgents', { ids: [agentId] });
    ctx.assert.assertStatus(del, 200);
    if (ctx.harness || del.json?.ok !== undefined) {
      ctx.assert.equal(del.json?.ok, true);
    }

    const list2 = await client.apiCall('listAgents');
    ctx.assert.assertStatus(list2, 200);
    ctx.assert.equal(list2.json.some((a) => a.id === agentId), false);

    const filesAfter = await client.listFiles(agentId);
    ctx.assert.assertStatus(filesAfter, 404);
  });

  test('T1-F04-03', 'Streaming chat prompt and /events SSE lifecycle (agent-chunk & agent-done)', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 SSE Client' });

    let liveAgentId = null;
    if (!ctx.harness) {
      const loc = await client.localStatus();
      ctx.assert.assertStatus(loc, 200);
      if (loc.json?.needsModel) {
        t.skip('Live Host has needsModel=true; skipping live sendPrompt');
      }
      const created = await client.apiCall('createAgent', { name: 'SSE Tier1 Bot', description: '' });
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
    ctx.assert.equal(sse.status, 200);
    ctx.assert.ok((sse.headers.get('content-type') || '').includes('text/event-stream'));

    const promptBody = ctx.harness
      ? { prompt: 'hello-tier1' }
      : { agentId: liveAgentId, clientNonce: randomUUID(), prompt: 'Reply with OK.', directAddressedAcceptance: true };
    const promptRes = await client.apiCall('sendPrompt', promptBody);
    ctx.assert.assertStatus(promptRes, 200);

    if (ctx.harness) {
      ctx.assert.assertJsonSchema(promptRes.json, {
        ok: 'boolean',
        runId: 'string',
        agentId: 'string',
        model: 'string',
      });

      const chunkEv = await sse.nextEvent(
        (ev) => ev.data?.channel === 'agent-chunk' && ev.data?.payload?.runId === promptRes.json.runId,
        3000,
      );
      ctx.assert.ok(typeof chunkEv.data.payload.delta === 'string');

      const doneEv = await sse.nextEvent(
        (ev) => ev.data?.channel === 'agent-done' && ev.data?.payload?.runId === promptRes.json.runId,
        3000,
      );
      ctx.assert.equal(doneEv.data.payload.reply, 'OK: hello-tier1');
      ctx.assert.ok(sse.comments.includes('connected'));
    } else {
      ctx.assert.ok(promptRes.json?.accepted === true || typeof promptRes.json?.runId === 'string');
      const liveEv = await sse.nextEvent(
        (ev) => ['agent-done', 'transcript', 'agent-upserted', 'agents'].includes(ev.data?.channel),
        15000,
      );
      ctx.assert.ok(liveEv && liveEv.data?.channel);
    }
  });

  test('T1-F04-04', 'ExternalShell default machine routing and explicit computerId selection', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 Routing Client' });

    if (ctx.harness) {
      ctx.harness.setComputers([
        { id: 'mac-primary-01', name: 'Mac Primary', connected: true, platform: 'macos' },
        { id: 'win-secondary-02', name: 'Win Secondary', connected: true, platform: 'windows' },
      ]);
      ctx.harness.setDefaultMachineId('mac-primary-01');
    }

    const compRes = await client.getComputers();
    ctx.assert.assertStatus(compRes, 200);
    if (!ctx.harness && (!compRes.json?.available || !Array.isArray(compRes.json?.computers) || compRes.json.computers.length === 0)) {
      t.skip('No ExternalShell computer connected on live Host');
    }
    ctx.assert.equal(compRes.json?.available, true);
    ctx.assert.ok(Array.isArray(compRes.json?.computers) && compRes.json.computers.length >= 1);

    if (ctx.harness) {
      const implicitRes = await client.apiCall('localExec', { command: 'pwd' });
      ctx.assert.assertStatus(implicitRes, 200);
      ctx.assert.equal(implicitRes.json.machineId, 'mac-primary-01');

      const explicitRes = await client.apiCall('localExec', { computerId: 'win-secondary-02', command: 'ver' });
      ctx.assert.assertStatus(explicitRes, 200);
      ctx.assert.equal(explicitRes.json.machineId, 'win-secondary-02');
    }
  });

  test('T1-F04-05', 'Library file CRUD & sandboxed download headers (GET/POST/DELETE /local/files)', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 Files Client' });

    const created = await client.apiCall('createAgent', { name: 'Files Bot' });
    ctx.assert.assertStatus(created, 200);
    const agentId = created.json.id;
    t.after(() => client.apiCall('deleteAgents', { ids: [agentId] }).catch(() => {}));

    const payload = Buffer.from('RokBot library payload 🚀\nline2', 'utf8');
    const up = await client.uploadFile({
      agentId,
      fileName: 'notes.txt',
      base64: payload.toString('base64'),
      contentType: 'text/plain; charset=utf-8',
    });
    ctx.assert.assertStatus(up, 200);
    ctx.assert.equal(up.json.name, 'notes.txt');
    ctx.assert.equal(up.json.sizeBytes, payload.length);
    ctx.assert.equal(String(up.json.etag || '').replace(/^sha256:/i, ''), ctx.cryptoDelta.sha256Hex(payload));

    const list = await client.listFiles(agentId);
    ctx.assert.assertStatus(list, 200);
    ctx.assert.equal(list.json.canEdit, true);
    ctx.assert.ok(list.json.files.some((f) => f.name === 'notes.txt' && f.sizeBytes === payload.length));

    const dl = await client.getFileContent(agentId, 'notes.txt');
    ctx.assert.assertStatus(dl, 200);
    ctx.assert.equal(dl.buffer.equals(payload), true);
    ctx.assert.ok((dl.headers.get('content-disposition') || '').includes('attachment'));
    ctx.assert.equal(dl.headers.get('content-security-policy'), "default-src 'none'; sandbox");

    const del = await client.deleteFile({ agentId, name: 'notes.txt' });
    ctx.assert.assertStatus(del, 200);
    ctx.assert.equal(del.json?.ok, true);

    const listAfter = await client.listFiles(agentId);
    ctx.assert.assertStatus(listAfter, 200);
    ctx.assert.equal(listAfter.json.files.length, 0);
  });

  test('T1-F04-06', 'Attachments dataUrl conversion, voice status & connectors discovery', async (t) => {
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F04 Capabilities Client' });

    if (ctx.harness) {
      const agents = await client.apiCall('listAgents');
      ctx.assert.assertStatus(agents, 200);
      const agentId = agents.json[0].id;
      const samplePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01, 0x02]);
      const fileUrl = await ctx.harness.seedAttachment(agentId, 'preview.png', samplePng);
      const att = await client.readAttachment(fileUrl);
      ctx.assert.assertStatus(att, 200);
      ctx.assert.equal(att.json.dataUrl, `data:image/png;base64,${samplePng.toString('base64')}`);
    }

    const voice = await client.getVoiceStatus();
    ctx.assert.assertStatus(voice, 200);
    ctx.assert.equal(typeof voice.json?.enabled, 'boolean');

    const conn = await client.listConnectors();
    ctx.assert.assertStatus(conn, 200);
    ctx.assert.ok(Array.isArray(conn.json?.connectors));
    ctx.assert.equal(typeof conn.json?.redirectUri, 'string');
  });

  // =========================================================================
  // Feature F5: Host In-App Model Config & Onboarding API (T1-F05-01..06)
  // =========================================================================

  test('T1-F05-01', 'Public /connect/status and device /local/status onboarding flags reflect needsModel', async (t) => {
    if (ctx.harness) {
      await resetHarnessState(ctx);
      ctx.harness.setNeedsModel(true);
    }
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Onboarding Probe' });

    const pub = await client.connectStatus({ auth: false });
    ctx.assert.assertStatus(pub, 200);
    ctx.assert.equal(pub.json.ok, true);
    ctx.assert.equal(pub.json.brand, 'RokBot');
    ctx.assert.equal(typeof pub.json.needsModel, 'boolean');
    if (ctx.harness) ctx.assert.equal(pub.json.needsModel, true);
    ctx.assert.assertNoSecrets(pub.json, [ctx.adminPassword], { forbidTokenKey: true });

    const loc = await client.localStatus();
    ctx.assert.assertStatus(loc, 200);
    ctx.assert.equal(typeof loc.json.canConfigureModel, 'boolean');
    if (ctx.harness) {
      ctx.assert.equal(loc.json.canConfigureModel, true);
      ctx.assert.equal(loc.json.needsModel, true);
    } else if (ctx.adminPassword) {
      await ensureAdminSession(ctx, client);
      const adminSt = await client.adminStatus();
      const dp = adminSt.status === 200 ? adminSt.json?.model?.devicePolicy : null;
      if (dp) {
        if (dp.envAllowed === false || dp.allowDeviceModelConfig === false) {
          ctx.assert.equal(loc.json.canConfigureModel, false);
        } else if (loc.json.pairedWith === 'password' || loc.json.pairedWith === 'admin-web' || !ctx.deviceToken) {
          ctx.assert.equal(loc.json.canConfigureModel, true);
        } else if (loc.json.pairedWith === 'pairing-key') {
          ctx.assert.equal(loc.json.canConfigureModel, Boolean(dp.allowGuestModelConfig));
        }
      }
    }
  });

  test('T1-F05-02', 'Legacy single-provider PUT /local/model + GET /local/model strips apiKey & clears needsModel', async (t) => {
    if (!ctx.harness) t.skip('Requires isolated harness to avoid mutating live Host /data/model.env or dialing OpenAI');
    await resetHarnessState(ctx);
    ctx.harness.setNeedsModel(true);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Legacy Model Client' });
    const secretKey = 'sk-tier1-legacy-secret-1111';

    const putRes = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        apiKey: secretKey,
        contextWindowTokens: 200000,
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(putRes, 200);
    ctx.assert.equal(putRes.json.ok, true);
    ctx.assert.equal(putRes.json.reload.status, 'applied');
    ctx.assert.assertNoSecrets(putRes.json, [secretKey, ctx.adminPassword], { forbidTokenKey: true });

    const getRes = await client.getLocalModel({ adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(getRes, 200);
    ctx.assert.equal(getRes.json.canConfigureModel, true);
    ctx.assert.equal(getRes.json.config.providers[0].hasApiKey, true);
    ctx.assert.equal(getRes.json.config.providers[0].apiKey, undefined);
    ctx.assert.equal(getRes.json.config.profiles[0].model, 'gpt-4.1');
    ctx.assert.assertNoSecrets(getRes.json, [secretKey, ctx.adminPassword], { forbidTokenKey: true });

    const loc = await client.localStatus();
    ctx.assert.assertStatus(loc, 200);
    ctx.assert.equal(loc.json.needsModel, false);
  });

  test('T1-F05-03', 'Multi-provider v1 PUT /local/model (openai + anthropic, botRoutes, defaultRoute)', async (t) => {
    if (!ctx.harness) t.skip('Requires isolated harness to avoid mutating live Host /data/model.env or dialing OpenAI');
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Multi-Provider' });

    const key1 = 'sk-tier1-openai-2222';
    const key2 = 'sk-ant-tier1-anthropic-3333';
    const putRes = await client.putLocalModel(
      {
        version: 1,
        providers: [
          { id: 'prov-oai', name: 'OpenAI', apiFormat: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: key1 },
          { id: 'prov-ant', name: 'Anthropic', apiFormat: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: key2 },
        ],
        profiles: [
          { id: 'fast', name: 'Fast', providerId: 'prov-oai', model: 'gpt-4o-mini', contextWindowTokens: 128000 },
          { id: 'deep', name: 'Deep', providerId: 'prov-ant', model: 'claude-sonnet-4', contextWindowTokens: 200000 },
        ],
        defaultRoute: { profileId: 'fast', effort: 'medium', fallbacks: [{ profileId: 'deep', effort: 'default' }] },
        botRoutes: { 'bot-alpha': { profileId: 'deep', effort: 'high' } },
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(putRes, 200);
    ctx.assert.assertNoSecrets(putRes.json, [key1, key2], { forbidTokenKey: true });

    const getRes = await client.getLocalModel({ adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(getRes, 200);
    ctx.assert.equal(getRes.json.config.providers.length, 2);
    ctx.assert.equal(getRes.json.config.profiles.length, 2);
    ctx.assert.equal(getRes.json.config.defaultRoute.profileId, 'fast');
    ctx.assert.equal(getRes.json.config.botRoutes['bot-alpha'].profileId, 'deep');
    ctx.assert.equal(getRes.json.config.providers.every((p) => p.hasApiKey === true && p.apiKey === undefined), true);
  });

  test('T1-F05-04', 'PUT /local/model preserves existing apiKey when omitted or empty string', async (t) => {
    if (!ctx.harness) t.skip('Requires isolated harness to avoid mutating live Host /data/model.env or dialing OpenAI');
    await resetHarnessState(ctx);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Key Preservation' });

    const initialKey = 'sk-tier1-initial-4444';
    const save1 = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        apiKey: initialKey,
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(save1, 200);

    // Omitting apiKey preserves stored key
    const save2 = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(save2, 200);
    ctx.assert.equal(save2.json.config.providers[0].hasApiKey, true);
    ctx.assert.equal(save2.json.config.profiles[0].model, 'gpt-4o');

    // Verify preserved key remains functionally usable on /local/model/test
    const testAfterOmit = await client.testModel({}, { adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(testAfterOmit, 200);
    ctx.assert.equal(testAfterOmit.json.ok, true);
    ctx.assert.equal(testAfterOmit.json.reply, 'OK');

    // Empty/whitespace apiKey also preserves stored key
    const save3 = await client.putLocalModel(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4.1',
        apiKey: '   ',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(save3, 200);
    ctx.assert.equal(save3.json.config.providers[0].hasApiKey, true);
    ctx.assert.equal(save3.json.config.profiles[0].model, 'gpt-4.1');
    ctx.assert.assertNoSecrets(save3.json, [initialKey], { forbidTokenKey: true });

    const testAfterBlank = await client.testModel({}, { adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(testAfterBlank, 200);
    ctx.assert.equal(testAfterBlank.json.ok, true);
    ctx.assert.equal(testAfterBlank.json.reply, 'OK');
  });

  test('T1-F05-05', 'POST /local/model/catalog and POST /local/model/test with explicit & saved credentials', async (t) => {
    if (!ctx.harness) t.skip('Requires isolated harness to avoid mutating live Host /data/model.env or dialing OpenAI');
    await resetHarnessState(ctx);
    ctx.harness.seedUpstreamCatalog([
      { id: 'gpt-4o', owned_by: 'openai' },
      { id: 'gpt-4.1', owned_by: 'openai' },
    ]);
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Probe & Test' });

    const catExplicit = await client.probeModelCatalog(
      {
        apiFormat: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-tier1-probe-5555',
      },
      { adminPassword: ctx.adminPassword },
    );
    ctx.assert.assertStatus(catExplicit, 200);
    ctx.assert.equal(catExplicit.json.ok, true);
    ctx.assert.ok(Array.isArray(catExplicit.json.models) && catExplicit.json.models.length >= 1);

    const testSaved = await client.testModel({ model: 'gpt-4o' }, { adminPassword: ctx.adminPassword });
    ctx.assert.assertStatus(testSaved, 200);
    ctx.assert.equal(testSaved.json.ok, true);
    ctx.assert.equal(typeof testSaved.json.latencyMs, 'number');
    ctx.assert.equal(testSaved.json.reply, 'OK');
    ctx.assert.equal(testSaved.json.model, 'gpt-4o');
  });

  test('T1-F05-06', 'Model reload state transition (waiting -> applied) after PUT /local/model', async (t) => {
    if (!ctx.harness) t.skip('Requires harness reload-state simulation');
    await resetHarnessState(ctx);
    ctx.harness.setModelReloadBehavior({ mode: 'waiting-then-applied', delayMs: 40 });
    const client = await ensurePasswordPairedClient(ctx, t, { deviceName: 'F05 Reload State' });

    const putRes = await client.putLocalModel({
      apiFormat: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      apiKey: 'sk-tier1-reload-6666',
    });
    ctx.assert.assertStatus(putRes, 200);
    ctx.assert.equal(putRes.json.reload.status, 'waiting');
    const rev = putRes.json.reload.revision;

    let applied = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const check = await client.getLocalModel();
      ctx.assert.assertStatus(check, 200);
      if (check.json.reload.revision === rev && check.json.reload.status === 'applied') {
        applied = check.json.reload;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    ctx.assert.ok(applied, 'Reload status should transition from waiting to applied');
    ctx.assert.equal(applied.error, null);
  });

  // =========================================================================
  // Feature F9: Web Client 1.2.3 Upgrade, Logo & Model UI (T1-F09-01..05)
  // =========================================================================

  test('T1-F09-01', 'GET /web/manifest.webmanifest returns RokBot PWA metadata & /rokbot-icon.png', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const res = await client.getWebManifest();
    if (!ctx.harness && res.status === 404) {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      if (ws.json?.available === false) {
        t.skip('Web client bundle is not installed on live Host');
      }
    }
    ctx.assert.assertStatus(res, 200);
    ctx.assert.ok((res.headers.get('content-type') || '').includes('application/manifest+json'));
    ctx.assert.equal(res.json.name, 'RokBot');
    ctx.assert.equal(res.json.short_name, 'RokBot');
    ctx.assert.equal(res.json.start_url, '/web/');
    ctx.assert.equal(res.json.scope, '/web/');
    const allowedIcons = ctx.harness
      ? ['/rokbot-icon.png']
      : ['/rokbot-icon.png', '/web/client/icon.png', '/web/client/icon-512.png'];
    ctx.assert.ok(allowedIcons.includes(res.json.icons?.[0]?.src), `Unexpected manifest icon src: ${res.json.icons?.[0]?.src}`);
  });

  test('T1-F09-02', 'Web session lifecycle: GET /web/api/session -> POST /web/api/pair sets HttpOnly rokbot_web cookie', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const before = await client.webSession();
    ctx.assert.assertStatus(before, 200);
    if (!ctx.harness && before.json?.available === false) {
      t.skip('Web client bundle is not installed on live Host');
    }
    ctx.assert.equal(before.json.available, true);
    ctx.assert.equal(before.json.paired, false);
    ctx.assert.equal(typeof before.json.rendererVersion, 'string');

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    const keyRes = await client.createPairingKey();
    ctx.assert.assertStatus(keyRes, 201);

    const pairRes = await client.webPair({
      pairingKey: keyRes.json.pairingKey,
      deviceName: 'RokBot Web Browser',
      clientDeviceId: 'web-browser-001',
    });
    ctx.assert.assertStatus(pairRes, 201);
    if (!ctx.harness) {
      t.after(() => client.webLogout().catch(() => {}));
    }
    ctx.assert.equal(pairRes.json.ok, true);
    ctx.assert.ok(pairRes.json.deviceId);

    const setCookieHeader = pairRes.headers.get('set-cookie') || '';
    ctx.assert.ok(setCookieHeader.includes('rokbot_web='));
    ctx.assert.ok(/HttpOnly/i.test(setCookieHeader));
    ctx.assert.ok(/SameSite=Strict/i.test(setCookieHeader));

    const after = await client.webSession();
    ctx.assert.assertStatus(after, 200);
    ctx.assert.equal(after.json.paired, true);
    ctx.assert.equal(after.json.deviceName, 'RokBot Web Browser');
  });

  test('T1-F09-03', 'Web cookie session executes /local/status, /local/model & SSE /events without Bearer token', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    if (ctx.harness) {
      const login = await ensureAdminSession(ctx, client);
      ctx.assert.assertStatus(login, 200);
      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      const pairRes = await client.webPair({ pairingKey: keyRes.json.pairingKey, deviceName: 'Web Model Session' });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      await ensureWebSession(ctx, client, t);
    }

    // Ensure no Bearer token is set; requests rely solely on rokbot_web cookie + x-rokbot-web: 1
    ctx.assert.equal(client.deviceToken, null);

    const st = await client.localStatus();
    ctx.assert.assertStatus(st, 200);
    ctx.assert.equal(st.json.brand, 'RokBot');

    if (ctx.harness) {
      const putModel = await client.putLocalModel(
        {
          apiFormat: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          model: 'gpt-4o',
          apiKey: 'sk-tier1-web-model-7777',
        },
        { adminPassword: ctx.adminPassword },
      );
      ctx.assert.assertStatus(putModel, 200);
    }

    const getModel = await client.getLocalModel({ adminPassword: ctx.adminPassword });
    if (!ctx.harness && st.json?.canConfigureModel === false) {
      ctx.assert.assertStatus(getModel, 403);
      ctx.assert.assertNoSecrets(getModel.json ?? getModel.text, ['sk-tier1-web-model-7777', ctx.adminPassword], { forbidTokenKey: true });
    } else {
      ctx.assert.assertStatus(getModel, 200);
      ctx.assert.equal(getModel.json.ok, true);
      ctx.assert.assertNoSecrets(getModel.json, ['sk-tier1-web-model-7777', ctx.adminPassword], { forbidTokenKey: true });
      if (ctx.harness) {
        ctx.assert.equal(getModel.json.config.providers[0].hasApiKey, true);
      }
    }

    const sse = await client.openSse('/events');
    t.after(() => sse.close());
    ctx.assert.equal(sse.status, 200);
    if (ctx.harness) {
      const promptRes = await client.apiCall('sendPrompt', { prompt: 'web-ping' });
      ctx.assert.assertStatus(promptRes, 200);
      const doneEv = await sse.nextEvent((ev) => ev.data?.channel === 'agent-done', 3000);
      ctx.assert.equal(doneEv.data.payload.reply, 'OK: web-ping');
    }
  });

  test('T1-F09-04', 'POST /admin/api/web-client/open pairs admin browser into paired web session', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);

    if (!ctx.harness) {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      if (ws.json?.available === false) {
        t.skip('Web client bundle is not installed on live Host');
      }
    }

    const openRes = await client.adminOpenWebClient({ deviceName: 'Admin Web Console' });
    if (!ctx.harness && openRes.status === 409) {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      ctx.assert.equal(ws.json?.available, false);
      t.skip('Web client bundle is not installed on live Host');
    }
    ctx.assert.assertStatus(openRes, [200, 201]);
    if (!ctx.harness) {
      t.after(() => client.webLogout().catch(() => {}));
    }
    ctx.assert.equal(openRes.json?.ok, true);
    ctx.assert.equal(client.cookies.has('rokbot_web'), true);

    const sess = await client.webSession();
    ctx.assert.assertStatus(sess, 200);
    ctx.assert.equal(sess.json.paired, true);
  });

  test('T1-F09-05', 'POST /web/api/logout clears rokbot_web cookie, revokes session & checks web/client repo contracts', async (t) => {
    await resetHarnessState(ctx);
    const client = createClient(ctx, { deviceToken: null });
    t.after(async () => {
      await client.close();
      await resetHarnessState(ctx);
    });

    const login = await ensureAdminSession(ctx, client);
    ctx.assert.assertStatus(login, 200);
    if (ctx.harness) {
      const keyRes = await client.createPairingKey();
      ctx.assert.assertStatus(keyRes, 201);
      const pairRes = await client.webPair({ pairingKey: keyRes.json.pairingKey, deviceName: 'Logout Web' });
      ctx.assert.assertStatus(pairRes, 201);
    } else {
      const ws = await client.webSession();
      ctx.assert.assertStatus(ws, 200);
      if (ws.json?.available === false) {
        t.skip('Web client bundle is not installed on live Host');
      }
      const openRes = await client.adminOpenWebClient({ deviceName: 'Logout Web' });
      ctx.assert.assertStatus(openRes, [200, 201]);
    }
    const savedWebCookie = client.cookies.get('rokbot_web');
    ctx.assert.ok(savedWebCookie);

    const logout = await client.webLogout();
    ctx.assert.assertStatus(logout, 200);
    ctx.assert.equal(logout.json.ok, true);
    ctx.assert.equal(client.cookies.has('rokbot_web'), false);

    const sess = await client.webSession();
    ctx.assert.assertStatus(sess, 200);
    ctx.assert.equal(sess.json.paired, false);

    // Replaying revoked cookie must return 401
    const replay = await client.localStatus({
      web: true,
      headers: { cookie: `rokbot_web=${savedWebCookie}` },
    });
    ctx.assert.assertStatus(replay, 401);

    if (ctx.repoCheck) {
      const bootData = await readFile(path.join(ctx.repoRoot, 'web', 'client', 'boot-data.js'), 'utf8');
      ctx.assert.ok(bootData.includes('x-rokbot-web'));
      const gateway = await readFile(path.join(ctx.repoRoot, 'web', 'client', 'gateway.js'), 'utf8');
      ctx.assert.ok(/COORDINATOR_VERSION\s*=\s*3/.test(gateway));
    }
  });
}
