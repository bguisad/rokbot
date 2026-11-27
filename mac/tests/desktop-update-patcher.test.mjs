import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import vm from 'node:vm';
import { gunzipSync } from 'node:zlib';
import {
  normalizeEcPublicKey as updaterNormalizeEcPublicKey,
  validUpdateUrl as updaterValidUpdateUrl,
} from '../clients/desktop/updater.mjs';
import { extractNotificationPolicy } from '../patchers/desktop/extract-policy.mjs';
import {
  HELPER_DIGEST,
  TEAM_OFFSETS,
  patchNativeHelperTeam,
} from '../patchers/desktop/native-helper.mjs';
import {
  NATIVE_HELPERS,
  chmodNativeHelpers,
} from '../patchers/desktop/patch.mjs';
import { applyReleaseRecipes } from '../patchers/desktop/release-recipes.mjs';
import {
  normalizeEcPublicKey,
  patchDesktopUpdateSettingsUi,
  resolveDesktopUpdateConfig,
  validUpdateUrl,
} from '../patchers/desktop/update-config.mjs';

const execFileAsync = promisify(execFile);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const macPatchDir = fileURLToPath(new URL('../patchers/desktop', import.meta.url));
const macPatchCli = fileURLToPath(new URL('../patchers/desktop/patch.mjs', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const cachedMac123 = fileURLToPath(new URL('../.cache/Grok_Bot_1.2.3.dmg', import.meta.url));

function p256Pair() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    pem: publicKey.export({ format: 'pem', type: 'spki' }),
    privatePem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    spkiBase64: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

test('desktop patcher update URL and ECDSA P-256 key validation match updater.mjs and support --update-public-key-file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-cfg-'));
  try {
    const { pem, privatePem, spkiBase64 } = p256Pair();
    const pemFile = path.join(dir, 'update-key.pem');
    const b64File = path.join(dir, 'update-key.b64');
    await writeFile(pemFile, pem, 'utf8');
    await writeFile(b64File, `  ${spkiBase64}\n`, 'utf8');

    assert.equal(await resolveDesktopUpdateConfig([]), null);

    const fromInline = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com/desktop///',
      '--update-public-key', spkiBase64,
    ]);
    assert.deepEqual(fromInline, {
      updateUrl: 'https://updates.example.com/desktop',
      updatePublicKey: spkiBase64,
    });

    const fromInlinePem = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com/desktop',
      '--update-public-key', pem,
    ]);
    assert.deepEqual(fromInlinePem, {
      updateUrl: 'https://updates.example.com/desktop',
      updatePublicKey: spkiBase64,
    });

    const fromPemFile = await resolveDesktopUpdateConfig([
      '--update-url', 'http://127.0.0.1:8443/',
      '--update-public-key-file', pemFile,
    ]);
    assert.deepEqual(fromPemFile, {
      updateUrl: 'http://127.0.0.1:8443',
      updatePublicKey: spkiBase64,
    });

    const fromB64File = await resolveDesktopUpdateConfig([
      '--update-url', 'https://updates.example.com',
      '--update-public-key-file', b64File,
    ]);
    assert.equal(fromB64File.updatePublicKey, spkiBase64);

    for (const candidate of [
      'https://updates.example.com/feed/',
      'http://127.0.0.1:9000/',
      'http://example.com/feed',
      'https://user:pass@updates.example.com/feed',
      'ftp://updates.example.com/feed',
      'not-a-url',
      '',
    ]) {
      assert.equal(validUpdateUrl(candidate), updaterValidUpdateUrl(candidate), candidate);
    }
    assert.equal(normalizeEcPublicKey(pem), updaterNormalizeEcPublicKey(pem));

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'pem', type: 'spki' });
    const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    for (const badArgs of [
      ['--update-url', 'https://updates.example.com'],
      ['--update-public-key', spkiBase64],
      ['--update-public-key-file', pemFile],
      ['--update-url', 'https://updates.example.com', '--update-public-key', spkiBase64, '--update-public-key-file', pemFile],
      ['--update-url', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com', '--update-public-key'],
      ['--update-url', 'https://updates.example.com', '--update-public-key', '   '],
      ['--update-url', 'https://updates.example.com', '--update-url', 'https://other.example', '--update-public-key', spkiBase64],
      ['--update-url', 'http://updates.example.com', '--update-public-key', spkiBase64],
      ['--update-url', 'https://user:pw@updates.example.com', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com/feed?token=1', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com/feed#frag', '--update-public-key', spkiBase64],
      ['--update-url', 'https://updates.example.com', '--update-public-key', 'not-base64!!!'],
      ['--update-url', 'https://updates.example.com', '--update-public-key', `${spkiBase64}===`],
      ['--update-url', 'https://updates.example.com', '--update-public-key', privatePem],
      ['--update-url', 'https://updates.example.com', '--update-public-key', `${privatePem}\n${pem}`],
      ['--update-url', 'https://updates.example.com', '--update-public-key', rsa],
      ['--update-url', 'https://updates.example.com', '--update-public-key', p384],
      ['--update-url', 'https://updates.example.com', '--update-public-key-file', path.join(dir, 'missing.pem')],
    ]) {
      await assert.rejects(resolveDesktopUpdateConfig(badArgs));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('patchDesktopUpdateSettingsUi restores GrokOriginalUpdateSettings only when delivery === "in-app" and fails closed on drift', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-ui-'));
  try {
    const assetsDir = path.join(dir, 'dist/renderer/assets');
    await mkdir(assetsDir, { recursive: true });
    const chunkPath = path.join(assetsDir, 'chunk-view-FIXTURE.js');
    const fixture = [
      'function GrokOriginalUpdateSettings(){ie.d=1731;return o.jsx(Se,{title:"Updates",children:fe().row({value:Me})});}',
      'function Me(t){return o.jsx(ae,{status:t});}',
      'function re(){re.d=1588;const t=M.c(1);let e;return t[0]===Symbol.for("react.memo_cache_sentinel")?(e=o.jsx(ue,{children:o.jsx(ie,{})}),t[0]=e):e=t[0],e}',
      'function ie(){return o.jsx(Se,{children:"0.71.2 Local"});}',
    ].join('\n');
    await writeFile(chunkPath, fixture, 'utf8');

    const result = await patchDesktopUpdateSettingsUi(dir);
    assert.equal(result.file, 'dist/renderer/assets/chunk-view-FIXTURE.js');
    const patched = await readFile(chunkPath, 'utf8');

    // Evaluate patched component behavior across loading, package-manager, and in-app delivery states.
    const renderTree = node => {
      if (node == null || typeof node !== 'object' || !('type' in node)) return node;
      if (typeof node.type === 'function') return renderTree(node.type(node.props ?? {}));
      if (Array.isArray(node.props?.children)) return { ...node, children: node.props.children.map(renderTree) };
      return { tag: node.type, children: renderTree(node.props?.children) };
    };
    let currentRow = { kind: 'loading' };
    const context = vm.createContext({
      Symbol,
      o: { jsx: (type, props) => ({ type, props }) },
      M: { c: () => [] },
      Se: ({ title, children }) => ({ tag: 'Se', title, children: renderTree(children) }),
      ue: ({ children }) => ({ tag: 'ue', children: renderTree(children) }),
      ae: ({ status }) => ({ tag: 'ae', delivery: status.delivery }),
      fe: () => ({
        row: opts => {
          if (currentRow.kind === 'loading') return renderTree(opts.loading);
          if (currentRow.kind === 'empty') return renderTree(opts.empty);
          if (currentRow.kind === 'unavailable') return renderTree(opts.unavailable);
          return renderTree(opts.value(currentRow.status, 'ready'));
        },
      }),
    });
    vm.runInContext(`${patched}\nthis.re = re;`, context);

    currentRow = { kind: 'loading' };
    assert.equal(renderTree(context.re()).children.children, '0.71.2 Local');

    currentRow = { kind: 'ready', status: { delivery: 'package-manager', state: { type: 'disabled' } } };
    assert.equal(renderTree(context.re()).children.children, '0.71.2 Local');

    currentRow = { kind: 'ready', status: { delivery: 'in-app', state: { type: 'idle' } } };
    const inAppTree = renderTree(context.re());
    assert.equal(inAppTree.children.title, 'Updates');
    assert.equal(inAppTree.children.children.delivery, 'in-app');

    // Re-applying fails closed.
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /已被修改/);

    // Missing anchor fails closed.
    await writeFile(chunkPath, 'function GrokOriginalUpdateSettings(){} function ie(){} fe();', 'utf8');
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /缺少预期锚点/);

    // Duplicate candidates fail closed.
    await writeFile(chunkPath, fixture, 'utf8');
    await writeFile(path.join(assetsDir, 'chunk-view-DUP.js'), fixture, 'utf8');
    await assert.rejects(patchDesktopUpdateSettingsUi(dir), /存在多个更新设置模块/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('macOS patch CLI documents update flags in --help and rejects malformed update arguments before build', async () => {
  const { stdout } = await execFileAsync(process.execPath, [macPatchCli, '--help']);
  assert.match(stdout, /--update-url/);
  assert.match(stdout, /--update-public-key/);
  assert.match(stdout, /--update-public-key-file/);

  const { pem, spkiBase64 } = p256Pair();
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'http://insecure.example/updates', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /HTTPS/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'https://updates.example/feed?x=1', '--update-public-key', spkiBase64]),
    err => err.code === 1 && /查询参数/.test(err.stderr),
  );
  await assert.rejects(
    execFileAsync(process.execPath, [macPatchCli, '--update-url', 'https://updates.example/']),
    err => err.code === 1 && /--update-public-key/.test(err.stderr),
  );
});

