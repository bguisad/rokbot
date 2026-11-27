// Local canvas tools: WriteCanvas, EditCanvas, ReadCanvas and ListCanvases with the official
// names and argument shapes, backed by the Host's own CanvasStore and offline compiler instead
// of the official cloud. Built with makeLocalHarnessTool, so each result reaches the model and the
// transcript as McpToolResult -> McpSuccess -> McpTextContent.
import { makeLocalHarnessTool } from './local-state-tools.mjs';
import { CanvasStore, canvasAppPath, canvasPublicPath, canvasVisibility, isCanvasId, resolveCanvasOrigin } from '../server/canvas-store.mjs';
import { compileCanvas } from '../server/canvas-compile.mjs';
import { CANVAS_SDK_GUIDE } from '../server/canvas-sdk/guide.mjs';

export const LOCAL_CANVAS_TOOL_NAMES = ['WriteCanvas', 'EditCanvas', 'ReadCanvas', 'ListCanvases'];
const LIST_MAX = 50;
const TOKEN_LINK_RE = /\/canvas\/([A-Za-z0-9_-]{43})(?:[/?#]|$)/;
const APP_LINK_RE = /\/canvas\/app\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;
const ID_IN_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const WRITE_DESCRIPTION = [
  'Create or update a canvas: a self-contained React `.canvas.tsx` page that this Host compiles, stores and serves at its own link.',
  'Make one for a report or dashboard, for something asked for as a canvas or by name as a report, memo or dashboard, or for work the user will iterate on; never for an answer that is merely long, and never beside the same content in the chat, where the reply is one or two lines and the link.',
  'Provide `title` to create a new canvas, or `canvas_id` to replace the whole source of an existing one (a follow-up about a canvas changes it rather than creating another; a change to part of a page is EditCanvas). `contents` is always the full source.',
  'On success returns the canvas link to share with the user as a markdown link; the link opens the canvas inside RokBot and keeps working across updates. A new canvas is private: only the user\'s signed-in RokBot apps can open it, and the user makes it public from the share panel when they want an outside link. On failure returns the compile errors with the offending lines and no link; fix only those lines and send it again.',
  CANVAS_SDK_GUIDE,
].join(' ');

const EDIT_DESCRIPTION = 'Change an existing canvas without rewriting it: replace exact strings in its source. Pass canvas_id and either one replacement (old_string, new_string, optional replace_all) or several in edits; they apply in order against the current source with one recompile for the whole call. Each old_string is copied verbatim from the current source and must occur exactly once unless replace_all is true. If any replacement does not match, or the result does not compile, nothing is written and the previous revision stays in place. The canvas link stays the same. Prefer EditCanvas over WriteCanvas for a canvas that already exists; use WriteCanvas for a new canvas or when the change is spread through the file.';

const READ_DESCRIPTION = "Read the source of a canvas on this Host. Pass `canvas_id`, or the canvas `url` (its /canvas/app/<id> link, or its public /canvas/<token> link). If both are provided they must name the same canvas.";

const LIST_DESCRIPTION = 'List the canvases this bot has written on this Host, newest first. Each entry carries canvas_id, title, url (the in-app link), visibility (private or public; only the user changes it) and when it was updated. Filter by title `query` or `updated_after`. Read one with ReadCanvas, or change one with EditCanvas, by its canvas_id.';

const replacementSchema = {
  type: 'object',
  properties: {
    old_string: { type: 'string', minLength: 1, description: 'Exact text to replace, copied verbatim from the current source.' },
    new_string: { type: 'string', description: 'The replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one.' },
  },
  required: ['old_string', 'new_string'],
  additionalProperties: false,
};

export const LOCAL_CANVAS_SCHEMAS = {
  WriteCanvas: {
    type: 'object',
    properties: {
      contents: { type: 'string', description: 'The full source of the canvas, one self-contained React `.canvas.tsx` module. Overwrites the whole canvas; send the complete file, not a patch.' },
      canvas_id: { type: 'string', description: "Omit to create a new canvas. Pass the id of an existing canvas to overwrite it in place." },
      title: { type: 'string', description: "Human-readable title. Provide it when creating a new canvas. Omit to keep an existing canvas's title." },
    },
    required: ['contents'],
    additionalProperties: false,
  },
  EditCanvas: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', minLength: 1, description: 'The id of the canvas to edit, as a ReadCanvas, WriteCanvas or EditCanvas result names it.' },
      old_string: replacementSchema.properties.old_string,
      new_string: replacementSchema.properties.new_string,
      replace_all: replacementSchema.properties.replace_all,
      edits: { type: 'array', minItems: 1, items: replacementSchema, description: 'Several replacements applied in order to the same canvas, with one recompile. All apply or none does.' },
      title: { type: 'string', description: 'Optional new title.' },
    },
    required: ['canvas_id'],
    additionalProperties: false,
  },
  ReadCanvas: {
    type: 'object',
    properties: {
      canvas_id: { type: 'string', description: 'The id of a canvas on this Host.' },
      url: { type: 'string', description: 'A canvas link this Host handed out (/canvas/app/<id>, or a public /canvas/<token>).' },
    },
    additionalProperties: false,
  },
  ListCanvases: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive substring to match against titles.' },
      updated_after: { type: 'string', description: 'Only canvases updated at or after this RFC 3339 timestamp.' },
      limit: { type: 'integer', minimum: 1, maximum: LIST_MAX, description: `Most canvases to return, 1-${LIST_MAX}. Default 20.` },
    },
    additionalProperties: false,
  },
};

