import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AndroidKeystoreEmulator,
  OkHttpInterceptorEmulator,
  AecAudioEmulator,
  SSEClientHelper
} from './test-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

export async function runTier4Tests(host) {
  const tests = [];
  function test(name, fn) {
    tests.push({ name, fn });
  }

  const BASE_URL = host.origin;
  const PAIRING_KEY = host.validPairingKey;

  // APP.1: Complete Fresh Device Onboarding to First Streaming Chat Conversation
  test('APP.1: Complete Fresh Device Onboarding to First Streaming Chat Conversation', async () => {
    // 1. User inputs Host URL and 6-char pairing key in PairingActivity
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Pixel 8 Pro',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    assert.equal(pairRes.status, 201);
    const creds = await pairRes.json();
    assert.ok(creds.token && creds.deviceId);

    // 2. Persist credentials securely in Android Keystore
    const ks = new AndroidKeystoreEmulator();
    const encToken = ks.encrypt('grokbot_device_token', creds.token);
    const encGateway = ks.encrypt('grokbot_gateway_url', creds.gatewayUrl);

    // 3. App initializes with decrypted credentials
    const token = ks.decrypt('grokbot_device_token', encToken.iv, encToken.ciphertext, encToken.authTag);
    const gateway = ks.decrypt('grokbot_gateway_url', encGateway.iv, encGateway.ciphertext, encGateway.authTag);

    // 4. Fetch available bots
    const listRes = await fetch(`${gateway}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const bots = await listRes.json();
    assert.ok(bots.length > 0);
    const selectedBot = bots[0];

    // 5. Connect to Core Events SSE stream
    const sse = new SSEClientHelper(`${gateway}/events`, { 'Authorization': `Bearer ${token}` });
    await sse.connect();

    // 6. Send initial greeting prompt
    const nonce = crypto.randomUUID();
    const promptRes = await fetch(`${gateway}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: selectedBot.id,
        clientNonce: nonce,
        prompt: 'Hello! This is my first onboarding chat.'
      })
    });
    assert.equal(promptRes.status, 200);

    // 7. Verify streaming response arrives
    const transcript = await sse.waitForEvent(e => e.data?.channel === 'agent-transcript');
    assert.equal(transcript.data.payload.agentId, selectedBot.id);
    assert.ok(transcript.data.payload.delta);
    sse.close();
  });

  // APP.2: Multimodal Photo Upload and Chat Query Workflow
  test('APP.2: Multimodal Photo Upload and Chat Query Workflow', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Photo-Client', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Simulate user picking a 1.5MB photo
    const photoBytes = Buffer.alloc(1.5 * 1024 * 1024, 0xEE);
    const uploadId = crypto.randomUUID();

    // 3. Chunked upload (single chunk since < 4MB)
    const uploadRes = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'landscape.jpg',
        offset: 0,
        totalSize: photoBytes.length,
        bytesBase64: photoBytes.toString('base64')
      })
    });
    assert.equal(uploadRes.status, 200);
    const { committedPath } = await uploadRes.json();
    assert.ok(committedPath.includes('landscape.jpg'));

    // 4. Resolve attachment thumbnail for in-app preview
    const previewRes = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: committedPath })
    });
    assert.equal(previewRes.status, 200);
    const { dataUrl } = await previewRes.json();
    assert.ok(dataUrl.startsWith('data:image/jpeg;base64,'));

    // 5. Send chat prompt referencing committed image path
    const promptRes = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: 'Describe what you see in this photo',
        attachmentPaths: [committedPath],
        attachmentNames: ['landscape.jpg']
      })
    });
    assert.equal(promptRes.status, 200);
    const promptData = await promptRes.json();
    assert.equal(promptData.accepted, true);
  });

  // APP.3: Full-Duplex Real-Time Voice Conversation Turnaround with Barge-in Interruption
  test('APP.3: Full-Duplex Real-Time Voice Conversation Turnaround with Barge-in Interruption', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Voice-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Request voice session with AEC3 negotiation
    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', audioProcessing: 'native-aec3-v1' })
    });
    assert.equal(sessRes.status, 200);
    const { clientSecret, websocketUrl } = await sessRes.json();

    // 3. Connect WebSocket using subprotocol
    const aec = new AecAudioEmulator('native-aec3-v1');
    const ws = new globalThis.WebSocket(websocketUrl, `xai-client-secret.${clientSecret}`);
    await new Promise(r => { ws.onopen = r; });

    // 4. Receive session initialization frame
    const sessionInit = await new Promise(r => {
      ws.onmessage = e => {
        const p = JSON.parse(e.data);
        if (p.type === 'session.created') r(p);
      };
    });
    assert.equal(sessionInit.session.audio.input.format.rate, 24000);

    // 5. Stream mic audio and commit turn
    const pcmAudio = Buffer.alloc(960, 0x12).toString('base64');
    ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmAudio }));
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    // 6. Receive STT and TTS delta frames
    const [sttFrame, ttsDelta] = await Promise.all([
      new Promise(r => {
        ws.addEventListener('message', e => {
          const p = JSON.parse(e.data);
          if (p.type === 'conversation.item.input_audio_transcription.completed') r(p);
        });
      }),
      new Promise(r => {
        ws.addEventListener('message', e => {
          const p = JSON.parse(e.data);
          if (p.type === 'response.audio.delta') r(p);
        });
      })
    ]);
    assert.ok(sttFrame.transcript);
    assert.ok(ttsDelta.delta);

    // 7. Buffer far-end audio in AEC
    aec.bufferFarend(Buffer.from(ttsDelta.delta, 'base64'));

    // 8. User speaks to interrupt (barge-in cancellation)
    ws.send(JSON.stringify({ type: 'response.cancel' }));
    const cancelledFrame = await new Promise(r => {
      ws.addEventListener('message', e => {
        const p = JSON.parse(e.data);
        if (p.type === 'response.cancelled') r(p);
      });
    });
    assert.equal(cancelledFrame.response.status, 'cancelled');

    // 9. Hang up cleanly
    ws.send(JSON.stringify({ type: 'session.close' }));
    ws.close();
  });

  // APP.4: Background Transition, Push Notification Delivery, and Deep Link Resumption
  test('APP.4: Background Transition, Push Notification Delivery, and Deep Link Resumption', async () => {
    // 1. Authenticate device and register push
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Push-Resume-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token, deviceId } = await pairRes.json();

    await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        push: { provider: 'fcm', fcmToken: 'fcm-sample-token-112233' }
      })
    });

    // 2. Client is initially in foreground
    const fgSse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${token}`,
      'x-grokbot-foreground': '1'
    });
    await fgSse.connect();
    assert.ok(host.foregroundDevices.has(deviceId));

    // 3. User switches to home screen (app backgrounded)
    fgSse.close();
    await new Promise(r => setTimeout(r, 50));
    assert.ok(!host.foregroundDevices.has(deviceId));

    // 4. Host sends background push notification
    const testPushRes = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const pushResult = await testPushRes.json();
    assert.equal(pushResult.delivered, true);
    assert.equal(pushResult.suppressed, false);

    // 5. User taps system notification; parse deep link intent
    const deliveredNotif = host.notificationHistory.find(n => n.id === pushResult.notificationId);
    assert.ok(deliveredNotif);
    const deepLink = deliveredNotif.deepLink;
    const match = /^grokbot-local:\/\/agent\/([A-Za-z0-9_-]+)$/.exec(deepLink);
    assert.ok(match);
    const targetAgentId = match[1];

    // 6. App opens target agent chat and syncs message transcript tail
    const syncRes = await fetch(`${BASE_URL}/api/getAgentTranscriptTail`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: targetAgentId, limit: 20 })
    });
    assert.equal(syncRes.status, 200);
    const transcript = await syncRes.json();
    assert.ok(transcript.entries.length > 0);
  });

  // APP.5: Knowledge Base Reference Library Management and Bot Q&A
  test('APP.5: Knowledge Base Reference Library Management and Bot Q&A', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Library-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Upload reference PDF into Bot Library
    const docContent = 'GrokBot Native Android Client Reference Manual Specification';
    const uploadRes = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'manual.pdf',
        contentType: 'application/pdf',
        base64: Buffer.from(docContent).toString('base64')
      })
    });
    assert.equal(uploadRes.status, 200);
    const uploadData = await uploadRes.json();
    assert.equal(uploadData.file.name, 'manual.pdf');
    assert.ok(uploadData.file.etag);

    // 3. Verify file appears in library listing
    const listRes = await fetch(`${BASE_URL}/local/files?agentId=agent-default`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const listData = await listRes.json();
    assert.ok(listData.files.some(f => f.name === 'manual.pdf'));

    // 4. Ask bot a question referencing the library document
    const promptRes = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: 'What does manual.pdf say about native client?'
      })
    });
    assert.equal(promptRes.status, 200);

    // 5. Download original binary content to verify roundtrip fidelity
    const dlRes = await fetch(`${BASE_URL}/local/files/content?agentId=agent-default&name=manual.pdf`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(dlRes.status, 200);
    const content = await dlRes.text();
    assert.equal(content, docContent);

    // 6. Delete file from library
    const delRes = await fetch(`${BASE_URL}/local/files`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', fileName: 'manual.pdf' })
    });
    assert.equal(delRes.status, 200);
  });

  // APP.6: Network Disconnection, Exponential Backoff, and Seamless Stream Recovery
  test('APP.6: Network Disconnection, Exponential Backoff, and Seamless Stream Recovery', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Recovery-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Open initial SSE stream
    const sse1 = new SSEClientHelper(`${BASE_URL}/events`, { 'Authorization': `Bearer ${token}` });
    await sse1.connect();
    const initEvent = await sse1.waitForEvent(e => e.data?.channel === 'coordinator-transport-state');
    assert.ok(initEvent.id);
    const lastEventId = initEvent.id;

    // 3. Simulate sudden network disconnect
    sse1.close();

    // 4. Simulate client exponential backoff delays
    const backoffDelays = [50, 100];
    for (const delay of backoffDelays) {
      await new Promise(r => setTimeout(r, delay));
    }

    // 5. Reconnect passing Last-Event-ID header
    const sse2 = new SSEClientHelper(`${BASE_URL}/events`, {
      'Authorization': `Bearer ${token}`,
      'Last-Event-ID': lastEventId
    });
    await sse2.connect();
    assert.ok(sse2.abortController);

    // 6. Verify clientNonce idempotency avoids duplicate execution
    const retryNonce = crypto.randomUUID();
    const r1 = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: retryNonce, prompt: 'resilient prompt' })
    });
    const d1 = await r1.json();

    const r2 = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default', clientNonce: retryNonce, prompt: 'resilient prompt' })
    });
    const d2 = await r2.json();
    assert.equal(d1.messageId, d2.messageId);

    sse2.close();
  });

  // APP.7: Multi-Agent Switching and Concurrent Conversation Tracking
  test('APP.7: Multi-Agent Switching and Concurrent Conversation Tracking', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Multi-Bot-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Fetch bot list and identify 2 distinct agents
    const listRes = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const bots = await listRes.json();
    const botA = bots.find(b => b.id === 'agent-default');
    const botB = bots.find(b => b.id === 'agent-coding');
    assert.ok(botA && botB);

    // 3. Connect SSE event stream
    const sse = new SSEClientHelper(`${BASE_URL}/events`, { 'Authorization': `Bearer ${token}` });
    await sse.connect();

    // 4. Send prompt to Bot A
    const nonceA = crypto.randomUUID();
    const resA = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: botA.id, clientNonce: nonceA, prompt: 'Task for Bot A' })
    });
    assert.equal(resA.status, 200);

    // 5. Send prompt to Bot B
    const nonceB = crypto.randomUUID();
    const resB = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: botB.id, clientNonce: nonceB, prompt: 'Task for Bot B' })
    });
    assert.equal(resB.status, 200);

    // 6. Query status for each nonce independently
    const statA = await fetch(`${BASE_URL}/api/promptAcceptanceStatus`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNonce: nonceA })
    });
    const dataA = await statA.json();
    assert.equal(dataA.accepted, true);

    const statB = await fetch(`${BASE_URL}/api/promptAcceptanceStatus`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientNonce: nonceB })
    });
    const dataB = await statB.json();
    assert.equal(dataB.accepted, true);

    sse.close();
  });

  // APP.8: Voice Ticket Expiry, Graceful Renewal, and WebSocket Connection
  test('APP.8: Voice Ticket Expiry, Graceful Renewal, and WebSocket Connection', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Voice-Renew-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    // 2. Request initial voice session ticket
    const s1Res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const s1 = await s1Res.json();

    // 3. Simulate ticket expiring on server
    const secretHash = crypto.createHash('sha256').update(s1.clientSecret).digest('hex');
    const ticket = host.voiceTickets.get(secretHash);
    ticket.expiresAt = Date.now() - 5000;

    // 4. Attempt WebSocket with expired ticket -> failure
    const wsFail = new globalThis.WebSocket(s1.websocketUrl, `xai-client-secret.${s1.clientSecret}`);
    await new Promise(r => {
      wsFail.onerror = r;
      wsFail.onclose = r;
    });
    assert.notEqual(wsFail.readyState, 1);

    // 5. Client detects failure and requests fresh session ticket
    const s2Res = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const s2 = await s2Res.json();
    assert.notEqual(s1.clientSecret, s2.clientSecret);

    // 6. Connect WebSocket with renewed ticket -> success
    const wsSuccess = new globalThis.WebSocket(s2.websocketUrl, `xai-client-secret.${s2.clientSecret}`);
    await new Promise(r => { wsSuccess.onopen = r; });
    assert.equal(wsSuccess.readyState, 1);
    wsSuccess.close();
  });

  // APP.9: Telemetry Privacy Isolation and Zero-Leakage Verification
  test('APP.9: Telemetry Privacy Isolation and Zero-Leakage Verification', async () => {
    // 1. Authenticate device
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Privacy-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token });

    // 2. Simulate official React Native background analytics calls during user session
    const telemetryCalls = [
      interceptor.intercept('https://o12345.ingest.sentry.io/api/99/envelope/'),
      interceptor.intercept('https://sdk.iad-01.braze.com/api/v3/data/'),
      interceptor.intercept('https://t.appsflyer.com/api/v4/androidevent'),
      interceptor.intercept('https://featuregates.org.statsigapi.net/v1/initialize')
    ];

    // 3. User simultaneously sends a confidential message
    const chatCall = interceptor.intercept('https://api.x.ai/api/sendPrompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: 'Confidential corporate strategy discussion'
      })
    });

    const [t1, t2, t3, t4, chatRes] = await Promise.all([...telemetryCalls, chatCall]);

    // 4. Verify all telemetry calls are 100% blocked with HTTP 204
    assert.equal(t1.status, 204);
    assert.equal(t2.status, 204);
    assert.equal(t3.status, 204);
    assert.equal(t4.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 4);

    // 5. Verify chat prompt went through cleanly
    assert.equal(chatRes.status, 200);
    const chatData = await chatRes.json();
    assert.equal(chatData.accepted, true);
  });

  // APP.10: Clean Device Unpairing, Token Revocation, and Storage Purge
  test('APP.10: Clean Device Unpairing, Token Revocation, and Storage Purge', async () => {
    // 1. Authenticate device and establish credentials
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Unpair-Device', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token, deviceId, gatewayUrl } = await pairRes.json();

    // 2. Store in Keystore
    const ks = new AndroidKeystoreEmulator();
    ks.encrypt('token', token);
    ks.encrypt('gateway', gatewayUrl);

    // 3. User confirms "Unpair Device" in Settings
    // 3a. Clear push registration on server
    await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ push: { provider: 'none' } })
    });

    // 3b. Delete all keys from Keystore
    ks.deleteKey('token');
    ks.deleteKey('gateway');
    assert.throws(() => ks.decrypt('token', '', '', ''), /not found/);
    assert.throws(() => ks.decrypt('gateway', '', '', ''), /not found/);

    // 3c. Deregister device from mock host
    host.devices.delete(token);
    host.devicesById.delete(deviceId);

    // 4. Subsequent requests using old token fail with 401 Unauthorized
    const testOldToken = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    assert.equal(testOldToken.status, 401);
  });

  return tests;
}
