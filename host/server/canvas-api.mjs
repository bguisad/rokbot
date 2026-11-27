// Device API for canvases: what the official clients do through the cloud canvas RPCs
// (ListUserCanvases / GetCanvasMetadata / SetCanvasVisibility / DeleteCanvas, plus the
// library "Pages" list of a Bot), answered by this Host for its paired devices.
//
//   GET    /local/canvases?agentId=<id>          Canvases one Bot wrote, newest first.
//   GET    /local/canvases/<id>                  One canvas.
//   POST   /local/canvases/<id>/visibility       { visibility: "private" | "public" }
//   POST   /local/canvases/<id>/link             New public token; the old public link is 404.
//   DELETE /local/canvases/<id>                  Remove the canvas (and its public link).
//
// Every route needs a device credential (`device()` throws 401 otherwise). Responses carry
// `appUrl` on the caller's own origin and, only while public, `publicUrl` on the public origin.
import { canvasView, isCanvasId } from "./canvas-store.mjs";
import { check, jsonBody, sendJson } from "./security.mjs";

const ITEM_RE = /^\/local\/canvases\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/(visibility|link))?$/;
const AGENT_RE = /^[a-f0-9-]{1,128}$/i;

export const CANVAS_API_PATH_RE = /^\/local\/canvases(?:\/[0-9a-f-]{36}(?:\/(?:visibility|link))?)?$/;

/**
 * Returns true when the request was a canvas API request (handled). `device(request)` authenticates
 * (throws HttpError 401), `origin` is the caller's origin, `publicOrigin()` resolves where public
 * links point (ROKBOT_PUBLIC_URL, else the main listener the caller reached).
 */
export async function routeCanvasApi(request, response, path, url, { store, device, origin, publicOrigin, onChange = () => {} }) {
  if (path !== "/local/canvases" && !path.startsWith("/local/canvases/")) return false;
  device(request);
  const method = request.method;
  const view = async (meta) => {
    const viewed = canvasView(meta, origin);
    if (viewed.publicUrl) viewed.publicUrl = canvasView(meta, await publicOrigin()).publicUrl;
    return viewed;
  };
  if (path === "/local/canvases") {
    check(method === "GET", 405, "不支持的请求方法");
    const agentId = url.searchParams.get("agentId");
    check(typeof agentId === "string" && AGENT_RE.test(agentId), 400, "Bot ID 无效");
    const metas = await store.list({ agentId });
    const canvases = [];
    for (const meta of metas) canvases.push(await view(meta));
    return sendJson(response, 200, { canvases }), true;
  }
  const match = ITEM_RE.exec(path);
  check(match && isCanvasId(match[1]), 404, "画布不存在");
  const [, canvasId, action] = match;
  const current = await store.readMeta(canvasId);
  check(current, 404, "画布不存在");
  if (!action && method === "GET") return sendJson(response, 200, { canvas: await view(current) }), true;
  if (!action && method === "DELETE") {
    await store.remove(canvasId);
    onChange({ kind: "deleted", canvasId, agentId: current.agentId ?? null });
    return sendJson(response, 200, { ok: true, canvasId }), true;
  }
  check(method === "POST" && action, 405, "不支持的请求方法");
  if (action === "visibility") {
    const body = await jsonBody(request, 4 * 1024);
    check(["private", "public"].includes(body?.visibility), 400, "可见性无效");
    const next = await store.setVisibility(canvasId, body.visibility);
    check(next, 404, "画布不存在");
    onChange({ kind: "visibility", canvasId, agentId: next.agentId ?? null, visibility: body.visibility });
    return sendJson(response, 200, { canvas: await view(next) }), true;
  }
  await jsonBody(request, 4 * 1024, { allowEmpty: true });
  const next = await store.regenerateToken(canvasId);
  check(next, 404, "画布不存在");
  onChange({ kind: "link", canvasId, agentId: next.agentId ?? null });
  return sendJson(response, 200, { canvas: await view(next) }), true;
}
