import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireDesktopSource, resolveDesktopDownloadUrl } from '../patchers/desktop/download-original.mjs';

const body = Buffer.alloc(32 * 1024, 97);
async function fixture(t) {
  const cacheDirectory = await mkdtemp(path.join(tmpdir(), 'desktop-download-'));
  let requests = 0, mode = 'valid';
  const server = createServer((_req, res) => {
    requests++;
    if (mode === 'unavailable') { res.writeHead(503).end(); return; }
    res.end(mode === 'invalid' ? Buffer.alloc(body.length, 98) : body);
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(cacheDirectory, { recursive: true, force: true });
  });
  const supported = { version: '1.2.3', archive: {
    url: `http://127.0.0.1:${server.address().port}/original.dmg`, bytes: body.length,
    sha256: createHash('sha256').update(body).digest('hex'),
  } };
  return { options: { cacheDirectory, supported }, requests: () => requests, mode: value => { mode = value; } };
}

test('downloads a verified original, reuses its cache and replaces corrupted cached bytes', async t => {
  const f = await fixture(t);
  const file = await acquireDesktopSource(f.options);
  assert.deepEqual(await readFile(file), body);
  assert.equal(f.requests(), 1);
  assert.equal(await acquireDesktopSource(f.options), file);
  assert.equal(f.requests(), 1, 'valid cached data makes no HTTP request');
  await writeFile(file, Buffer.alloc(body.length, 98));
  assert.equal(await acquireDesktopSource(f.options), file);
  assert.deepEqual(await readFile(file), body);
  assert.equal(f.requests(), 2, 'same-sized corrupted data is downloaded again');
  assert.deepEqual(await readdir(f.options.cacheDirectory), ['original.dmg']);
});

test('failed HTTP and fingerprint checks leave no cached input or partial download', async t => {
  const f = await fixture(t);
  f.mode('unavailable'); await assert.rejects(acquireDesktopSource(f.options), error =>
    /HTTP 503/.test(error.message) && /自行准备/.test(error.message) && /--source/.test(error.message) && error.message.includes(f.options.supported.archive.url));
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
  f.mode('invalid'); await assert.rejects(acquireDesktopSource(f.options), error =>
    /校验失败/.test(error.message) && /--source/.test(error.message));
  assert.deepEqual(await readdir(f.options.cacheDirectory), []);
  f.mode('valid'); await acquireDesktopSource(f.options);
  assert.equal(f.requests(), 3);
});

test('an explicit original app is passed to bundle verification without downloading', async () => {
  assert.equal(await acquireDesktopSource({ source: './original.app', fetchImpl: () => assert.fail('network') }), path.resolve('original.app'));
});

test('an explicit DMG must match its entire archive pin before it is mounted', async t => {
  const f = await fixture(t), source = path.join(f.options.cacheDirectory, 'input.DMG');
  const options = { ...f.options, source, fetchImpl: () => assert.fail('network') };
  await writeFile(source, body);
  assert.equal(await acquireDesktopSource(options), source);
  const damaged = Buffer.from(body); damaged[damaged.length - 1] ^= 1;
  await writeFile(source, damaged);
  await assert.rejects(acquireDesktopSource(options), /DMG/);
  assert.deepEqual(await readFile(source), damaged); assert.equal(f.requests(), 0);
});

test('ROKBOT_DESKTOP_DOWNLOAD_BASE rewrites download URLs, enforces bytes/sha256, and fails closed on invalid bases', async t => {
  const macSupported = JSON.parse(await readFile(new URL('../patchers/desktop/supported.json', import.meta.url), 'utf8'));
  assert.equal(
    resolveDesktopDownloadUrl(macSupported.archive.url, 'https://mirror.example/assets/'),
    `https://mirror.example/assets/darwin-arm64/${macSupported.version}/Grok_Bot_${macSupported.version}.dmg`,
  );
  assert.equal(
    resolveDesktopDownloadUrl('https://downloads.cursor.com/grokbot/stable/darwin-arm64/1.2.3/Grok_Bot_1.2.3.dmg', 'https://mirror.example/assets/'),
    'https://mirror.example/assets/darwin-arm64/1.2.3/Grok_Bot_1.2.3.dmg',
  );
  assert.equal(
    resolveDesktopDownloadUrl('https://other.example/custom/Grok_Bot_1.2.3.dmg', 'http://127.0.0.1:8080/mirror///'),
    'http://127.0.0.1:8080/mirror/Grok_Bot_1.2.3.dmg',
  );

  const requested = [];
  const f = await fixture(t);
  const mirrorPort = new URL(f.options.supported.archive.url).port;
  const cursorSupported = {
    version: '1.2.3',
    archive: {
      url: 'https://downloads.cursor.com/grokbot/stable/darwin-arm64/1.2.3/Grok_Bot_1.2.3.dmg',
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    },
  };
  const fetched = await acquireDesktopSource({
    cacheDirectory: f.options.cacheDirectory,
    supported: cursorSupported,
    downloadBase: `http://127.0.0.1:${mirrorPort}/mirror/`,
    fetchImpl: async (url, init) => {
      requested.push({ url, userAgent: init.headers['user-agent'] });
      return new Response(body, { status: 200 });
    },
  });
  assert.equal(path.basename(fetched), 'Grok_Bot_1.2.3.dmg');
  assert.deepEqual(await readFile(fetched), body);
  assert.deepEqual(requested, [{
    url: `http://127.0.0.1:${mirrorPort}/mirror/darwin-arm64/1.2.3/Grok_Bot_1.2.3.dmg`,
    userAgent: 'Mozilla/5.0 (compatible; RokBot-Patcher)',
  }]);

  // Corrupted mirror payload must still fail SHA-256 verification.
  await rm(fetched);
  await assert.rejects(
    acquireDesktopSource({
      cacheDirectory: f.options.cacheDirectory,
      supported: cursorSupported,
      downloadBase: `http://127.0.0.1:${mirrorPort}/mirror`,
      fetchImpl: async () => new Response(Buffer.alloc(body.length, 99), { status: 200 }),
    }),
    /校验失败/,
  );

  for (const badBase of [
    'not-a-url',
    'ftp://mirror.example/files',
    'file:///tmp/mirror',
    'https://user:pass@mirror.example/files',
    'https://mirror.example/files?token=1',
    'https://mirror.example/files#frag',
  ]) {
    await assert.rejects(
      acquireDesktopSource({
        cacheDirectory: f.options.cacheDirectory,
        supported: cursorSupported,
        downloadBase: badBase,
        fetchImpl: () => assert.fail(`network should not be called for ${badBase}`),
      }),
      /ROKBOT_DESKTOP_DOWNLOAD_BASE/,
    );
  }
});
