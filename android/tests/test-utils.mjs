import crypto from 'node:crypto';

/**
 * Android Keystore AES-256-GCM Emulator
 */
export class AndroidKeystoreEmulator {
  constructor() {
    this.keys = new Map(); // alias -> 32-byte Key
  }

  generateKey(alias) {
    const key = crypto.randomBytes(32);
    this.keys.set(alias, key);
    return key;
  }

  encrypt(alias, plaintext) {
    let key = this.keys.get(alias);
    if (!key) key = this.generateKey(alias);

    const iv = crypto.randomBytes(12); // GCM standard 96-bit IV
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf-8')), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: authTag.toString('base64')
    };
  }

  decrypt(alias, ivBase64, ciphertextBase64, authTagBase64) {
    const key = this.keys.get(alias);
    if (!key) throw new Error(`Key alias not found: ${alias}`);

    const iv = Buffer.from(ivBase64, 'base64');
    const ciphertext = Buffer.from(ciphertextBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  }

  deleteKey(alias) {
    return this.keys.delete(alias);
  }
}

/**
 * OkHttp Network Interceptor & Telemetry Blocker Emulator
 */
export class OkHttpInterceptorEmulator {
  constructor({ gatewayUrl, token }) {
    this.gatewayUrl = gatewayUrl ? gatewayUrl.replace(/\/+$/, '') : '';
    this.token = token || '';
    this.telemetryBlockedCount = 0;
  }

  isTelemetryDomain(hostname) {
    const lower = hostname.toLowerCase();
    return (
      lower.includes('ingest.sentry.io') ||
      lower.endsWith('.braze.com') ||
      lower.endsWith('.appsflyer.com') ||
      lower.endsWith('.statsigapi.net')
    );
  }

  async intercept(requestUrl, options = {}) {
    const parsed = new URL(requestUrl);

    // Telemetry blocking: return synthetic 204 No Content immediately
    if (this.isTelemetryDomain(parsed.hostname)) {
      this.telemetryBlockedCount++;
      return {
        status: 204,
        statusText: 'No Content',
        headers: new Headers({ 'x-rokbot-telemetry-blocked': '1' }),
        ok: true,
        text: async () => '',
        json: async () => ({})
      };
    }

    // Cloud endpoint redirection
    let targetUrl = requestUrl;
    if (parsed.hostname === 'api.x.ai' || parsed.hostname === 'grok.com' || parsed.hostname === 'cloud.rokbot.local') {
      targetUrl = `${this.gatewayUrl}${parsed.pathname}${parsed.search}`;
    }

    // Auth injection
    const headers = new Headers(options.headers || {});
    if (this.token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    headers.set('x-rokbot-client', 'android-native/1.26.0');

    return globalThis.fetch(targetUrl, {
      ...options,
      headers
    });
  }
}

/**
 * AXML Manifest Validator Emulator
 */
export class AxmlManifestEmulator {
  static validate(manifest) {
    const errors = [];
    if (manifest.packageName !== 'ai.x.grok.bot') {
      errors.push(`Invalid packageName: expected ai.x.grok.bot, got ${manifest.packageName}`);
    }
    if (!manifest.usesCleartextTraffic) {
      errors.push('android:usesCleartextTraffic must be true');
    }
    const hasPairingActivity = (manifest.activities || []).some(
      a => a.name === 'dev.rokbot.nativeapp.PairingActivity'
    );
    if (!hasPairingActivity) {
      errors.push('Missing PairingActivity declaration');
    }
    const requiredPermissions = [
      'android.permission.INTERNET',
      'android.permission.RECORD_AUDIO',
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.WAKE_LOCK'
    ];
    for (const perm of requiredPermissions) {
      if (!(manifest.permissions || []).includes(perm)) {
        errors.push(`Missing required permission: ${perm}`);
      }
    }
    return {
      valid: errors.length === 0,
      errors
    };
  }
}

/**
 * Hermes Bytecode Header & String Redirection Emulator
 */
export class HermesBytecodeEmulator {
  static MAGIC = 0x1F060603; // Hermes Bytecode magic header
  static VERSION = 98; // HBC v98 for RN 0.74+

