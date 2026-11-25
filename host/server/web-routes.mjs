// The web client's own listener (ROKBOT_WEB_PORT, 8001 by default) and origin.
//
// The uploaded/built-in bundle runs the official interface and whatever it loads. On the admin
// page's origin that code could call /admin/api with the administrator's cookie, so the web client
// gets an origin of its own: this listener serves the sign-in page, the bundle, /web/api and the
// part of the device API the web client uses, and never mounts /admin, /federation, /internal or
// /local/updates. The main listener's device API accepts bearer tokens only and redirects old
// /web links here.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, cookie, HttpError, jsonBody, sendJson } from './security.mjs';
import { webManifest } from './web-client.mjs';

const WEB_DEVICE_PATHS = /^(\/(local\/(device(\/push\/test)?|profile|status|usage|model(\/(?:catalog|test))?|files(\/content)?|computers|connectors(\/.*)?|notification-settings(\/events)?|mobile-rpc\/.*|audio\/transcriptions|voice\/(status|session))|vnc\/(desktop|fork)\/.*|connect\/(status|attachment)|notifications(\/events)?|api\/[a-zA-Z][a-zA-Z0-9]*|events))$/;
const VNC_SCRIPT = /^\/vnc\/(desktop|fork)\/__rokbot-(vnc-bridge|vnc-preload)\.js$/;

/** The admin-page assets the sign-in page loads, followed through their static imports. */
export function loginAssets(publicDir) {
  const names = new Set(), pending = [];
  const add = name => { if (!names.has(name)) { names.add(name); pending.push(name); } };
  for (const [, name] of readFileSync(join(publicDir, 'web-login.html'), 'utf8').matchAll(/(?:href|src)="\/([\w.-]+\.(?:css|js|svg|png))"/g)) add(name);
  while (pending.length) {
    const name = pending.pop();
    if (name.endsWith('.js'))
      for (const [, next] of readFileSync(join(publicDir, name), 'utf8').matchAll(/\b(?:from|import)\s*'\.\/([\w.-]+\.js)'/g)) add(next);
  }
  return names;
}

function redirect(response, location) {
  response.writeHead(302, { location });
  return response.end();
}

/** Redirects old /web links on the main listener to the web client's own address. */
export function webMoved(request, response, path, url, webOrigin) {
  check(['GET', 'HEAD'].includes(request.method) && ['/web', '/web/', '/web/login'].includes(path), 404, '网页版使用单独的端口');
  return redirect(response, `${webOrigin}${path}${url.search}`);
}

