// Connection speed test for paired devices (Android "Connection & Diagnostics").
//
//   GET  /local/speedtest/ping                 -> {"ok":true,"at":<ms>}      round-trip probe
//   GET  /local/speedtest/download?bytes=N     -> N incompressible bytes      (1 <= N <= maxBytes)
//   POST /local/speedtest/upload               -> {"bytes":N,"ms":T}          (body <= maxBytes)
//
// The caller authenticates the device first (index.mjs). Limits, per device: 120 pings and
// 24 transfers a minute, 2 transfers at a time (6 for the whole Host), maxBytes (32 MiB) per
// transfer and a 60 s cap on every transfer. Payload bytes are random so a compressing proxy
// cannot shrink them; responses are never cached.
import { randomBytes } from "node:crypto";
import { check, sendJson } from "./security.mjs";

export const SPEEDTEST_MAX_BYTES = 32 * 1024 * 1024;
export const SPEEDTEST_DEFAULT_BYTES = 4 * 1024 * 1024;
export const SPEEDTEST_LIMITS = Object.freeze({
  pingsPerMinute: 120,
  transfersPerMinute: 24,
  activePerDevice: 2,
  activeTotal: 6,
  transferTimeoutMs: 60_000,
});
const CHUNK_BYTES = 64 * 1024;

/** The `bytes` query value: a whole number in 1..max, else a 400 (no silent clamping). */
export function parseSpeedTestBytes(raw, max = SPEEDTEST_MAX_BYTES, fallback = SPEEDTEST_DEFAULT_BYTES) {
  if (raw == null || raw === "") return Math.min(fallback, max);
  check(/^\d{1,10}$/.test(String(raw)), 400, "bytes 必须是正整数");
  const value = Number(raw);
  check(value >= 1, 400, "bytes 必须是正整数");
  check(value <= max, 400, `bytes 不能超过 ${max}`);
  return value;
}

/**
 * Speed test routes. `limiter` is the server's RateLimit; `handle` returns true when it
 * answered the request. `now` is injectable for tests.
 */
export function createSpeedTest({ limiter, maxBytes = SPEEDTEST_MAX_BYTES, limits = SPEEDTEST_LIMITS, now = Date.now } = {}) {
  check(limiter && typeof limiter.check === "function", 500, "speed test needs a rate limiter");
  const pattern = randomBytes(CHUNK_BYTES);
  const active = new Map();
  let activeTotal = 0;

  function acquire(deviceId) {
    const mine = active.get(deviceId) ?? 0;
    check(activeTotal < limits.activeTotal && mine < limits.activePerDevice, 429, "测速进行中，请稍后重试");
    active.set(deviceId, mine + 1);
    activeTotal++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      activeTotal--;
      const left = (active.get(deviceId) ?? 1) - 1;
      if (left > 0) active.set(deviceId, left);
      else active.delete(deviceId);
    };
  }

  function guard(response, release, onTimeout) {
    const timer = setTimeout(onTimeout, limits.transferTimeoutMs);
    timer.unref?.();
    const done = () => { clearTimeout(timer); release(); };
    response.once("close", done);
    response.once("finish", done);
    return done;
  }

  async function download(request, response, url, deviceId) {
    const bytes = parseSpeedTestBytes(url.searchParams.get("bytes"), maxBytes);
    limiter.check(`speedtest-transfer:${deviceId}`, limits.transfersPerMinute);
    const release = acquire(deviceId);
    guard(response, release, () => response.destroy());
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      "cache-control": "no-store",
      "content-encoding": "identity",
      "x-content-type-options": "nosniff",
      "x-rokbot-speedtest-bytes": String(bytes),
    });
    let left = bytes;
    while (left > 0 && !response.destroyed) {
      const size = Math.min(left, CHUNK_BYTES);
      left -= size;
      const ok = response.write(size === CHUNK_BYTES ? pattern : pattern.subarray(0, size));
      if (!ok && left > 0) {
        await new Promise(resolve => {
          const next = () => { response.off("drain", next); response.off("close", next); resolve(); };
          response.on("drain", next);
          response.on("close", next);
        });
      }
    }
    if (!response.destroyed) response.end();
    return true;
  }

  async function upload(request, response, deviceId) {
    const declared = request.headers["content-length"];
    if (declared != null) {
      check(/^\d+$/.test(String(declared)), 400, "Content-Length 无效");
      check(Number(declared) <= maxBytes, 413, `上传不能超过 ${maxBytes} 字节`);
    }
    limiter.check(`speedtest-transfer:${deviceId}`, limits.transfersPerMinute);
    const release = acquire(deviceId);
    let timedOut = false;
    guard(response, release, () => { timedOut = true; request.destroy(); });
    let size = 0;
    let first = null;
    const outcome = await new Promise(resolve => {
      request.on("data", chunk => {
        if (first === null) first = now();
        size += chunk.length;
        if (size > maxBytes) {
          request.pause();
          request.removeAllListeners("data");
          resolve("too-large");
        }
      });
      request.once("end", () => resolve("ok"));
      request.once("error", () => resolve("aborted"));
      request.once("close", () => resolve(request.complete ? "ok" : "aborted"));
    });
    if (outcome === "too-large") {
      // Answer first, then drop the connection instead of reading the rest of the body.
      response.setHeader("connection", "close");
      response.once("finish", () => request.destroy());
      sendJson(response, 413, { error: `上传不能超过 ${maxBytes} 字节` });
      return true;
    }
    if (outcome !== "ok") {
      if (timedOut && !response.destroyed) sendJson(response, 408, { error: "测速超时" });
      return true;
    }
    sendJson(response, 200, { bytes: size, ms: first === null ? 0 : Math.max(0, now() - first) });
    return true;
  }

  async function handle(request, response, path, url, deviceId) {
    if (path === "/local/speedtest/ping") {
      check(request.method === "GET", 405, "请使用 GET");
      limiter.check(`speedtest-ping:${deviceId}`, limits.pingsPerMinute);
      sendJson(response, 200, { ok: true, at: now() });
      return true;
    }
    if (path === "/local/speedtest/download") {
      check(request.method === "GET", 405, "请使用 GET");
      return download(request, response, url, deviceId);
    }
    if (path === "/local/speedtest/upload") {
      check(request.method === "POST", 405, "请使用 POST");
      return upload(request, response, deviceId);
    }
    return false;
  }

  return { handle, activeCount: () => activeTotal };
}
