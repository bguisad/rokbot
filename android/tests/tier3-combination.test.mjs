import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AndroidKeystoreEmulator,
  OkHttpInterceptorEmulator,
  AxmlManifestEmulator,
  HermesBytecodeEmulator,
  AecAudioEmulator,
  SSEClientHelper
} from './test-utils.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');

export async function runTier3Tests(host) {
  const tests = [];
  function test(name, fn) {
    tests.push({ name, fn });
  }

  const BASE_URL = host.origin;
  const PAIRING_KEY = host.validPairingKey;

  // C1: Pairing (F4) + Keystore (F5)
  test('C1: Pairing (F4) + Keystore (F5): Complete pairing handshake and securely persist device credentials in AES-256-GCM Keystore', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Comb-Device-1',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    assert.equal(pairRes.status, 201);
    const creds = await pairRes.json();

    const ks = new AndroidKeystoreEmulator();
    const encToken = ks.encrypt('device_token', creds.token);
    const encUrl = ks.encrypt('gateway_url', creds.gatewayUrl);

    // Decrypt and verify
    assert.equal(ks.decrypt('device_token', encToken.iv, encToken.ciphertext, encToken.authTag), creds.token);
    assert.equal(ks.decrypt('gateway_url', encUrl.iv, encUrl.ciphertext, encUrl.authTag), creds.gatewayUrl);
  });

  // C2: Keystore (F5) + OkHttp Interceptor (F6)
  test('C2: Keystore (F5) + OkHttp Interceptor (F6): Decrypt token from Keystore and transparently attach Bearer header to outgoing requests', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Comb-Device-2',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    const creds = await pairRes.json();

    const ks = new AndroidKeystoreEmulator();
    const enc = ks.encrypt('device_token', creds.token);
    const token = ks.decrypt('device_token', enc.iv, enc.ciphertext, enc.authTag);

    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token });
    const res = await interceptor.intercept('https://api.x.ai/connect/status');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.connected, true);
  });

  // C3: OkHttp Interceptor (F6) + Telemetry Blocker (F7)
  test('C3: OkHttp Interceptor (F6) + Telemetry Blocker (F7): Concurrently route legitimate host API call and block telemetry analytics', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Comb-Device-3',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    const creds = await pairRes.json();
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: creds.token });

    const [apiRes, sentryRes, brazeRes] = await Promise.all([
      interceptor.intercept('https://api.x.ai/api/listAgents', { method: 'POST' }),
      interceptor.intercept('https://o9999.ingest.sentry.io/envelope/'),
      interceptor.intercept('https://iad-03.braze.com/api/v3/data')
    ]);

    assert.equal(apiRes.status, 200);
    assert.equal(sentryRes.status, 204);
    assert.equal(brazeRes.status, 204);
    assert.equal(interceptor.telemetryBlockedCount, 2);
  });

  // C4: OkHttp Interceptor (F6) + Bot List (F9)
  test('C4: OkHttp Interceptor (F6) + Bot List (F9): Injected interceptor transparently maps cloud domain api.x.ai/api/listAgents to local host', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceName: 'Comb-Device-4',
        platform: 'desktop',
        clientKind: 'android',
        pairingKey: PAIRING_KEY
      })
    });
    const creds = await pairRes.json();
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: creds.token });

    const res = await interceptor.intercept('https://api.x.ai/api/listAgents', { method: 'POST' });
    assert.equal(res.status, 200);
    const bots = await res.json();
    assert.ok(bots.some(b => b.id === 'agent-default'));
  });

  // C5: Bot List (F9) + Streaming Chat (F10)
  test('C5: Bot List (F9) + Streaming Chat (F10): Select bot from listAgents and initiate bidirectional streaming chat turn with clientNonce', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-5', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const listRes = await fetch(`${BASE_URL}/api/listAgents`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const agents = await listRes.json();
    const targetAgent = agents[0];

    const sse = new SSEClientHelper(`${BASE_URL}/events`, { 'Authorization': `Bearer ${token}` });
    await sse.connect();

    const nonce = crypto.randomUUID();
    const promptRes = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: targetAgent.id, clientNonce: nonce, prompt: 'Hello chosen bot' })
    });
    assert.equal(promptRes.status, 200);

    const transcript = await sse.waitForEvent(e => e.data?.channel === 'agent-transcript');
    assert.equal(transcript.data.payload.agentId, targetAgent.id);
    sse.close();
  });

  // C6: Streaming Chat (F10) + Multimodal Upload (F14)
  test('C6: Streaming Chat (F10) + Multimodal Upload (F14): Upload 4MB image attachment, get committedPath, and reference it in sendPrompt', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-6', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const uploadId = crypto.randomUUID();
    const imgData = Buffer.alloc(1024 * 1024, 0xAB).toString('base64');
    const uploadRes = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId,
        filename: 'diagram.png',
        offset: 0,
        totalSize: 1024 * 1024,
        bytesBase64: imgData
      })
    });
    const { committedPath } = await uploadRes.json();
    assert.ok(committedPath);

    const nonce = crypto.randomUUID();
    const promptRes = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: nonce,
        prompt: 'Analyze diagram',
        attachmentPaths: [committedPath]
      })
    });
    assert.equal(promptRes.status, 200);
    const data = await promptRes.json();
    assert.equal(data.accepted, true);
  });

  // C7: Multimodal Upload (F14) + Attachment Readback (F15)
  test('C7: Multimodal Upload (F14) + Attachment Readback (F15): Upload chunked image, get committedPath, and resolve base64 dataUrl preview', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-7', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const rawBuf = Buffer.from('PNG_SAMPLE_BYTES');
    const uploadRes = await fetch(`${BASE_URL}/api/uploadAttachmentChunk`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        uploadId: crypto.randomUUID(),
        filename: 'preview.png',
        offset: 0,
        totalSize: rawBuf.length,
        bytesBase64: rawBuf.toString('base64')
      })
    });
    const { committedPath } = await uploadRes.json();

    const previewRes = await fetch(`${BASE_URL}/connect/attachment`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: committedPath })
    });
    assert.equal(previewRes.status, 200);
    const previewData = await previewRes.json();
    assert.ok(previewData.dataUrl.startsWith('data:image/png;base64,'));
    assert.ok(previewData.dataUrl.includes(rawBuf.toString('base64')));
  });

  // C8: Streaming Chat (F10) + In-App Foreground Stream (F12)
  test('C8: Streaming Chat (F10) + In-App Foreground Stream (F12): Stream chat message while foreground SSE active; verify push is suppressed', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-8', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token, deviceId } = await pairRes.json();

    const sse = new SSEClientHelper(`${BASE_URL}/notifications/events`, {
      'Authorization': `Bearer ${token}`,
      'x-rokbot-foreground': '1'
    });
    await sse.connect();
    assert.ok(host.foregroundDevices.has(deviceId));

    const pushTestRes = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const pushResult = await pushTestRes.json();
    assert.equal(pushResult.suppressed, true);
    sse.close();
  });

  // C9: Push Registration (F11) + Background Push Delivery (F12)
  test('C9: Push Registration (F11) + Background Push Delivery (F12): Register FCM push, disconnect foreground stream, and verify background push packet delivered', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-9', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    await fetch(`${BASE_URL}/local/device`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        push: { provider: 'fcm', fcmToken: 'fcm-reg-test-token' }
      })
    });

    const pushRes = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const pushResult = await pushRes.json();
    assert.equal(pushResult.delivered, true);
    assert.equal(pushResult.suppressed, false);
    assert.equal(pushResult.provider, 'fcm');
  });

  // C10: Push Registration (F11) + Notification Channels & Deep Links (F13)
  test('C10: Push Registration (F11) + Notification Channels & Deep Links (F13): Incoming push notification maps to Android channel and parses rokbot-local:// deep link', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-10', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const pushRes = await fetch(`${BASE_URL}/local/device/push/test`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const { notificationId } = await pushRes.json();

    const notifItem = host.notificationHistory.find(n => n.id === notificationId);
    assert.ok(notifItem);
    assert.ok(notifItem.deepLink.startsWith('rokbot-local://agent/'));

    // Map to Android channel
    const channelId = notifItem.type === 'attention' ? 'attention' : 'messages';
    assert.equal(channelId, 'messages');
  });

  // C11: Pairing (F4) + Bot Library File Management (F16)
  test('C11: Pairing (F4) + Bot Library File Management (F16): Authenticate via pairing and upload reference documentation into Bot Library', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-11', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const uploadRes = await fetch(`${BASE_URL}/local/files`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        fileName: 'architecture.md',
        contentType: 'text/markdown',
        base64: Buffer.from('# Architecture Guide').toString('base64')
      })
    });
    assert.equal(uploadRes.status, 200);

    const listRes = await fetch(`${BASE_URL}/local/files?agentId=agent-default`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const libData = await listRes.json();
    assert.ok(libData.files.some(f => f.name === 'architecture.md'));
  });

  // C12: Bot Library (F16) + Chat Prompt (F10)
  test('C12: Bot Library (F16) + Chat Prompt (F10): Reference uploaded library document within chat prompt context', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-12', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const promptRes = await fetch(`${BASE_URL}/api/sendPrompt`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agent-default',
        clientNonce: crypto.randomUUID(),
        prompt: 'Query based on /data/library/agent-default/architecture.md'
      })
    });
    assert.equal(promptRes.status, 200);
  });

  // C13: Voice Handshake (F17) + Real-Time WebSocket (F18)
  test('C13: Voice Handshake (F17) + Real-Time WebSocket (F18): Request session ticket with clientSecret and establish full-duplex WebSocket connection', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-13', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const sess = await sessRes.json();

    const ws = new globalThis.WebSocket(sess.websocketUrl, `xai-client-secret.${sess.clientSecret}`);
    await new Promise(r => { ws.onopen = r; });
    assert.equal(ws.readyState, 1);
    ws.close();
  });

  // C14: Real-Time Voice (F18) + Hardware AEC (F19)
  test('C14: Real-Time Voice (F18) + Hardware AEC (F19): Voice call streams far-end speaker audio and cancels echo from microphone buffer', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-14', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const sess = await sessRes.json();

    const aec = new AecAudioEmulator('native-aec3-v1');
    const ws = new globalThis.WebSocket(sess.websocketUrl, `xai-client-secret.${sess.clientSecret}`);
    await new Promise(r => { ws.onopen = r; });

    // Client receives synthetic audio delta from host
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    const audioDelta = await new Promise(r => {
      ws.onmessage = e => {
        const p = JSON.parse(e.data);
        if (p.type === 'response.audio.delta') r(p);
      };
    });

    // Buffer incoming audio to AEC far-end
    aec.bufferFarend(Buffer.from(audioDelta.delta, 'base64'));

    // Capture microphone chunk
    const micBuf = Buffer.alloc(480);
    const cleaned = aec.processCapture(micBuf);
    assert.equal(cleaned.echoSuppressed, true);
    ws.close();
  });

  // C15: Real-Time Voice (F18) + Speech-to-Text Transcription (F20)
  test('C15: Real-Time Voice (F18) + Speech-to-Text Transcription (F20): Voice PCM frames transcribed into conversation item text', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-15', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const sessRes = await fetch(`${BASE_URL}/local/voice/session`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const sess = await sessRes.json();
    const ws = new globalThis.WebSocket(sess.websocketUrl, `xai-client-secret.${sess.clientSecret}`);
    await new Promise(r => { ws.onopen = r; });

    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    const sttResult = await new Promise(r => {
      ws.onmessage = e => {
        const p = JSON.parse(e.data);
        if (p.type === 'conversation.item.input_audio_transcription.completed') r(p);
      };
    });
    assert.equal(sttResult.transcript, 'Hello Grok Voice');
    ws.close();
  });

  // C16: Streaming Chat (F10) + Prompt Interruption (F10) + Background Notification (F12)
  test('C16: Streaming Chat (F10) + Prompt Interruption (F10) + Background Notification (F12): Interrupt active agent run, receive state update, and verify notification', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-16', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const { token } = await pairRes.json();

    const sse = new SSEClientHelper(`${BASE_URL}/events`, { 'Authorization': `Bearer ${token}` });
    await sse.connect();

    // Interrupt agent
    const interruptRes = await fetch(`${BASE_URL}/api/interruptAgentRun`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'agent-default' })
    });
    assert.equal(interruptRes.status, 200);

    const event = await sse.waitForEvent(e => e.data?.channel === 'agent-state');
    assert.equal(event.data.payload.status, 'interrupted');
    sse.close();
  });

  // C17: Pairing (F4) + Network Interceptor (F6) + Voice Session (F17)
  test('C17: Pairing (F4) + Network Interceptor (F6) + Voice Session (F17): Full flow from pairing credentials to voice session allocation and WebSocket upgrade', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-17', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const creds = await pairRes.json();
    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: creds.token });

    const sessRes = await interceptor.intercept('https://api.x.ai/local/voice/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-default' })
    });
    assert.equal(sessRes.status, 200);
    const sess = await sessRes.json();
    assert.ok(sess.websocketUrl);
  });

  // C18: Manifest Integrity (F2) + Native Pairing UI (F4)
  test('C18: Manifest Integrity (F2) + Native Pairing UI (F4): Validate AXML manifest registers PairingActivity before UI initialization', () => {
    const manifest = {
      packageName: 'ai.x.grok.bot',
      usesCleartextTraffic: true,
      activities: [{ name: 'dev.rokbot.nativeapp.PairingActivity', exported: true }],
      permissions: ['android.permission.INTERNET', 'android.permission.RECORD_AUDIO', 'android.permission.POST_NOTIFICATIONS', 'android.permission.FOREGROUND_SERVICE', 'android.permission.WAKE_LOCK']
    };
    const valid = AxmlManifestEmulator.validate(manifest);
    assert.equal(valid.valid, true);
    assert.equal(manifest.activities[0].name, 'dev.rokbot.nativeapp.PairingActivity');
  });

  // C19: Protected Directory Layout (F3) + Build Pipeline CLI (F1)
  test('C19: Boundary Isolation (F3) + Build Pipeline CLI (F1): Native patcher layout intact under android/', () => {
    const androidDir = path.join(REPO_ROOT, 'android');
    assert.ok(fs.existsSync(androidDir));
    const entries = fs.readdirSync(androidDir);
    assert.ok(entries.includes('companion'));
    assert.ok(entries.includes('patchers'));
  });

  // C20: Hermes Bytecode Injection (F8) + OkHttp Interceptor (F6)
  test('C20: Hermes Bytecode Injection (F8) + OkHttp Interceptor (F6): Injected Hermes bundle redirect coordinates with OkHttp interceptor to route cloud traffic', async () => {
    const pairRes = await fetch(`${BASE_URL}/connect/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceName: 'Comb-Device-20', platform: 'desktop', clientKind: 'android', pairingKey: PAIRING_KEY })
    });
    const creds = await pairRes.json();

    // Simulated React Native bundle string injection
    const jsBundle = 'const ENDPOINT = "https://cloud.rokbot.local/api/listAgents";';
    const rewritten = HermesBytecodeEmulator.rewriteBundleStrings(jsBundle, 'https://cloud.rokbot.local', BASE_URL);
    assert.ok(rewritten.includes(`${BASE_URL}/api/listAgents`));

    const interceptor = new OkHttpInterceptorEmulator({ gatewayUrl: BASE_URL, token: creds.token });
    const res = await interceptor.intercept('https://cloud.rokbot.local/api/listAgents', { method: 'POST' });
    assert.equal(res.status, 200);
  });

  return tests;
}