export function createWebRoutes({
  webClient,
  auth,
  federation,
  tickets,
  limiter,
  revokeDevice,
  cleanupPairedResult,
  sendPage,
  publicDir,
}) {
  const assets = loginAssets(publicDir);

  async function respond(request, response, path, url, origin, mainOrigin) {
    const method = request.method, read = method === 'GET' || method === 'HEAD';
    if (read && path === '/rokbot-icon.png') return sendPage(response, 'rokbot-icon.png', method, 'image/png');
    if (read && path === '/web/login') return sendPage(response, 'web-login.html', method);
    if (read && assets.has(path.slice(1)))
      return sendPage(response, path.slice(1), method, path.endsWith('.png') ? 'image/png' : undefined);
    if (read && path === '/web/locales-en.js') return sendPage(response, 'locales-en.js', method);
    if (read && path === '/') return redirect(response, '/web/');
    if (read && (path === '/admin' || path === '/admin/'))
      return redirect(response, `${mainOrigin}/admin`);

    const fromPage = () => check(request.headers['x-rokbot-web'] === '1' &&
      (!request.headers.origin || request.headers.origin === origin), 403, '请从网页版登录页操作');

    if (method === 'GET' && path === '/web/api/session') {
      const signedIn = webClient.browserDevice(request), status = webClient.status();
      return sendJson(response, 200, {
        available: status.available,
        rendererVersion: status.rendererVersion,
        paired: Boolean(signedIn),
        deviceName: signedIn?.device.name ?? null,
        secure: origin.startsWith('https:'),
      });
    }
    if (method === 'POST' && path === '/web/api/pair') {
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      fromPage();
      check(webClient.available, 404, '网页版未启用');
      limiter.check(`pair:${request.socket.remoteAddress}`, 6);
      limiter.check('pair:global', 60);
      const { pairingKey, deviceName, clientDeviceId } = await jsonBody(request);
      const previous = webClient.browserDevice(request);
      const result = await auth.pair({ pairingKey, deviceName, clientDeviceId }, { web: true });
      // Signing in again replaces this browser's earlier device instead of leaving it behind.
      if (previous && previous.device.id !== result.deviceId) await revokeDevice(previous.device.id);
      if (cleanupPairedResult) await cleanupPairedResult(result);
      response.setHeader('set-cookie', webClient.sessionCookie(result.token, origin));
      return sendJson(response, 201, { ok: true, deviceId: result.deviceId });
    }
    if (method === 'POST' && path === '/web/api/ticket') {
      // "Open in this browser" on the admin page: its one-time ticket instead of a pairing code.
      check(federation.role() === 'primary', 403, 'Connect to the primary Host');
      fromPage();
      check(webClient.available, 404, '网页版未启用');
      limiter.check(`web-ticket:${request.socket.remoteAddress}`, 10);
      const { deviceName, clientDeviceId } = webClient.redeemTicket((await jsonBody(request)).ticket);
      // A browser that is already signed in keeps its device instead of gaining another.
      if (webClient.browserDevice(request)) return sendJson(response, 200, { ok: true });
      const result = await auth.addWebDevice(deviceName, { clientDeviceId });
      if (cleanupPairedResult) await cleanupPairedResult(result);
      response.setHeader('set-cookie', webClient.sessionCookie(result.token, origin));
      return sendJson(response, 201, { ok: true, deviceId: result.deviceId });
    }
    if (method === 'POST' && path === '/web/api/logout') {
      fromPage();
      const signedIn = webClient.browserDevice(request);
      if (signedIn) await revokeDevice(signedIn.device.id);
      response.setHeader('set-cookie', webClient.sessionCookie('', origin));
      return sendJson(response, 200, { ok: true });
    }
    if (method === 'GET' && path === '/web/manifest.webmanifest') {
      check(webClient.available, 404, '网页版未启用');
      response.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8' });
      return response.end(JSON.stringify(webManifest(webClient)));
    }
    if (read && (path === '/web' || path === '/web/')) {
      response.writeHead(302, {
        location: `${webClient.browserDevice(request) ? '/web/renderer/index.html' : '/web/login'}${url.search}`,
      });
      return response.end();
    }
    const file = /^\/web\/((?:renderer|client)\/.+)$/.exec(path);
    if (file && read) {
      let name = null;
      try { name = decodeURIComponent(file[1]); } catch {}
      check(name && webClient.has(name), 404, '文件不存在');
      const signedIn = webClient.browserDevice(request);
      if (!signedIn && name === 'renderer/index.html') {
        response.writeHead(302, { location: `/web/login${url.search}` });
        return response.end();
      }
      check(signedIn, 401, '请先登录网页版');
      void auth.touch(signedIn.device.id).catch(() => {});
      return webClient.serve(request, response, name);
    }
    if (read && path === '/local-client/icon.png') {
      // The desktop settings pages load the program icon from here.
      check(webClient.browserDevice(request) && webClient.has('client/icon.png'), 404, '页面不存在');
      return webClient.serve(request, response, 'client/icon.png');
    }
    const script = VNC_SCRIPT.exec(path);
    if (script && read) {
      const value = tickets.validate(cookie(request, `rokbot_vnc_${script[1]}`), script[1]);
      check(value && webClient.available && auth.device(value.deviceId)?.platform === 'web', 401, '桌面访问票据已失效，请重新打开电脑预览');
      const body = await webClient.vncScript(script[2], origin);
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cross-origin-resource-policy': 'same-origin',
      });
      return response.end(method === 'HEAD' ? undefined : body);
    }
    throw new HttpError(404, '页面不存在');
  }

  /** Answers a request to the web listener; false for the device API, which index.mjs shares with the apps. */
  return async function webRoute(request, response, path, url, origin, mainOrigin) {
    if (WEB_DEVICE_PATHS.test(path) && !VNC_SCRIPT.test(path)) return false;
    await respond(request, response, path, url, origin, mainOrigin);
    return true;
  };
}
