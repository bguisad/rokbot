import { randomInt, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { JsonStore, writePrivate } from "./storage.mjs";
import {
  check,
  equal,
  hash,
  jsonBody,
  passwordHash,
  secret,
  sendJson,
  verifyPassword,
} from "./security.mjs";

const publicDevice = ({
  id,
  name,
  platform,
  clientDeviceId,
  bundleId,
  pairedWith,
  createdAt,
  revokedAt,
  lastSeenAt,
}) => ({
  id,
  name,
  platform,
  clientDeviceId: clientDeviceId ?? null,
  bundleId: bundleId ?? null,
  pairedWith: pairedWith ?? null,
  createdAt,
  revokedAt,
  lastSeenAt,
});
export function isAdminPairedDevice(device) {
  return device?.pairedWith === "password" || device?.pairedWith === "admin-web";
}
const normalizeKey = (value) =>
  typeof value === "string" ? value.replace(/[\s-]/g, "").toUpperCase() : "";
export const validDeviceName = (value) =>
  check(
    typeof value === "string" && value.trim().length > 0 && value.length <= 80,
    400,
    "设备名称需要 1–80 个字符",
  );
const seenAtMs = (item) => {
  const t = Date.parse(item.lastSeenAt ?? item.createdAt ?? 0);
  return Number.isFinite(t) ? t : 0;
};
export function normalizeClientDeviceId(value) {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string", 400, "客户端设备 ID 无效");
  const trimmed = value.trim();
  if (!trimmed) return null;
  check(
    trimmed.length <= 128 && /^[A-Za-z0-9._:@-]+$/.test(trimmed),
    400,
    "客户端设备 ID 无效",
  );
  return trimmed;
}
export function normalizeBundleId(value) {
  if (value === undefined || value === null || value === "") return null;
  check(typeof value === "string", 400, "设备 Bundle ID 无效");
  const trimmed = value.trim();
  if (!trimmed) return null;
  check(
    trimmed.length <= 128 && /^[A-Za-z0-9._-]+$/.test(trimmed),
    400,
    "设备 Bundle ID 无效",
  );
  return trimmed;
}
export class Auth {
  constructor(
    dataDir,
    { sessionMs = 12 * 60 * 60_000, pairingMs = 5 * 60_000 } = {},
  ) {
    this.dataDir = dataDir;
    this.sessionMs = sessionMs;
    this.pairingMs = pairingMs;
    this.touchWrites = new Map();
    this.store = new JsonStore(join(dataDir, "auth.json"), {
      version: 1,
      admin: null,
      sessions: [],
      devices: [],
      pairing: [],
    });
  }
  async load() {
    await this.store.load();
    if (!this.initialized) {
      const filename = join(this.dataDir, "setup-key");
      this.setupKey = await readFile(filename, "utf8")
        .then((value) => value.trim())
        .catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
      if (!this.setupKey) {
        this.setupKey = secret();
        await writePrivate(filename, `${this.setupKey}\n`);
      }
    }
    return this;
  }
  get initialized() {
    return Boolean(this.store.value.admin);
  }
  async setup(key, password) {
    check(!this.initialized, 409, "管理员已经设置");
    check(equal(key, this.setupKey), 401, "初始化 Key 无效");
    const admin = await passwordHash(password);
    const token = secret();
    await this.store.mutate((state) => {
      check(!state.admin, 409, "管理员已经设置");
      state.admin = admin;
      state.sessions = [
        { hash: hash(token), expiresAt: Date.now() + this.sessionMs },
      ];
    });
    this.setupKey = null;
    await rm(join(this.dataDir, "setup-key"), { force: true });
    return token;
  }
  async login(password) {
    check(this.initialized, 409, "请先设置管理员");
    check(
      await verifyPassword(password, this.store.value.admin),
      401,
      "管理员密码不正确",
    );
    const token = secret();
    await this.store.mutate((state) => {
      state.sessions = state.sessions
        .filter((item) => item.expiresAt > Date.now())
        .slice(-19);
      state.sessions.push({
        hash: hash(token),
        expiresAt: Date.now() + this.sessionMs,
      });
    });
    return token;
  }
  adminSession(token) {
    if (typeof token !== "string") return false;
    const fingerprint = hash(token), now = Date.now();
    return this.store.value.sessions.some(item => item.hash === fingerprint && item.expiresAt > now);
  }
  async logout(token) {
    await this.store.mutate((state) => {
      state.sessions = state.sessions.filter(
        (item) => item.hash !== hash(token),
      );
    });
  }
  async createPairing() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let key;
    const expiresAt = Date.now() + this.pairingMs;
    const id = randomUUID();
    await this.store.mutate((state) => {
      state.pairing = state.pairing
        .filter((item) => item.expiresAt > Date.now())
        .slice(-19);
      do { key = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(""); }
      while (state.pairing.some(item => item.hash === hash(key)));
      state.pairing.push({ id, hash: hash(key), expiresAt });
    });
    return {
      id,
      pairingKey: key,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }
  pairingKeys() {
    return this.store.value.pairing
      .filter((item) => item.expiresAt > Date.now())
      .map(({ id, expiresAt }) => ({ id, expiresAt }));
  }
  /**
   * Pairs a client with a one-time code or administrator password. `web` is set only by the Host's
   * own web client sign-in; clients pairing through /connect/pair are desktops, Android phones or iOS devices.
   */
  async pair(
    {
      pairingKey,
      password,
      deviceName,
      platform,
      clientKind,
      clientDeviceId,
      bundleId,
    },
    { web = false, legacyBundleIdFor = null } = {},
  ) {
    validDeviceName(deviceName);
    const normalizedClientDeviceId = normalizeClientDeviceId(clientDeviceId);
    const normalizedBundleId = normalizeBundleId(bundleId);
    if (!web) check(
      ["desktop", "ios"].includes(platform),
      400,
      "设备类型应为 desktop 或 ios",
    );
    const hasKey = pairingKey !== undefined && pairingKey !== null;
    const hasPassword = password !== undefined && password !== null;
    check(!(hasKey && hasPassword), 400, "请只提供配对码或管理员密码之一");
    check(hasKey || hasPassword, 400, "请提供配对码或管理员密码");
    if (hasPassword) {
      check(typeof password === "string" && password.length > 0, 400, "请输入管理员密码");
      check(this.initialized, 409, "请先设置管理员");
      check(
        await verifyPassword(password, this.store.value.admin),
        401,
        "管理员密码不正确",
      );
    }
    const kind = web ? "web" : platform === "desktop" && clientKind === "android" ? "android" : platform;
    const pairedWith = hasPassword ? "password" : "pairing-key";
    return this.addDevice(
      deviceName,
      kind,
      state => {
        if (hasPassword) return () => {};
        const index = state.pairing.findIndex(
          (item) =>
            item.hash === hash(normalizeKey(pairingKey)) &&
            item.expiresAt > Date.now(),
        );
        check(index >= 0, 401, "配对码无效、已使用或已过期");
        return () => state.pairing.splice(index, 1);
      },
      {
        clientDeviceId: normalizedClientDeviceId,
        bundleId: normalizedBundleId,
        legacyBundleIdFor,
        pairedWith,
      },
    );
  }
  /** A browser opened from the signed-in admin page; the administrator needs no pairing code. */
  async addWebDevice(deviceName, { clientDeviceId = null } = {}) {
    const normalizedClientDeviceId = normalizeClientDeviceId(clientDeviceId);
    return this.addDevice(deviceName, "web", () => () => {}, {
      clientDeviceId: normalizedClientDeviceId,
      pairedWith: "admin-web",
    });
  }
  async addDevice(
    deviceName,
    platform,
    authorize,
    { clientDeviceId = null, bundleId = null, legacyBundleIdFor = null, pairedWith = null } = {},
  ) {
    validDeviceName(deviceName);
    const trimmedName = deviceName.trim();
    const token = secret();
    const generatedId = randomUUID();
    let finalId = generatedId;
    let reused = false;
    const revokedDuplicateIds = [];
    await this.store.mutate((state) => {
      const consume = authorize(state);
      const now = new Date().toISOString();
      let matches = [];
      if (clientDeviceId) {
        const nameLower = trimmedName.toLowerCase();
        const byId = new Map();
        for (const item of state.devices) {
          if (item.revokedAt || item.platform !== platform) continue;
          if (item.clientDeviceId === clientDeviceId) {
            byId.set(item.id, item);
          } else if (
            bundleId &&
            !item.clientDeviceId &&
            (item.bundleId ?? legacyBundleIdFor?.(item.id) ?? null) === bundleId &&
            typeof item.name === "string" &&
            item.name.trim().toLowerCase() === nameLower
          ) {
            byId.set(item.id, item);
          }
        }
        matches = [...byId.values()].sort(
          (a, b) => seenAtMs(b) - seenAtMs(a),
        );
      }
      if (matches.length > 0) {
        const primary = matches[0];
        primary.name = trimmedName;
        primary.hash = hash(token);
        primary.clientDeviceId = clientDeviceId;
        if (bundleId) primary.bundleId = bundleId;
        primary.pairedWith = pairedWith;
        primary.lastSeenAt = now;
        finalId = primary.id;
        reused = true;
        for (const dup of matches.slice(1)) {
          dup.revokedAt ??= now;
          revokedDuplicateIds.push(dup.id);
        }
        consume();
      } else {
        check(
          state.devices.filter((item) => !item.revokedAt).length < 100,
          409,
          "设备数量已达上限，请先撤销不用的设备",
        );
        consume();
        state.devices.push({
          id: generatedId,
          name: trimmedName,
          platform,
          clientDeviceId,
          bundleId,
          pairedWith,
          hash: hash(token),
          createdAt: now,
          revokedAt: null,
          lastSeenAt: now,
        });
      }
    });
    return { deviceId: finalId, token, reused, revokedDuplicateIds };
  }
  async bindClientIdentity(
    id,
    {
      clientDeviceId = null,
      bundleId = null,
      legacyName = null,
      legacyBundleIdFor = null,
    } = {},
  ) {
    const normalizedClientDeviceId = normalizeClientDeviceId(clientDeviceId);
    const normalizedBundleId = normalizeBundleId(bundleId);
    const revokedDuplicateIds = [];
    if (!normalizedClientDeviceId && !normalizedBundleId) {
      return { revokedDuplicateIds };
    }
    await this.store.mutate((state) => {
      const current = state.devices.find((item) => item.id === id && !item.revokedAt);
      if (!current) return;
      if (normalizedClientDeviceId) current.clientDeviceId = normalizedClientDeviceId;
      if (normalizedBundleId) current.bundleId = normalizedBundleId;
      const effectiveBundleId = current.bundleId ?? legacyBundleIdFor?.(current.id) ?? null;
      const nameLower = typeof (legacyName ?? current.name) === "string"
        ? (legacyName ?? current.name).trim().toLowerCase()
        : "";
      const now = new Date().toISOString();
      for (const other of state.devices) {
        if (other.id === id || other.revokedAt || other.platform !== current.platform) continue;
        const sameClientId = Boolean(
          normalizedClientDeviceId && other.clientDeviceId === normalizedClientDeviceId,
        );
        const sameLegacyIdentity = Boolean(
          !other.clientDeviceId &&
          effectiveBundleId &&
          nameLower &&
          (other.bundleId ?? legacyBundleIdFor?.(other.id) ?? null) === effectiveBundleId &&
          typeof other.name === "string" &&
          other.name.trim().toLowerCase() === nameLower,
        );
        if (sameClientId || sameLegacyIdentity) {
          other.revokedAt ??= now;
          revokedDuplicateIds.push(other.id);
        }
      }
    });
    return { revokedDuplicateIds };
  }
  authenticate(token) {
    if (typeof token !== "string") return null;
    const fingerprint = hash(token);
    const device = this.store.value.devices.find(
      (item) => !item.revokedAt && item.hash === fingerprint,
    );
    return device ? publicDevice(device) : null;
  }
  device(id) {
    return this.store.value.devices.find(
      (item) => item.id === id && !item.revokedAt,
    );
  }
  devices() {
    return this.store.value.devices.map(publicDevice);
  }
  async touch(id) {
    const device = this.device(id);
    if (!device || Date.now() - Date.parse(device.lastSeenAt ?? 0) < 60_000)
      return;
    // One page load can request many resources before the first fsync has finished.
    const inflight = this.touchWrites.get(id);
    if (inflight) return inflight;
    const pending = this.store.mutate((state) => {
      const current = state.devices.find(
        (item) => item.id === id && !item.revokedAt,
      );
      if (current) current.lastSeenAt = new Date().toISOString();
    });
    this.touchWrites.set(id, pending);
    try { await pending; } finally { this.touchWrites.delete(id); }
  }
  async revoke(id) {
    await this.store.mutate((state) => {
      const device = state.devices.find((item) => item.id === id);
      check(device, 404, "设备不存在");
      device.revokedAt ??= new Date().toISOString();
    });
  }
}

export async function handleConnectPair({
  request,
  response,
  origin,
  auth,
  federation,
  limiter,
  legacyBundleIdFor = null,
  onPaired = null,
}) {
  check(federation.role() === 'primary', 403, 'Connect to the primary Host');
  limiter.check(`pair:${request.socket.remoteAddress}`, 6);
  limiter.check("pair:global", 60);
  const body = await jsonBody(request);
  if (body.password !== undefined && body.password !== null) {
    limiter.check(`pair-password:${request.socket.remoteAddress}`, 5);
    limiter.check("pair-password:global", 20);
  }
  const result = await auth.pair(body, { legacyBundleIdFor });
  if (onPaired) {
    await onPaired(result);
  }
  return sendJson(response, 201, {
    deviceId: result.deviceId,
    token: result.token,
    gatewayUrl: origin,
    notificationUrl: `${origin}/notifications/events`,
  });
}
