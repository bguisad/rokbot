import { randomBytes } from 'node:crypto';

export class RokBotE2EClient {
  constructor({ baseUrl, adminPassword = null, deviceToken = null, deviceId = null } = {}) {
    if (!baseUrl) throw new Error('RokBotE2EClient requires baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.adminPassword = adminPassword;
    this.deviceToken = deviceToken;
    this.deviceId = deviceId;
    this.cookies = new Map();
    this._sseHandles = new Set();
  }

  setBearerToken(token, deviceId = null) {
    this.deviceToken = token;
    if (deviceId !== null) this.deviceId = deviceId;
    return this;
  }

  withDeviceToken(token, deviceId = null) {
    const clone = new RokBotE2EClient({
      baseUrl: this.baseUrl,
      adminPassword: this.adminPassword,
      deviceToken: token,
      deviceId,
    });
    return clone;
  }

  clearCookies() {
    this.cookies.clear();
  }

  _updateCookies(headers) {
    const rawCookies = typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : (headers.get('set-cookie') ? [headers.get('set-cookie')] : []);
    for (const raw of rawCookies) {
      if (!raw) continue;
      const first = raw.split(';')[0];
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const val = first.slice(eq + 1).trim();
      if (/max-age=0\b/i.test(raw) || val === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, val);
      }
    }
  }