test('macOS patcher --verify-only verifies cached 1.2.3 DMG recipes and update UI patch', { skip: process.platform !== 'darwin' || !existsSync(cachedMac123) }, async () => {
  const { pem } = p256Pair();
  const { stdout } = await execFileAsync(process.execPath, [
    macPatchCli,
    '--source', cachedMac123,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
    '--verify-only',
  ]);
  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.verified, true);
  assert.equal(parsed.recipesVerified, true);
  assert.equal(parsed.version, '1.2.3');
  assert.equal(parsed.architecture, 'arm64');
  assert.equal(parsed.asarSha256, '84d8cddca0676154a8cae13ca1f4ce8cae1703fdfa1b7b0175c4395d95f702cf');
});

test('patchDesktopUpdateSettingsUi supports 1.2.3 chunk-view-BuQdbmNp.js, preserves 1.1.0, and fails closed on drift', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-ui-123-'));
  const dir110 = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-ui-110-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(dir110, { recursive: true, force: true });
  });

  const assets110 = path.join(dir110, 'dist/renderer/assets');
  await mkdir(assets110, { recursive: true });
  const chunk110 = path.join(assets110, 'chunk-view-D18ZK0A2.js');
  await writeFile(chunk110, [
    'function E(){E.d=3008;const t=d();return (0,S.jsx)(g,{children:t.row({value:D})});}',
    'function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
    'function GrokLocalVersion(){return (0,S.jsx)(g,{children:"1.1.0"});}',
  ].join('\n'), 'utf8');
  const patched110 = await patchDesktopUpdateSettingsUi(dir110);
  assert.equal(patched110.file, 'dist/renderer/assets/chunk-view-D18ZK0A2.js');
  assert.match(await readFile(chunk110, 'utf8'), /function GrokLocalUpdateSettings\(\)/);

  const dir110With123Literal = await mkdtemp(path.join(os.tmpdir(), 'rokbot-update-ui-110-literal-'));
  t.after(() => rm(dir110With123Literal, { recursive: true, force: true }));
  const assets110Literal = path.join(dir110With123Literal, 'dist/renderer/assets');
  await mkdir(assets110Literal, { recursive: true });
  const chunk110Literal = path.join(assets110Literal, 'chunk-view-D18ZK0A2.js');
  await writeFile(chunk110Literal, [
    '// notes mentioning \'1.2.3\' and "1.2.3"',
    'function E(){E.d=3008;const t=d();return (0,S.jsx)(g,{children:t.row({value:D})});}',
    'function O(){O.d=2763;let e=(0,y.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,S.jsx)(v,{children:(0,S.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
    'function GrokLocalVersion(){return (0,S.jsx)(g,{children:"1.2.3"});}',
  ].join('\n'), 'utf8');
  const patched110Literal = await patchDesktopUpdateSettingsUi(dir110With123Literal);
  assert.equal(patched110Literal.file, 'dist/renderer/assets/chunk-view-D18ZK0A2.js');
  const patched110LiteralSrc = await readFile(chunk110Literal, 'utf8');
  assert.match(patched110LiteralSrc, /function GrokLocalUpdateSettings\(\)/);
  assert.match(patched110LiteralSrc, /\(0,S\.jsx\)\(E,\{\}\)/);

  const assetsDir = path.join(dir, 'dist/renderer/assets');
  await mkdir(assetsDir, { recursive: true });
  const chunkPath = path.join(assetsDir, 'chunk-view-BuQdbmNp.js');
  const fixture = [
    'function T(){T.d=3033;let e=(0,v.c)(4),t=u(),n;return (0,x.jsx)(h,{title:"Updates",children:t.row({value:s=>({tag:"orig",delivery:s.delivery})})});}',
    'function D(){D.d=2788;let e=(0,v.c)(1),t;return e[0]===Symbol.for(`react.memo_cache_sentinel`)?(t=(0,x.jsx)(_,{children:(0,x.jsx)(GrokLocalVersion,{})}),e[0]=t):t=e[0],t}',
    'function GrokLocalVersion(){return (0,x.jsx)(h,{children:"1.2.3 Local"});}',
  ].join('\n');
  await writeFile(chunkPath, fixture, 'utf8');

  const result = await patchDesktopUpdateSettingsUi(dir);
  assert.equal(result.file, 'dist/renderer/assets/chunk-view-BuQdbmNp.js');
  const patched = await readFile(chunkPath, 'utf8');

  const renderTree = node => {
    if (node == null || typeof node !== 'object' || !('type' in node)) return node;
    if (typeof node.type === 'function') return renderTree(node.type(node.props ?? {}));
    if (Array.isArray(node.props?.children)) return { ...node, children: node.props.children.map(renderTree) };
    return { tag: node.type, children: renderTree(node.props?.children) };
  };
  let currentRow = { kind: 'loading' };
  const context = vm.createContext({
    Symbol,
    x: { jsx: (type, props) => ({ type, props }) },
    v: { c: () => [] },
    h: ({ title, children }) => ({ tag: 'h', title, children: renderTree(children) }),
    _: ({ children }) => ({ tag: '_', children: renderTree(children) }),
    u: () => ({
      row: opts => {
        if (currentRow.kind === 'loading') return renderTree(opts.loading);
        if (currentRow.kind === 'empty') return renderTree(opts.empty);
        if (currentRow.kind === 'unavailable') return renderTree(opts.unavailable);
        return renderTree(opts.value(currentRow.status, 'ready'));
      },
    }),
  });
  vm.runInContext(`${patched}\nthis.D = D;`, context);

  for (const kind of ['loading', 'empty', 'unavailable']) {
    currentRow = { kind };
    assert.equal(renderTree(context.D()).children.children, '1.2.3 Local');
  }
  currentRow = { kind: 'ready', status: { delivery: 'package-manager', state: { type: 'disabled' } } };
  assert.equal(renderTree(context.D()).children.children, '1.2.3 Local');

  currentRow = { kind: 'ready', status: { delivery: 'in-app', state: { type: 'idle' } } };
  const inAppTree = renderTree(context.D());
  assert.equal(inAppTree.children.title, 'Updates');
  assert.equal(inAppTree.children.children.tag, 'orig');
  assert.equal(inAppTree.children.children.delivery, 'in-app');

  await assert.rejects(patchDesktopUpdateSettingsUi(dir), /已被修改/);

  await writeFile(chunkPath, 'function D(){D.d=2788;} function GrokLocalVersion(){} function T(){}', 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir), /缺少必需符号/);

  await writeFile(chunkPath, 'function GrokLocalVersion(){} u(); function T(){} (0,x.jsx)(h,{});', 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir), /缺少预期锚点/);

  await writeFile(chunkPath, fixture, 'utf8');
  await writeFile(path.join(assetsDir, 'chunk-view-DUP123.js'), fixture, 'utf8');
  await assert.rejects(patchDesktopUpdateSettingsUi(dir), /存在多个更新设置模块/);
});

