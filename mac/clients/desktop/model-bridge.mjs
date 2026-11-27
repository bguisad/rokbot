import { rokText } from './i18n.mjs';

const SECRET_KEYS = new Set(['apiKey', 'jevApiKey']);

function isBlankSecret(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function sanitizeNode(value) {
  if (Array.isArray(value)) {
    return value.map(item => sanitizeNode(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'adminPassword') continue;
    if (SECRET_KEYS.has(key) && isBlankSecret(entry)) continue;
    out[key] = sanitizeNode(entry);
  }
  return out;
}

export function sanitizeModelPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return sanitizeNode(payload);
}

function extractAdminHeaders(payload) {
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.adminPassword : undefined;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { 'x-rokbot-admin-password': raw };
  }
  return null;
}

function normalizeReload(reload) {
  if (!reload || typeof reload !== 'object') return reload;
  return {
    ...reload,
    error: reload.error ?? reload.message ?? '',
  };
}

function normalizeModelResponse(data) {
  if (!data || typeof data !== 'object') return { ok: true };
  const normalized = { ok: true, ...data };
  if (normalized.reload && typeof normalized.reload === 'object') {
    normalized.reload = normalizeReload(normalized.reload);
  }
  if (normalized.config && typeof normalized.config === 'object' && normalized.config.reload) {
    normalized.config = {
      ...normalized.config,
      reload: normalizeReload(normalized.config.reload),
    };
  }
  return normalized;
}

// Only the known report parameters, as strings of bounded length.
const USAGE_REPORT_KEYS = ['range', 'from', 'to', 'model', 'provider', 'profile', 'kind', 'agent', 'status', 'offset', 'limit'];
function usageReportQuery(timeZone, report) {
  const query = new URLSearchParams({ timeZone });
  for (const key of USAGE_REPORT_KEYS) {
    const value = report[key];
    if ((typeof value === 'string' && value) || Number.isFinite(value)) query.set(key, String(value).slice(0, 300));
  }
  if (report.export === 'csv') query.set('export', 'csv');
  return query.toString();
}

export function createModelBridge({ getGateway, getConnected, text = rokText } = {}) {
  const disconnectedResult = () => ({
    ok: false,
    status: 503,
    error: text('未连接到 Host，请先连接。', 'Not connected to Host.'),
  });

  const failureResult = error => {
    const status = Number.isInteger(error?.httpStatus)
      ? error.httpStatus
      : error?.name === 'TimeoutError'
        ? 504
        : 500;
    return {
      ok: false,
      status,
      error: error?.message || text('请求失败，请稍后重试。', 'Request failed. Try again.'),
      ...(error?.failureCode ? { failureCode: error.failureCode } : {}),
      ...(status === 401 || status === 403 ? { canConfigureModel: false } : {}),
    };
  };

  const activeGateway = () => {
    const gw = getGateway?.();
    if (!getConnected?.() || !gw) return null;
    return gw;
  };

  return {
    async getLocalStatus() {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      try {
        const data = await gw.request('/local/status', undefined, AbortSignal.timeout(15000), 'GET');
        return { ok: true, ...(data && typeof data === 'object' ? data : {}) };
      } catch (error) {
        return failureResult(error);
      }
    },

    /** The Host's token usage (GET /local/usage): today's totals, `periods` and per-model rows. */
    async getUsage(payload = {}) {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      try {
        let timeZone = typeof payload?.timeZone === 'string' ? payload.timeZone : '';
        try { if (timeZone) new Intl.DateTimeFormat('en', { timeZone }); } catch { timeZone = ''; }
        if (!timeZone) timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
        // `report` asks for the usage report (GET /local/usage/report) with its range, filters,
        // page or CSV export; without it the original summary.
        const report = payload?.report && typeof payload.report === 'object' ? payload.report : null;
        const path = report ? `/local/usage/report?${usageReportQuery(timeZone, report)}` : `/local/usage?timeZone=${encodeURIComponent(timeZone)}`;
        const data = await gw.request(path, undefined, AbortSignal.timeout(report?.export ? 60000 : 20000), 'GET');
        return { ok: true, ...(data && typeof data === 'object' ? data : {}) };
      } catch (error) {
        return failureResult(error);
      }
    },

    async getModelConfig() {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      try {
        const data = await gw.request('/local/model', undefined, AbortSignal.timeout(15000), 'GET');
        return normalizeModelResponse(data);
      } catch (error) {
        return failureResult(error);
      }
    },

    async updateModelConfig(payload = {}) {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      try {
        const body = sanitizeModelPayload(payload);
        const headers = extractAdminHeaders(payload);
        const data = await gw.request('/local/model', body, AbortSignal.timeout(30000), 'PUT', headers);
        return normalizeModelResponse(data);
      } catch (error) {
        return failureResult(error);
      }
    },

    async fetchModelCatalog(payload = {}) {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      try {
        const body = sanitizeModelPayload(payload);
        const headers = extractAdminHeaders(payload);
        const data = await gw.request('/local/model/catalog', body, AbortSignal.timeout(25000), 'POST', headers);
        return { ok: true, ...(data && typeof data === 'object' ? data : {}) };
      } catch (error) {
        return failureResult(error);
      }
    },

    async testModelConfig(payload = {}) {
      const gw = activeGateway();
      if (!gw) return disconnectedResult();
      const started = Date.now();
      try {
        const body = sanitizeModelPayload(payload);
        const headers = extractAdminHeaders(payload);
        const data = await gw.request('/local/model/test', body, AbortSignal.timeout(125000), 'POST', headers);
        const elapsed = Math.max(0, Date.now() - started);
        return {
          ok: true,
          ...(data && typeof data === 'object' ? data : {}),
          latencyMs: typeof data?.latencyMs === 'number' ? data.latencyMs : elapsed,
          reply: data?.reply ?? data?.message ?? '',
        };
      } catch (error) {
        return failureResult(error);
      }
    },
  };
}
