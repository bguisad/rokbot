// Local canvas store: the self-hosted counterpart of the official cloud canvas service.
// A canvas is one `.canvas.tsx` React module written by the bot. The Host keeps its source,
// a compiled bundle and a random access token under `<dataDir>/canvases/`; the HTTP layer
// (canvas-http.mjs) serves it at `/canvas/<token>`. Both the bot runtime (which writes) and
// the selfhost service (which serves) open the same directory.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writePrivate, readJson } from "./storage.mjs";

export const CANVAS_SOURCE_MAX_BYTES = 512 * 1024;
export const CANVAS_TITLE_MAX_CHARS = 120;
export const CANVAS_DIR_NAME = "canvases";
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const CANVAS_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Writes are serialized per root so concurrent tool calls never lose a token entry.
const locks = new Map();
function serialized(root, task) {
  const previous = locks.get(root) ?? Promise.resolve();
  const run = previous.then(task, task);
  const tail = run.catch(() => {});
  locks.set(root, tail);
  tail.then(() => { if (locks.get(root) === tail) locks.delete(root); });
  return run;
}

export function canvasRoot(dataDir) {
  return join(dataDir, CANVAS_DIR_NAME);
}

export function isCanvasId(value) {
  return typeof value === "string" && ID_RE.test(value.trim().toLowerCase());
}

function cleanTitle(value) {
  if (typeof value !== "string") return undefined;
  const title = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, CANVAS_TITLE_MAX_CHARS) : undefined;
}

/**
 * The canonical link path of a canvas. Shaped like the official
 * `/canvas/<storeId>/<canvasId>` links (store = owning bot) with the unguessable
 * token in place of the store id, so possessing the link is the read grant.
 */
export function canvasPath(meta) {
  return `/canvas/${meta.token}`;
}

export class CanvasStore {
  constructor(dataDir, { compile } = {}) {
    this.root = canvasRoot(dataDir);
    this.compile = compile;
  }

  dir(canvasId) {
    if (!isCanvasId(canvasId)) throw new Error("Invalid canvas id");
    return join(this.root, canvasId.toLowerCase());
  }

  async readMeta(canvasId) {
    if (!isCanvasId(canvasId)) return null;
    return await readJson(join(this.dir(canvasId), "meta.json"), null);
  }

  async readTokens() {
    return await readJson(join(this.root, "tokens.json"), {});
  }

  /** Resolve an access token to the canvas meta, or null. */
  async byToken(token) {
    if (typeof token !== "string" || !CANVAS_TOKEN_RE.test(token)) return null;
    const tokens = await this.readTokens();
    const canvasId = Object.hasOwn(tokens, token) ? tokens[token] : undefined;
    if (!canvasId) return null;
    const meta = await this.readMeta(canvasId);
    return meta && meta.token === token ? meta : null;
  }

  async readSource(canvasId) {
    return await readFile(join(this.dir(canvasId), "source.canvas.tsx"), "utf8");
  }

  async readBundle(canvasId) {
    return await readFile(join(this.dir(canvasId), "bundle.js"), "utf8");
  }

