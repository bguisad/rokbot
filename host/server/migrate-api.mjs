// HTTP surface of the Grok Bot migration.
//   /admin/api/migrate/...          admin page (cookie session, CSRF header, same origin)
//   /local/migrate/...              paired desktop, web and mobile clients (device credential)
//   /api/migrate/inbox/<token>      one-time upload URL posted to by a Grok Bot (token only)
import { Readable } from 'node:stream';
import { check, jsonBody, sendJson, HttpError } from './security.mjs';

const MULTIPART_LIMIT = 512 * 1024 * 1024;

/** Accepts a raw body (JSON or ZIP) or a multipart form with one file part. */
async function uploadStream(request) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!type.startsWith('multipart/form-data')) return request;
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(request.headers['content-type'] ?? '');
  check(boundary, 400, '缺少 multipart boundary');
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; check(size <= MULTIPART_LIMIT, 413, '表单上传最大 512 MiB，更大的文件请直接以请求体上传'); chunks.push(chunk); }
  const body = Buffer.concat(chunks), marker = Buffer.from(`--${boundary[1] ?? boundary[2].trim()}`);
  for (let at = body.indexOf(marker); at >= 0;) {
    const next = body.indexOf(marker, at + marker.length);
    if (next < 0) break;
    const part = body.subarray(at + marker.length, next), split = part.indexOf('\r\n\r\n');
    if (split > 0) {
      const headers = part.subarray(0, split).toString('utf8');
      if (/content-disposition:[^\r\n]*\b(?:filename=|name="(?:file|bundle|data)")/i.test(headers))
        return Readable.from([part.subarray(split + 4, part.length - 2)]);
    }
    at = next;
  }
  throw new HttpError(400, '表单中没有文件');
}
const label = url => {
  const value = url.searchParams.get('name') ?? '';
  return value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
};

async function packageRoutes(request, response, rest, migration, { url, source, baseUrl }) {
  const method = request.method;
  if (rest === '' && method === 'GET')
    return sendJson(response, 200, { packages: migration.listPackages(), tokens: migration.listTokens(), baseUrl });
  if (rest === '/packages' && method === 'GET') return sendJson(response, 200, migration.listPackages());
  if (rest === '/packages' && method === 'POST')
    return sendJson(response, 201, await migration.receive(await uploadStream(request), { source, label: label(url) || (source === 'device' ? '桌面端本机迁移' : '网页上传') }));
  if (rest === '/tokens' && method === 'GET') return sendJson(response, 200, migration.listTokens());
  if (rest === '/tokens' && method === 'POST') {
    const body = await jsonBody(request, 4096, { allowEmpty: true });
    const token = await migration.createToken({ label: body.label });
    return sendJson(response, 201, { ...token, ...migration.prompt({ tokenId: token.id, baseUrl, scope: body.scope }) });
  }
  if (rest === '/prompt' && method === 'GET')
    return sendJson(response, 200, migration.prompt({ tokenId: url.searchParams.get('tokenId') || undefined, baseUrl, scope: url.searchParams.get('scope') || undefined }));
  const token = /^\/tokens\/([A-Za-z0-9_-]{8,40})$/.exec(rest);
  if (token && method === 'DELETE') return sendJson(response, 200, await migration.revokeToken(token[1]));
  const item = /^\/packages\/([A-Za-z0-9_-]{16,40})(\/import)?$/.exec(rest);
  if (item && !item[2] && method === 'GET') return sendJson(response, 200, await migration.preview(item[1]));
  if (item && !item[2] && method === 'DELETE') return sendJson(response, 200, await migration.discard(item[1]));
  if (item && item[2] && method === 'POST') return sendJson(response, 200, await migration.import(item[1], await jsonBody(request, 4 * 1024 * 1024, { allowEmpty: true })));
  throw new HttpError(404, '接口不存在');
}

/** Called after the admin authentication and mutation checks. */
export async function migrateAdmin(request, response, path, migration, { url, baseUrl }) {
  if (path !== '/admin/api/migrate' && !path.startsWith('/admin/api/migrate/')) return false;
  await packageRoutes(request, response, path.slice('/admin/api/migrate'.length), migration, { url, source: 'admin', baseUrl });
  return true;
}

/** Called after device authentication. */
export async function migrateDevice(request, response, path, migration, { url, baseUrl }) {
  if (path !== '/local/migrate' && !path.startsWith('/local/migrate/')) return false;
  await packageRoutes(request, response, path.slice('/local/migrate'.length), migration, { url, source: 'device', baseUrl });
  return true;
}

/** The inbox needs no session: the unguessable, expiring and revocable token is the credential. */
export async function migrateInbox(request, response, path, migration, { limiter }) {
  const match = /^\/api\/migrate\/inbox\/([^/]+)$/.exec(path);
  if (!match) return false;
  limiter?.check(`migrate-inbox:${request.socket.remoteAddress}`, 30);
  const token = migration.verifyToken(decodeURIComponent(match[1]));
  if (request.method === 'GET') { sendJson(response, 200, { ok: true, expiresAt: token.expiresAt, schema: 'rokbot.migrate', version: 1 }); return true; }
  check(request.method === 'POST' || request.method === 'PUT', 405, '请使用 POST 上传');
  const result = await migration.receive(await uploadStream(request), { source: 'inbox', label: `${token.label} · Bot 上传`, tokenId: token.id });
  sendJson(response, 201, { ok: true, packageId: result.id, counts: result.counts, warnings: result.warnings,
    message: '已收到迁移文件，等待用户在 RokBot 中确认导入。' });
  return true;
}