  _cookieHeader() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  async request(method, pathOrUrl, opts = {}) {
    const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

    const headers = new Headers(opts.headers ?? {});
    const sendCookies = opts.cookies !== false;
    if (sendCookies && !headers.has('cookie')) {
      const c = this._cookieHeader();
      if (c) headers.set('cookie', c);
    }

    const useBearer = opts.bearer !== undefined ? opts.bearer : (opts.auth === false ? null : this.deviceToken);
    if (useBearer && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${useBearer}`);
    }

    if (opts.adminPassword && !headers.has('x-rokbot-admin-password')) {
      headers.set('x-rokbot-admin-password', opts.adminPassword);
    }

    if (opts.web || (this.cookies.has('rokbot_web') && opts.webHeader !== false && !useBearer)) {
      if (opts.webHeader !== false && !headers.has('x-rokbot-web')) {
        headers.set('x-rokbot-web', '1');
      }
    }

    const upper = String(method || 'GET').toUpperCase();
    const isAdminMutation = upper !== 'GET' && new URL(url).pathname.startsWith('/admin/api/');
    if (isAdminMutation) {
      if (opts.csrf !== false && !headers.has('x-rokbot-csrf')) {
        headers.set('x-rokbot-csrf', '1');
      }
      if (opts.origin !== false && !headers.has('origin')) {
        headers.set('origin', typeof opts.origin === 'string' ? opts.origin : this.baseUrl);
      }
    }

    let body = opts.body;
    if (body !== undefined && body !== null && typeof body === 'object' && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      body = JSON.stringify(body);
    }

    const res = await fetch(url, {
      method: upper,
      headers,
      body: upper === 'GET' || upper === 'HEAD' ? undefined : body,
      redirect: opts.redirect ?? 'manual',
      signal: opts.signal,
    });

    this._updateCookies(res.headers);
    const ab = await res.arrayBuffer();
    const buffer = Buffer.from(ab);
    const text = buffer.toString('utf8');
    let json = null;
    if (text.length > 0 && (res.headers.get('content-type') || '').includes('json')) {
      try { json = JSON.parse(text); } catch {}
    } else if (text.startsWith('{') || text.startsWith('[')) {
      try { json = JSON.parse(text); } catch {}
    }

    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buffer,
      text,
      json,
    };
  }

  adminRequest(method, reqPath, opts = {}) {
    return this.request(method, reqPath, { bearer: null, ...opts });
  }

  // Health & Public
  health() {
    return this.request('GET', '/health', { auth: false });
  }

  connectStatus(opts = {}) {
    return this.request('GET', '/connect/status', opts);
  }

  localStatus(opts = {}) {
    return this.request('GET', '/local/status', opts);
  }

  getIcon(method = 'GET') {
    return this.request(method, '/rokbot-icon.png', { auth: false });
  }

  // Admin Session & Devices
  adminSetup(setupKey, password, opts = {}) {
    return this.adminRequest('POST', '/admin/api/setup', {
      body: { setupKey, password },
      ...opts,
    });
  }

  async adminLogin(password = this.adminPassword, opts = {}) {
    const res = await this.adminRequest('POST', '/admin/api/login', {
      body: { password },
      ...opts,
    });
    if (res.ok && password) this.adminPassword = password;
    return res;
  }

  adminLogout(opts = {}) {
    return this.adminRequest('POST', '/admin/api/logout', { body: {}, ...opts });
  }

  adminSession(opts = {}) {
    return this.adminRequest('GET', '/admin/api/session', opts);
  }

  adminStatus(opts = {}) {
    return this.adminRequest('GET', '/admin/api/status', opts);
  }

  createPairingKey(opts = {}) {
    return this.adminRequest('POST', '/admin/api/pairing-keys', { body: {}, ...opts });
  }

  listDevices(opts = {}) {
    return this.adminRequest('GET', '/admin/api/devices', opts);
  }

  revokeDevice(deviceId, opts = {}) {
    return this.adminRequest('POST', `/admin/api/devices/${encodeURIComponent(deviceId)}/revoke`, {
      body: {},
      ...opts,
    });
  }

  // Pairing
  async pairWithKey({
    pairingKey,
    deviceName = 'E2E Device',
    platform = 'desktop',
    clientKind,
    clientDeviceId,
    bundleId,
  }, opts = {}) {
    const res = await this.request('POST', '/connect/pair', {
      auth: false,
      body: {
        pairingKey,
        deviceName,
        platform,
        ...(clientKind !== undefined ? { clientKind } : {}),
        ...(clientDeviceId !== undefined ? { clientDeviceId } : {}),
        ...(bundleId !== undefined ? { bundleId } : {}),
      },
      ...opts,
    });
    if (res.ok && res.json?.token) {
      this.deviceToken = res.json.token;
      this.deviceId = res.json.deviceId;
    }
    return res;
  }

  async pairWithPassword({
    password = this.adminPassword,
    deviceName = 'E2E Device',
    platform = 'desktop',
    clientKind,
    clientDeviceId,
    bundleId,
  }, opts = {}) {
    const res = await this.request('POST', '/connect/pair', {
      auth: false,
      body: {
        password,
        deviceName,
        platform,
        ...(clientKind !== undefined ? { clientKind } : {}),
        ...(clientDeviceId !== undefined ? { clientDeviceId } : {}),
        ...(bundleId !== undefined ? { bundleId } : {}),
      },
      ...opts,
    });
    if (res.ok && res.json?.token) {
      this.deviceToken = res.json.token;
      this.deviceId = res.json.deviceId;
    }
    return res;
  }

  // Web session
  webSession(opts = {}) {
    return this.request('GET', '/web/api/session', { auth: false, ...opts });
  }

  webPair({ pairingKey, deviceName = 'Web Client', clientDeviceId }, opts = {}) {
    return this.request('POST', '/web/api/pair', {
      auth: false,
      web: true,
      origin: this.baseUrl,
      body: { pairingKey, deviceName, ...(clientDeviceId ? { clientDeviceId } : {}) },
      ...opts,
    });
  }

  webLogout(opts = {}) {
    return this.request('POST', '/web/api/logout', {
      auth: false,
      web: true,
      origin: this.baseUrl,
      body: {},
      ...opts,
    });
  }

  getWebManifest(opts = {}) {
    return this.request('GET', '/web/manifest.webmanifest', { auth: false, ...opts });
  }

  adminOpenWebClient(body = {}, opts = {}) {
    return this.adminRequest('POST', '/admin/api/web-client/open', { body, ...opts });
  }

  // Model Configuration
  getLocalModel(opts = {}) {
    return this.request('GET', '/local/model', opts);
  }

  putLocalModel(body, opts = {}) {
    return this.request('PUT', '/local/model', { body, ...opts });
  }

  probeModelCatalog(body = {}, opts = {}) {
    return this.request('POST', '/local/model/catalog', { body, ...opts });
  }

  testModel(body = {}, opts = {}) {
    return this.request('POST', '/local/model/test', { body, ...opts });
  }

  // Auto-Update Admin & Client
  adminListUpdates(opts = {}) {
    return this.adminRequest('GET', '/admin/api/updates', opts);
  }

  adminUploadUpdate({ platform, filename, bytes, contentType = 'application/octet-stream', multipart = false }, opts = {}) {
    const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
    const mergedHeaders = new Headers(opts.headers ?? {});
    if (multipart) {
      const boundary = `----RokBotE2E${randomBytes(8).toString('hex')}`;
      const head = Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="platform"\r\n\r\n${platform}\r\n` +
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
        'utf8',
      );
      const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
      mergedHeaders.set('content-type', `multipart/form-data; boundary=${boundary}`);
      return this.adminRequest('POST', '/admin/api/updates/upload', {
        ...opts,
        headers: mergedHeaders,
        body: Buffer.concat([head, data, tail]),
      });
    }
    const qs = `?platform=${encodeURIComponent(platform)}&filename=${encodeURIComponent(filename)}`;
    if (!mergedHeaders.has('content-type')) mergedHeaders.set('content-type', contentType);
    if (!mergedHeaders.has('x-rokbot-platform')) mergedHeaders.set('x-rokbot-platform', platform);
    if (!mergedHeaders.has('x-rokbot-filename')) mergedHeaders.set('x-rokbot-filename', filename);
    return this.adminRequest('POST', `/admin/api/updates/upload${qs}`, {
      ...opts,
      headers: mergedHeaders,
      body: data,
    });
  }

  adminPublishUpdate(body, opts = {}) {
    return this.adminRequest('POST', '/admin/api/updates/publish', { body, ...opts });
  }

  adminDeleteUpdate(platform, releaseId, opts = {}) {
    return this.adminRequest(
      'DELETE',
      `/admin/api/updates/${encodeURIComponent(platform)}/${encodeURIComponent(releaseId)}`,
      opts,
    );
  }

  getUpdateManifest(platform, opts = {}) {
    return this.request('GET', `/local/updates/${encodeURIComponent(platform)}.json`, opts);
  }

  downloadUpdateFile(urlOrPath, { range, method = 'GET', ...opts } = {}) {
    const headers = new Headers(opts.headers ?? {});
    if (range) headers.set('range', range);
    return this.request(method, urlOrPath, { ...opts, headers });
  }

  fetchUpdateProxy(targetUrl, method = 'GET', opts = {}) {
    return this.request(method, `/local/updates/fetch?url=${encodeURIComponent(targetUrl)}`, opts);
  }

  fetchIosPlist(urlOrToken, opts = {}) {
    const target = urlOrToken.startsWith('http') || urlOrToken.startsWith('/')
      ? urlOrToken
      : `/updates/ios/${encodeURIComponent(urlOrToken)}/manifest.plist`;
    return this.request('GET', target, { auth: false, ...opts });
  }

  fetchIosAltStore(urlOrToken, opts = {}) {
    const target = urlOrToken.startsWith('http') || urlOrToken.startsWith('/')
      ? urlOrToken
      : `/updates/ios/${encodeURIComponent(urlOrToken)}/altstore.json`;
    return this.request('GET', target, { auth: false, ...opts });
  }

  // Bot API, Computers, Files, Attachments, Notifications, Push, Voice, Connectors
  apiCall(method, body = {}, opts = {}) {
    return this.request('POST', `/api/${method}`, { body, ...opts });
  }

  /**
   * createAgent normalized across the harness and the live 2bb5e41 Host.
   * The live Host requires `description: string` and answers `{ agent: { id, ... } }`, while the harness
   * answers a bare agent object. The returned response keeps `status`/`json` and adds `agent` + `agentId`.
   */
  async createAgent(fields = {}, opts = {}) {
    const res = await this.apiCall('createAgent', { description: '', ...fields }, opts);
    const agent = res.json && typeof res.json === 'object'
      ? (res.json.agent && typeof res.json.agent === 'object' ? res.json.agent : res.json)
      : null;
    res.agent = agent;
    res.agentId = typeof agent?.id === 'string' ? agent.id : null;
    return res;
  }

  getComputers(opts = {}) {
    return this.request('GET', '/local/computers', opts);
  }

  listFiles(agentId, opts = {}) {
    return this.request('GET', `/local/files?agentId=${encodeURIComponent(agentId)}`, opts);
  }

  uploadFile(body, opts = {}) {
    return this.request('POST', '/local/files', { body, ...opts });
  }

  deleteFile(body, opts = {}) {
    return this.request('DELETE', '/local/files', { body, ...opts });
  }

  getFileContent(agentId, name, opts = {}) {
    return this.request(
      'GET',
      `/local/files/content?agentId=${encodeURIComponent(agentId)}&name=${encodeURIComponent(name)}`,
      opts,
    );
  }

  readAttachment(url, opts = {}) {
    return this.request('POST', '/connect/attachment', { body: { url }, ...opts });
  }

  getNotifications(after = null, opts = {}) {
    const qs = after !== null && after !== undefined ? `?after=${encodeURIComponent(after)}` : '';
    return this.request('GET', `/notifications${qs}`, opts);
  }

  getDevice(opts = {}) {
    return this.request('GET', '/local/device', opts);
  }

  updateDevice(body, opts = {}) {
    return this.request('PUT', '/local/device', { body, ...opts });
  }

  testDevicePush(body = {}, opts = {}) {
    return this.request('POST', '/local/device/push/test', { body, ...opts });
  }

  getVoiceStatus(opts = {}) {
    return this.request('GET', '/local/voice/status', opts);
  }

  listConnectors(opts = {}) {
    return this.request('GET', '/local/connectors', opts);
  }

  // SSE Stream Client
  async openSse(reqPath, { headers: extraHeaders = {}, lastEventId = null, timeoutMs = 5000, webHeader, web } = {}) {
    const url = reqPath.startsWith('http://') || reqPath.startsWith('https://')
      ? reqPath
      : `${this.baseUrl}${reqPath.startsWith('/') ? '' : '/'}${reqPath}`;

    const controller = new AbortController();
    const headers = new Headers(extraHeaders);
    const cookieStr = this._cookieHeader();
    if (cookieStr && !headers.has('cookie')) headers.set('cookie', cookieStr);
    if (this.deviceToken && !headers.has('authorization')) {
      headers.set('authorization', `Bearer ${this.deviceToken}`);
    }
    if ((web || (this.cookies.has('rokbot_web') && !this.deviceToken)) && webHeader !== false && !headers.has('x-rokbot-web')) {
      headers.set('x-rokbot-web', '1');
    }
    if (lastEventId !== null && lastEventId !== undefined) {
      headers.set('last-event-id', String(lastEventId));
    }

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      controller.abort();
      throw new Error(`SSE connect failed (${res.status}): ${errBody}`);
    }

    const events = [];
    const comments = [];
    const waiters = [];
    let readIndex = 0;
    let closed = false;

    const notifyWaiters = () => {
      for (let i = 0; i < waiters.length; i++) {
        const w = waiters[i];
        let matchedIndex = -1;
        for (let j = readIndex; j < events.length; j++) {
          if (w.predicate(events[j])) {
            matchedIndex = j;
            break;
          }
        }
        if (matchedIndex >= 0) {
          waiters.splice(i, 1);
          i--;
          const found = events[matchedIndex];
          if (w.consume) readIndex = matchedIndex + 1;
          w.resolve(found);
        }
      }
    };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const pump = (async () => {
      try {
        while (!closed) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const rawBlock = buffer.slice(0, idx);
            const sepMatch = /\r?\n\r?\n/.exec(buffer.slice(idx));
            buffer = buffer.slice(idx + (sepMatch ? sepMatch[0].length : 2));
            if (!rawBlock) continue;

            let id = null;
            let eventType = 'message';
            const dataLines = [];
            for (const line of rawBlock.split(/\r?\n/)) {
              if (line.startsWith(':')) {
                comments.push(line.slice(1).trim());
              } else if (line.startsWith('id:')) {
                id = line.slice(3).trim();
              } else if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart());
              }
            }
            if (dataLines.length > 0) {
              const rawData = dataLines.join('\n');
              let data = rawData;
              try { data = JSON.parse(rawData); } catch {}
              events.push({ id, event: eventType, data, rawData });
              notifyWaiters();
            }
          }
        }
      } catch {
        // aborted or closed
      }
    })();

    const handle = {
      status: res.status,
      headers: res.headers,
      events,
      comments,
      get readIndex() {
        return readIndex;
      },
      async nextEvent(predicate = () => true, waitTimeoutMs = timeoutMs, { consume = true } = {}) {
        for (let i = readIndex; i < events.length; i++) {
          if (predicate(events[i])) {
            if (consume) readIndex = i + 1;
            return events[i];
          }
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const idx = waiters.indexOf(entry);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`Timed out waiting for SSE event after ${waitTimeoutMs}ms`));
          }, waitTimeoutMs);
          timer.unref?.();
          const entry = {
            predicate,
            consume,
            resolve(ev) {
              clearTimeout(timer);
              resolve(ev);
            },
          };
          waiters.push(entry);
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        controller.abort();
        await reader.cancel().catch(() => {});
        await pump.catch(() => {});
        handle._cleanup?.();
      },
    };

    handle._cleanup = () => this._sseHandles.delete(handle);
    this._sseHandles.add(handle);
    return handle;
  }

  async close() {
    for (const h of [...this._sseHandles]) {
      await h.close();
    }
    this._sseHandles.clear();
  }
}