function firstString(args, keys) {
  for (const key of keys) if (typeof args?.[key] === 'string') return args[key];
  return undefined;
}

function optional(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Render diagnostics with the offending lines, like the official tool does. */
function failureText(result, source) {
  const lines = [`Canvas was not saved: ${describeReason(result.reason)}.`];
  if (result.detail) lines.push(result.detail);
  const srcLines = typeof source === 'string' ? source.split('\n') : [];
  for (const diagnostic of result.diagnostics ?? []) {
    const line = diagnostic.range?.start?.line;
    if (line === undefined || !srcLines.length) continue;
    const from = Math.max(0, line - 2), to = Math.min(srcLines.length - 1, line + 2);
    const width = String(to + 1).length;
    lines.push(`${diagnostic.message}`);
    for (let i = from; i <= to; i += 1) lines.push(`  ${i === line ? '>' : ' '} ${String(i + 1).padStart(width)} | ${srcLines[i]}`);
  }
  lines.push('No url was produced; do not present a canvas link to the user.');
  return lines.join('\n');
}

function describeReason(reason) {
  switch (reason) {
    case 'compile_failed': return 'the canvas source did not compile';
    case 'too_large': return 'the canvas source is too large';
    case 'not_found': return "no canvas with that id exists for this bot";
    case 'refused': return 'the arguments were invalid';
    case 'no_match': return 'a replacement did not match the current source';
    default: return 'the canvas service was unavailable';
  }
}

/** Apply EditCanvas replacements; returns { ok, source } or { ok: false, detail }. */
export function applyCanvasEdits(source, edits) {
  let next = source;
  const failures = [];
  edits.forEach((edit, index) => {
    const oldString = edit?.old_string, newString = edit?.new_string;
    if (typeof oldString !== 'string' || oldString.length === 0 || typeof newString !== 'string') {
      failures.push(`Edit ${index + 1}: old_string and new_string are required.`);
      return;
    }
    const count = next.split(oldString).length - 1;
    if (count === 0) {
      failures.push(`Edit ${index + 1}: old_string was not found in the current source.`);
      return;
    }
    if (count > 1 && !edit.replace_all) {
      failures.push(`Edit ${index + 1}: old_string occurs ${count} times; make it unique or pass replace_all: true.`);
      return;
    }
    next = edit.replace_all ? next.split(oldString).join(newString) : next.replace(oldString, () => newString);
  });
  return failures.length ? { ok: false, detail: failures.join('\n') } : { ok: true, source: next };
}

/**
 * The canvas tools for one bot. `dataDir` is the Host data directory shared with the
 * selfhost service, which serves `/canvas/<token>`.
 */
export function createLocalCanvasTools({ library, dataDir, agentId, compile = compileCanvas, env = process.env }) {
  const store = new CanvasStore(dataDir, { compile });
  // The link handed to the model is the in-app link: RokBot clients open it in their canvas view
  // with the device's own credential. The public link exists only while the user shares it.
  const linkOf = async (meta) => `${await resolveCanvasOrigin(dataDir, env)}${canvasAppPath(meta)}`;
  const publicLinkOf = async (meta) => `${await resolveCanvasOrigin(dataDir, env)}${canvasPublicPath(meta)}`;
  const ownMeta = async (canvasId) => {
    const meta = await store.readMeta(canvasId);
    return meta && meta.agentId === (agentId ?? null) ? meta : null;
  };
  const savedText = async (meta, created) => {
    const url = await linkOf(meta);
    return [
      `Canvas ${created ? 'saved' : 'updated'}: "${meta.title}".`,
      `canvas_id: ${meta.id}`,
      `version: ${meta.version}`,
      `URL: ${url}`,
      `visibility: ${canvasVisibility(meta)}`,
      `Reference it to the user as a markdown link: [${meta.title}](${url}).`,
      canvasVisibility(meta) === 'public'
        ? 'The user has made this canvas public; the link still opens it inside RokBot.'
        : 'The canvas is private: it opens inside the user\'s RokBot apps. Do not describe it as publicly shareable; the user can make it public from the canvas share panel.',
    ].join('\n');
  };

  const writeTool = makeLocalHarnessTool(library, {
    name: 'WriteCanvas',
    description: WRITE_DESCRIPTION,
    schema: LOCAL_CANVAS_SCHEMAS.WriteCanvas,
    run: async (args) => {
      // The official tool also accepts these aliases for `contents`.
      const contents = firstString(args, ['contents', 'content', 'source', 'code']);
      if (contents === undefined) return failureText({ reason: 'refused', detail: 'Invalid arguments: `contents` must be the full canvas source.' });
      const canvasId = optional(args.canvas_id);
      if (canvasId !== undefined && !isCanvasId(canvasId)) return failureText({ reason: 'not_found' });
      const result = await store.write({ agentId: agentId ?? null, canvasId: canvasId?.toLowerCase(), title: args.title, source: contents });
      if (!result.ok) return failureText(result, contents);
      return await savedText(result.meta, result.created);
    },
  });

  const editTool = makeLocalHarnessTool(library, {
    name: 'EditCanvas',
    description: EDIT_DESCRIPTION,
    schema: LOCAL_CANVAS_SCHEMAS.EditCanvas,
    run: async (args) => {
      const canvasId = optional(args.canvas_id)?.toLowerCase();
      const meta = canvasId && isCanvasId(canvasId) ? await ownMeta(canvasId) : null;
      if (!meta) return failureText({ reason: 'not_found' });
      const edits = Array.isArray(args.edits) && args.edits.length > 0
        ? args.edits
        : (typeof args.old_string === 'string' ? [{ old_string: args.old_string, new_string: args.new_string, replace_all: args.replace_all }] : []);
      if (edits.length === 0) return failureText({ reason: 'refused', detail: 'Pass either old_string and new_string, or edits.' });
      const current = await store.readSource(meta.id);
      const applied = applyCanvasEdits(current, edits);
      if (!applied.ok) return failureText({ reason: 'no_match', detail: applied.detail });
      const result = await store.write({ agentId: agentId ?? null, canvasId: meta.id, title: args.title, source: applied.source });
      if (!result.ok) return failureText(result, applied.source);
      return await savedText(result.meta, false);
    },
  });

  const readTool = makeLocalHarnessTool(library, {
    name: 'ReadCanvas',
    description: READ_DESCRIPTION,
    schema: LOCAL_CANVAS_SCHEMAS.ReadCanvas,
    run: async (args) => {
      const id = optional(args.canvas_id)?.toLowerCase();
      const url = optional(args.url);
      let meta = null;
      if (url !== undefined) {
        const appId = APP_LINK_RE.exec(url)?.[1]?.toLowerCase();
        const token = appId ? undefined : TOKEN_LINK_RE.exec(url)?.[1];
        const tokenMeta = token ? await store.byAnyToken(token) : null;
        const byLink = appId ? await ownMeta(appId) : (tokenMeta && tokenMeta.agentId === (agentId ?? null) ? tokenMeta : null);
        const fromId = byLink ?? (ID_IN_TEXT_RE.test(url) ? await ownMeta(ID_IN_TEXT_RE.exec(url)[0].toLowerCase()) : null);
        if (fromId && id !== undefined && fromId.id !== id) {
          return 'Could not read canvas: canvas_id and url refer to different canvases; they must resolve to the same canvas.';
        }
        meta = fromId;
      }
      if (!meta && id !== undefined) meta = isCanvasId(id) ? await ownMeta(id) : null;
      if (!meta) {
        return id === undefined && url === undefined
          ? 'Could not read canvas: Provide a canvas_id or a canvas url.'
          : 'Could not read canvas: no canvas was found for that reference.';
      }
      const source = await store.readSource(meta.id);
      return [`Canvas "${meta.title}" (${await linkOf(meta)}):`, `canvas_id: ${meta.id}`, `version: ${meta.version}`, '', source].join('\n');
    },
  });

  const listTool = makeLocalHarnessTool(library, {
    name: 'ListCanvases',
    description: LIST_DESCRIPTION,
    schema: LOCAL_CANVAS_SCHEMAS.ListCanvases,
    run: async (args) => {
      const query = optional(args.query)?.toLowerCase();
      const after = optional(args.updated_after);
      const afterMs = after === undefined ? undefined : Date.parse(after);
      const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), LIST_MAX) : 20;
      const all = await store.list({ agentId: agentId ?? null });
      const picked = all
        .filter((meta) => query === undefined || String(meta.title).toLowerCase().includes(query))
        .filter((meta) => afterMs === undefined || Number.isNaN(afterMs) || meta.updatedAtMs >= afterMs)
        .slice(0, limit);
      if (picked.length === 0) return 'No canvases match.';
      const lines = [];
      for (const meta of picked) {
        const visibility = canvasVisibility(meta);
        lines.push(`- ${meta.title}\n  canvas_id: ${meta.id}\n  url: ${await linkOf(meta)}\n  visibility: ${visibility}${visibility === 'public' ? `\n  public_url: ${await publicLinkOf(meta)}` : ''}\n  updated: ${new Date(meta.updatedAtMs).toISOString()}`);
      }
      return lines.join('\n');
    },
  });

  return { store, tools: [writeTool, editTool, readTool, listTool] };
}