  async list({ agentId } = {}) {
    let names = [];
    try { names = await readdir(this.root); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const metas = [];
    for (const name of names) {
      if (!isCanvasId(name)) continue;
      const meta = await this.readMeta(name);
      if (!meta) continue;
      if (agentId !== undefined && meta.agentId !== agentId) continue;
      metas.push(meta);
    }
    return metas.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /**
   * Create (no canvasId) or overwrite (canvasId) a canvas. Compiles first; a source that
   * does not compile is never stored over a working canvas. Returns
   * `{ ok: true, meta, created }` or `{ ok: false, reason, detail, diagnostics }`.
   */
  async write(args) {
    return await serialized(this.root, () => this.#write(args));
  }

  async #write({ agentId, canvasId, title, source }) {
    if (typeof source !== "string" || source.trim().length === 0) {
      return { ok: false, reason: "refused", detail: "Invalid arguments: `contents` must be the full canvas source." };
    }
    if (Buffer.byteLength(source, "utf8") > CANVAS_SOURCE_MAX_BYTES) {
      return { ok: false, reason: "too_large", detail: `The canvas source exceeds ${CANVAS_SOURCE_MAX_BYTES} bytes.` };
    }
    let existing = null;
    if (canvasId !== undefined) {
      existing = await this.readMeta(canvasId);
      if (!existing || (agentId !== undefined && existing.agentId !== agentId)) {
        return { ok: false, reason: "not_found", detail: `No canvas with id ${canvasId} exists for this bot.` };
      }
    }
    const compiled = await this.compile(source);
    if (!compiled.ok) return { ok: false, reason: "compile_failed", detail: compiled.detail, diagnostics: compiled.diagnostics };
    const now = Date.now();
    const meta = existing
      ? { ...existing, title: cleanTitle(title) ?? existing.title, version: (existing.version ?? 1) + 1, updatedAtMs: now }
      : {
          id: randomUUID(),
          agentId: agentId ?? null,
          title: cleanTitle(title) ?? "未命名画布",
          token: randomBytes(32).toString("base64url"),
          version: 1,
          createdAtMs: now,
          updatedAtMs: now,
        };
    const dir = this.dir(meta.id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writePrivate(join(dir, "source.canvas.tsx"), source);
    await writePrivate(join(dir, "bundle.js"), compiled.code);
    await writePrivate(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    if (!existing) {
      const tokens = await this.readTokens();
      tokens[meta.token] = meta.id;
      await writePrivate(join(this.root, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
    }
    return { ok: true, meta, created: !existing };
  }

  async remove(canvasId) {
    return await serialized(this.root, () => this.#remove(canvasId));
  }

  async #remove(canvasId) {
    const meta = await this.readMeta(canvasId);
    if (!meta) return false;
    const tokens = await this.readTokens();
    delete tokens[meta.token];
    await writePrivate(join(this.root, "tokens.json"), JSON.stringify(tokens, null, 2) + "\n");
    await rm(this.dir(canvasId), { recursive: true, force: true });
    return true;
  }
}

function httpOrigin(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * The address clients reach this Host at, as last seen on an authenticated device request.
 * The bot runtime has no request of its own, so it reads this to build absolute canvas links
 * when ROKBOT_PUBLIC_URL is not configured. Clients still re-point a canvas link at the Host
 * they are connected to when opening it.
 */
export class CanvasLinkOrigins {
  constructor(dataDir) {
    this.file = join(canvasRoot(dataDir), "link-origin.json");
    this.seen = { main: null, web: null };
    this.pending = Promise.resolve();
  }

  observe(origin, web = false) {
    const clean = httpOrigin(origin);
    const key = web ? "web" : "main";
    if (!clean || this.seen[key] === clean) return;
    this.seen[key] = clean;
    const snapshot = { ...this.seen, updatedAtMs: Date.now() };
    this.pending = this.pending
      .then(async () => {
        const saved = await readJson(this.file, {});
        await writePrivate(this.file, JSON.stringify({ ...saved, ...Object.fromEntries(Object.entries(snapshot).filter(([, v]) => v)) }, null, 2) + "\n");
      })
      .catch(() => {});
  }
}

/** Origin for links the bot hands out: configured public URL, last seen client origin, loopback. */
export async function resolveCanvasOrigin(dataDir, env = process.env) {
  const configured = httpOrigin(env.ROKBOT_PUBLIC_URL ?? env.GROKBOT_PUBLIC_URL);
  if (configured) return configured;
  const saved = await readJson(join(canvasRoot(dataDir), "link-origin.json"), {});
  const seen = httpOrigin(saved?.main) ?? httpOrigin(saved?.web);
  if (seen) return seen;
  const port = env.ROKBOT_PORT ?? env.GROKBOT_PORT ?? "8000";
  return `http://127.0.0.1:${/^\d{1,5}$/.test(port) ? port : "8000"}`;
}