  static createHeader(version = 98) {
    const buf = Buffer.alloc(32);
    buf.writeUInt32LE(this.MAGIC, 0);
    buf.writeUInt32LE(version, 4);
    return buf;
  }

  static validateHbc(buffer) {
    if (buffer.length < 8) return { valid: false, error: 'File too small' };
    const magic = buffer.readUInt32LE(0);
    if (magic !== this.MAGIC) return { valid: false, error: 'Invalid Hermes magic number' };
    const version = buffer.readUInt32LE(4);
    if (version !== this.VERSION) return { valid: false, error: `Unsupported HBC version ${version}` };
    return { valid: true, version };
  }

  static rewriteBundleStrings(sourceBundle, oldHost, newHost) {
    return sourceBundle.replaceAll(oldHost, newHost);
  }
}

/**
 * Acoustic Echo Cancellation (AEC3) Simulator
 */
export class AecAudioEmulator {
  constructor(mode = 'native-aec-v1') {
    this.mode = mode;
    this.farendBuffer = [];
    this.captureBuffer = [];
    this.bargeInThresholdMs = mode === 'native-aec3-v1' ? 240 : 400;
  }

  bufferFarend(pcmChunk) {
    this.farendBuffer.push({
      timestamp: Date.now(),
      size: pcmChunk.length,
      sampleRate: 24000
    });
    // Keep max 100 far-end frames
    if (this.farendBuffer.length > 100) this.farendBuffer.shift();
  }

  processCapture(micChunk) {
    // 24kHz 16-bit mono: 2 bytes per sample
    if (micChunk.length % 2 !== 0) {
      throw new Error('Invalid PCM chunk: length must be even (16-bit)');
    }
    this.captureBuffer.push(micChunk);
    return {
      cleanedLength: micChunk.length,
      echoSuppressed: this.farendBuffer.length > 0,
      bargeInConfirmed: true
    };
  }
}

/**
 * SSE Client Helper
 */
export class SSEClientHelper {
  constructor(url, headers = {}) {
    this.url = url;
    this.headers = headers;
    this.events = [];
    this.comments = [];
    this.abortController = new AbortController();
  }

  async connect() {
    try {
      const res = await globalThis.fetch(this.url, {
        headers: {
          'Accept': 'text/event-stream',
          ...this.headers
        },
        signal: this.abortController.signal
      });

      if (res.status !== 200) {
        throw new Error(`SSE connection failed with status ${res.status}`);
      }

      this._readStream(res.body).catch(() => {});
      return this;
    } catch (err) {
      if (err.name === 'AbortError') return this;
      throw err;
    }
  }

  async _readStream(stream) {
    if (!stream) return;
    const reader = stream.getReader();
    const abortHandler = () => {
      try { reader.cancel().catch(() => {}); } catch (_) {}
    };
    this.abortController.signal.addEventListener('abort', abortHandler, { once: true });
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop(); // keep trailing incomplete chunk

        for (const block of lines) {
          if (!block.trim()) continue;
          if (block.startsWith(':')) {
            this.comments.push(block.trim());
            continue;
          }

          let eventId = null;
          let eventType = 'message';
          let eventData = null;

          for (const line of block.split('\n')) {
            if (line.startsWith('id:')) eventId = line.slice(3).trim();
            else if (line.startsWith('event:')) eventType = line.slice(6).trim();
            else if (line.startsWith('data:')) {
              try {
                eventData = JSON.parse(line.slice(5).trim());
              } catch (_) {
                eventData = line.slice(5).trim();
              }
            }
          }

          this.events.push({ id: eventId, event: eventType, data: eventData });
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // SSE disconnected
      }
    }
  }

  async waitForEvent(predicate, timeoutMs = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = this.events.find(predicate);
      if (match) return match;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('Timeout waiting for SSE event');
  }

  close() {
    try {
      this.abortController.abort();
    } catch (_) {}
  }
}