test('macOS 1.3.0 supported.json & recipes/manifest.json match verified digests and fail closed on recipe tamper or destination collision', async t => {
  const supported = JSON.parse(await readFile(path.join(macPatchDir, 'supported.json'), 'utf8'));
  assert.equal(supported.version, '1.3.0');
  assert.equal(supported.bundleId, 'com.anysphere.sand');
  assert.equal(supported.architecture, 'arm64');
  assert.equal(supported.archive.url, 'https://downloads.cursor.com/grokbot/stable/darwin-arm64/1.3.0/Grok_Bot_1.3.0.dmg');
  assert.equal(supported.archive.bytes, 160753982);
  assert.equal(supported.archive.sha256, '85914908760b4503962ac9794622a16877657be77d5a2925ba99c2fc37d80a8c');
  assert.equal(supported.asarSha256, 'e4ee91c221544516d2d774151eb6a10a76f100ac91b1293013221620cbb51a71');
  assert.equal(supported.asarHeaderSha256, 'b7b40c35bd828e68787671a67bdb1e1e01e890112519e6196537efae2184314a');
  assert.equal(supported.frameworkSha256, '2e13e33b1a95b44be5f7ebf19bb944b31b12bb90a5074a5e4ea1af6ea35680b6');
  assert.equal(supported.preloadSha256, 'e85046e06d5dc2834bd478af3f0b2e54d983c0ca847bd6e1636491a6252647d9');
  assert.equal(supported.vncPreloadSha256, '4875cd8f20c2398f818b43674490bb23c223c9e06031159a57a0ce2f3e2a1487');

  const recipesDir = path.join(macPatchDir, 'recipes');
  const manifest = JSON.parse(await readFile(path.join(recipesDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.length, 20);
  const entry012 = manifest.files.find(entry => entry.recipe === '012.gbp.gz');
  assert.ok(entry012);
  assert.equal(entry012.path, 'dist/renderer/assets/chunk-view-vZqeG1gy.js');
  const recipe012 = JSON.parse(gunzipSync(await readFile(path.join(recipesDir, '012.gbp.gz'))).toString('utf8'));
  assert.equal(recipe012.targetSha256, '9101ae2562f95eefc473a8caaca15d6ac2c11d1e0a6253cffeae1469264d4e39');

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-recipe-guard-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const badRecipeDir = path.join(tmp, 'recipes');
  const unpacked = path.join(tmp, 'unpacked');
  await mkdir(badRecipeDir, { recursive: true });
  await mkdir(path.join(unpacked, 'dist'), { recursive: true });
  await writeFile(path.join(unpacked, 'dist/in.js'), 'hello');
  await writeFile(path.join(badRecipeDir, '000.gbp.gz'), 'tampered');
  await writeFile(path.join(badRecipeDir, 'manifest.json'), JSON.stringify({
    schema: 'rokbot-desktop-recipes/v1',
    files: [{ path: 'dist/in.js', source: 'dist/in.js', newFile: false, recipe: '000.gbp.gz', sha256: '0'.repeat(64) }],
  }));
  await assert.rejects(applyReleaseRecipes(unpacked, badRecipeDir), /Patch recipe fingerprint mismatch/);

  await writeFile(path.join(unpacked, 'dist/out.js'), 'already-here');
  await writeFile(path.join(badRecipeDir, 'manifest.json'), JSON.stringify({
    schema: 'rokbot-desktop-recipes/v1',
    files: [{ path: 'dist/out.js', source: 'dist/in.js', newFile: true, recipe: '000.gbp.gz', sha256: sha(Buffer.from('tampered')) }],
  }));
  await assert.rejects(applyReleaseRecipes(unpacked, badRecipeDir), /Patch destination already exists/);
});

test('native-helper.mjs enforces 1.3.0 CUGrokBotService digest/offsets and patches Team ID cleanly', async t => {
  assert.equal(HELPER_DIGEST, '62d2486a2ac6fd75a563ddc6cee9b1593a57ced8b05e83c4ca77d646c43c6fcb');
  assert.deepEqual(TEAM_OFFSETS, [0x257f68, 0x6c1b18]);

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-native-helper-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const binPath = path.join(tmp, 'CUGrokBotService');
  const buf = Buffer.alloc(0x6c1b18 + 32, 0);
  for (const offset of TEAM_OFFSETS) {
    buf.write('DCNK4UB866', offset, 'ascii');
    buf[offset + 15] = 0xea;
  }
  await writeFile(binPath, buf);

  await assert.rejects(patchNativeHelperTeam(binPath, 'invalid'), /Team ID/);
  await assert.rejects(patchNativeHelperTeam(binPath, 1234567890), /Team ID/);
  await assert.rejects(patchNativeHelperTeam(path.join(tmp, 'nonexistent'), 1234567890), /Team ID/);
  await assert.rejects(patchNativeHelperTeam(binPath, 'A1B2C3D4E5'), /Unsupported computer helper binary/);

  const expectedDigest = sha(buf);
  const res = await patchNativeHelperTeam(binPath, 'A1B2C3D4E5', { expectedDigest });
  assert.deepEqual(res, {
    trustedTeam: 'A1B2C3D4E5',
    architectures: ['x86_64', 'arm64'],
    sameUserRequired: true,
    signatureRequired: true,
  });
  const patchedBytes = await readFile(binPath);
  for (const offset of TEAM_OFFSETS) {
    assert.equal(patchedBytes.subarray(offset, offset + 10).toString('ascii'), 'A1B2C3D4E5');
  }

  // Missing 0xea fingerprint byte must fail closed.
  const badFp = Buffer.from(buf);
  badFp[TEAM_OFFSETS[1] + 15] = 0x00;
  await writeFile(binPath, badFp);
  await assert.rejects(
    patchNativeHelperTeam(binPath, 'A1B2C3D4E5', { expectedDigest: sha(badFp) }),
    /fingerprint mismatch/,
  );
});

test('notification-policy.json pins 1.3.0 SO export and extractNotificationPolicy fails closed on drift', async t => {
  const policy = JSON.parse(await readFile(path.join(macPatchDir, 'notification-policy.json'), 'utf8'));
  assert.deepEqual(policy, {
    source: 'dist/electron-main/main-app.cjs',
    sourceSha256: 'b8b142c5328386306725acbfe68b9c851917068f3c1b02812f116cbefe4148ce',
    sha256: '31dfb1354cacd135e4092a80c96e4a903373db6b99cc4b932dbeff2f249620d4',
    byteOffset: 3191546,
    byteLength: 4485,
    exportName: 'SO',
  });

  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-policy-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const policyDir = path.join(tmp, 'policy');
  const unpacked = path.join(tmp, 'unpacked');
  await mkdir(policyDir, { recursive: true });
  await mkdir(path.join(unpacked, 'dist/electron-main'), { recursive: true });

  const slice = Buffer.from('var XDn=5e3;var kP=class{};'.padEnd(4522, ' '));
  const sourceBuf = Buffer.concat([Buffer.alloc(2967236, 0x20), slice, Buffer.from('-suffix')]);
  await writeFile(path.join(unpacked, 'dist/electron-main/main-app.cjs'), sourceBuf);
  const validPolicy = {
    source: 'dist/electron-main/main-app.cjs',
    sourceSha256: sha(sourceBuf),
    sha256: sha(slice),
    byteOffset: 2967236,
    byteLength: 4522,
    exportName: 'kP',
  };
  await writeFile(path.join(policyDir, 'notification-policy.json'), JSON.stringify(validPolicy));
  const extracted = (await extractNotificationPolicy(unpacked, policyDir)).toString('utf8');
  assert.match(extracted, /var XDn=5e3;var kP=class\{\};/);
  assert.match(extracted, /export \{ kP as NotificationDecider \};/);

  await writeFile(path.join(policyDir, 'notification-policy.json'), JSON.stringify({ ...validPolicy, sourceSha256: '0'.repeat(64) }));
  await assert.rejects(extractNotificationPolicy(unpacked, policyDir), /来源摘要不匹配/);

  await writeFile(path.join(policyDir, 'notification-policy.json'), JSON.stringify({ ...validPolicy, byteOffset: sourceBuf.length }));
  await assert.rejects(extractNotificationPolicy(unpacked, policyDir), /字节区段无效/);

  await writeFile(path.join(policyDir, 'notification-policy.json'), JSON.stringify({ ...validPolicy, sha256: '0'.repeat(64) }));
  await assert.rejects(extractNotificationPolicy(unpacked, policyDir), /原通知判定器摘要不匹配/);

  await writeFile(path.join(policyDir, 'notification-policy.json'), JSON.stringify({ ...validPolicy, exportName: 'bad-name!' }));
  await assert.rejects(extractNotificationPolicy(unpacked, policyDir), /导出名无效/);
});

test('chmodNativeHelpers restores executable permissions on all 1.2.3 native binaries including sand-meeting-recorder', async t => {
  assert.deepEqual(NATIVE_HELPERS, ['sand-meeting-recorder', 'sand-op-launcher', 'sand-webauthn-signer']);
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-native-chmod-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const nativeDir = path.join(tmp, 'dist/native');
  await mkdir(nativeDir, { recursive: true });
  for (const name of NATIVE_HELPERS) {
    const file = path.join(nativeDir, name);
    await writeFile(file, '#!/bin/sh\n');
    await chmod(file, 0o644);
  }
  await chmodNativeHelpers(tmp);
  for (const name of NATIVE_HELPERS) {
    const info = await stat(path.join(nativeDir, name));
    assert.equal(info.mode & 0o111, 0o111, `${name} should be executable`);
  }
});

test('macOS patcher performs full 1.2.3 DMG build with RokBot icons, bundle ID, URL scheme, native permissions, model-bridge, and codesign', { skip: process.platform !== 'darwin' || !existsSync(cachedMac123) }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rokbot-dmg-build-123-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outApp = path.join(dir, 'RokBot.app');
  const backupApp = path.join(dir, 'Backup.app');
  const { pem, spkiBase64 } = p256Pair();

  const { stdout } = await execFileAsync(process.execPath, [
    macPatchCli,
    '--source', cachedMac123,
    '--output', outApp,
    '--backup', backupApp,
    '--update-url', 'https://updates.example.com/desktop',
    '--update-public-key', pem,
  ], { maxBuffer: 10 * 1024 * 1024 });

  const lines = stdout.trim().split('\n');
  const buildReport = JSON.parse(lines.slice(1).join('\n'));
  assert.equal(buildReport.version, '1.2.3');
  assert.equal(buildReport.bundleId, 'dev.rokbot.local');
  assert.equal(buildReport.rokbotIconApplied, true);

  await execFileAsync('codesign', ['--verify', '--deep', '--strict', outApp]);

  const { stdout: plistJson } = await execFileAsync('plutil', ['-convert', 'json', '-o', '-', path.join(outApp, 'Contents/Info.plist')]);
  const plist = JSON.parse(plistJson);
  assert.equal(plist.CFBundleIdentifier, 'dev.rokbot.local');
  assert.equal(plist.CFBundleIconFile, 'icon.icns');
  assert.equal('CFBundleIconName' in plist, false);
  assert.deepEqual(plist.CFBundleURLTypes?.[0]?.CFBundleURLSchemes, ['rokbot-local']);

  const outResources = path.join(outApp, 'Contents/Resources');
  assert.equal(existsSync(path.join(outResources, 'Assets.car')), false);
  assert.equal(
    sha(await readFile(path.join(outResources, 'icon.icns'))),
    sha(await readFile(path.join(repoRoot, 'assets/logo/rokbot.icns'))),
  );
  assert.deepEqual(JSON.parse(await readFile(path.join(outResources, 'rokbot-local-update.json'), 'utf8')), {
    updateUrl: 'https://updates.example.com/desktop',
    updatePublicKey: spkiBase64,
  });

  const asar = createRequire(path.join(macPatchDir, 'package.json'))('@electron/asar');
  const outAsar = path.join(outResources, 'app.asar');
  const expectedAsarHeaderHash = sha(asar.getRawHeader(outAsar).headerString);
  assert.equal(plist.ElectronAsarIntegrity?.['Resources/app.asar']?.hash, expectedAsarHeaderHash);

  assert.equal(
    sha(asar.extractFile(outAsar, 'local-client/icon.png')),
    sha(await readFile(path.join(repoRoot, 'assets/logo/rokbot-icon-512.png'))),
  );
  assert.ok(asar.extractFile(outAsar, 'local-client/model-bridge.mjs').length > 0);
  const extractedPolicyPath = path.join(dir, 'extracted-notification-policy.mjs');
  await writeFile(extractedPolicyPath, asar.extractFile(outAsar, 'local-client/notification-policy.mjs'));
  const { NotificationDecider } = await import(pathToFileURL(extractedPolicyPath).href);
  const defaultDecider = new NotificationDecider();
  assert.ok(defaultDecider);
  const decider = new NotificationDecider(0, 'message-history');
  const baseAgent = {
    id: 'agent-1',
    name: 'Agent 1',
    purpose: 'test',
    isGroup: false,
    isRunning: true,
    awaitingReason: null,
    awaitingReasonCopy: null,
    notifyEnabled: true,
    isHiddenFromSidebar: false,
    memberIds: [],
    lastMessageAuthorId: 'user',
    lastMessageId: 'msg-1',
    lastMessageTaskId: 'task-1',
    lastMessagePreview: 'Working',
    lastMessagePreviewSource: 'assistant',
    pushMessageContent: null,
  };
  decider.seedBaseline([baseAgent]);
  const nextAgent = {
    ...baseAgent,
    isRunning: false,
    lastMessageId: 'msg-2',
    lastMessageAuthorId: 'agent',
    lastMessagePreview: 'Done',
  };
  const transition = {
    ...nextAgent,
    agentId: nextAgent.id,
    agentName: nextAgent.name,
    kind: 'agent-done',
    reason: null,
    reasonCopy: null,
  };
  const decisions = decider.gateTransitions([transition], { focus: { kind: 'unfocused' }, nowMs: 10_000 });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].verdict, 'deliver');
  decider.retainOnly(new Set(['agent-1']));
  decider.retainOnly(new Set());
  const patchedView = asar.extractFile(outAsar, 'dist/renderer/assets/chunk-view-BuQdbmNp.js').toString('utf8');
  assert.match(patchedView, /function GrokLocalUpdateSettings\(/);

  for (const rel of [
    'Contents/Resources/rokbot-tailcat',
    ...NATIVE_HELPERS.map(name => `Contents/Resources/app.asar.unpacked/dist/native/${name}`),
  ]) {
    const info = await stat(path.join(outApp, rel));
    assert.equal(info.mode & 0o111, 0o111, `${rel} must be executable`);
  }
});
