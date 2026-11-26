import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildZipStore, crc32, uniqueEntryName } from '../../mac/clients/desktop/zip-store.mjs';
import { createAttachmentHandlers } from '../../mac/clients/desktop/attachments.mjs';
import { readZip, entryBytes } from '../../android/patchers/signing.mjs';

const extSource = await readFile(new URL('./desktop-recipes/extensions/batch-image-download.js', import.meta.url), 'utf8');

test('zip-store builds valid ZIP STORE archives with UTF-8 names and deduplication', () => {
  const taken = new Set();
  assert.equal(uniqueEntryName('/dir/photo.png', taken), 'photo.png');
  assert.equal(uniqueEntryName('photo.png', taken), 'photo (1).png');
  assert.equal(uniqueEntryName('PHOTO.PNG', taken), 'PHOTO (2).PNG');
  assert.equal(uniqueEntryName('../evil:name?.jpg', taken), 'evil_name_.jpg');

  const files = [
    { name: '图表.png', data: Buffer.from('PNG-BYTES-ONE') },
    { name: '图表.png', data: Buffer.from('PNG-BYTES-TWO') },
    { name: 'photo.jpg', data: Buffer.from('JPG-BYTES') },
  ];
  const zip = Buffer.from(buildZipStore(files));
  const parsed = readZip(zip);
  assert.deepEqual(parsed.entries.map(e => e.name), ['图表.png', '图表 (1).png', 'photo.jpg']);
  assert.equal(entryBytes(parsed.entries[0]).toString(), 'PNG-BYTES-ONE');
  assert.equal(entryBytes(parsed.entries[1]).toString(), 'PNG-BYTES-TWO');
  assert.equal(entryBytes(parsed.entries[2]).toString(), 'JPG-BYTES');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('desktop attachment handlers support downloadAttachments (folder) and downloadAttachmentsZip', async t => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'rokbot-batch-dl-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const outFolder = path.join(tmp, 'saved');
  await mkdir(outFolder, { recursive: true });
  const zipDest = path.join(tmp, 'bundle.zip');

  const remoteFiles = new Map([
    ['/host/a.png', Buffer.from('IMG-ALPHA')],
    ['/host/b.png', Buffer.from('IMG-BETA-DATA')],
  ]);
  let errorShown = 0;
  const handlers = createAttachmentHandlers({
    command: async (method, args) => {
      assert.equal(method, 'readAttachmentChunk');
      const data = remoteFiles.get(args.path);
      if (!data) return null;
      const slice = data.subarray(args.offset, args.offset + args.length);
      return { totalSize: data.length, bytesBase64: slice.toString('base64'), resolvedName: path.basename(args.path) };
    },
    chooseDestination: async () => zipDest,
    chooseDirectory: async () => outFolder,
    showDownloadError: async () => { errorShown++; },
  });

  const okFolder = await handlers.downloadAttachments({
    downloads: [
      { path: '/host/a.png', suggestedName: 'pic.png' },
      { path: '/host/b.png', suggestedName: 'pic.png' },
    ],
  });
  assert.equal(okFolder, true);
  assert.equal(errorShown, 0);
  const savedNames = (await readdir(outFolder)).sort();
  assert.deepEqual(savedNames, ['pic (1).png', 'pic.png']);
  assert.equal(await readFile(path.join(outFolder, 'pic.png'), 'utf8'), 'IMG-ALPHA');
  assert.equal(await readFile(path.join(outFolder, 'pic (1).png'), 'utf8'), 'IMG-BETA-DATA');

  const okZip = await handlers.downloadAttachmentsZip({
    downloads: [
      { path: '/host/a.png', suggestedName: 'one.png' },
      { path: '/host/b.png', suggestedName: 'two.png' },
    ],
    suggestedName: 'bundle.zip',
  });
  assert.equal(okZip, true);
  const parsed = readZip(await readFile(zipDest));
  assert.deepEqual(parsed.entries.map(e => e.name), ['one.png', 'two.png']);
  assert.equal(entryBytes(parsed.entries[0]).toString(), 'IMG-ALPHA');
  assert.equal(entryBytes(parsed.entries[1]).toString(), 'IMG-BETA-DATA');
});

test('batch-image-download.js tracks images per conversation and renders Media Viewer button + multi-select modal', async () => {
  const jsx = (type, props, key) => ({ type, props, key });
  const listeners = new Map();
  const win = {
    desktop: { main: { downloadAttachments: async () => true, resolveAttachmentMedia: async () => null } },
    localBot: { downloadAttachmentsZip: async () => true },
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: () => {},
    dispatchEvent: ev => { for (const fn of listeners.get(ev.type) ?? []) fn(ev); },
  };
  const ctx = vm.createContext({
    window: win,
    document: { body: null },
    Event: class Event { constructor(type) { this.type = type; } },
    grokText: (zh) => zh,
    Z: { jsx, jsxs: jsx, Fragment: 'Fragment' },
    X: {
      useMemo: fn => fn(),
      useState: init => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useRef: v => ({ current: v }),
      useSyncExternalStore: (_sub, snap) => snap(),
    },
    BS: {},
    Yt: () => null,
  });
  ctx.globalThis = ctx;
  vm.runInContext(extSource, ctx);

  // Per-conversation image tracking
  ctx.rokSetActiveAgentId('bot-1');
  await ctx.rokTrackResolvedMedia({ source: '/a/1.png' }, Promise.resolve({ kind: 'image', src: 'data:image/png;base64,AAA', width: 100, height: 100 }));
  await ctx.rokTrackResolvedMedia({ source: '/a/2.jpg' }, Promise.resolve({ kind: 'image', src: 'data:image/jpeg;base64,BBB', width: 100, height: 100 }));
  await ctx.rokTrackResolvedMedia({ source: '/a/video.mp4' }, Promise.resolve({ kind: 'video', src: 'blob:1' }));
  assert.equal(ctx.rokBatchImageStore().getSnapshot().items.length, 2);

  // Switching conversation isolates tracked images
  ctx.rokSetActiveAgentId('bot-2');
  assert.equal(ctx.rokBatchImageStore().getSnapshot().items.length, 0);
  ctx.rokSetActiveAgentId('bot-1');
  assert.equal(ctx.rokBatchImageStore().getSnapshot().items.length, 2);

  // Media viewer button hides for 1 image and renders for 2+ images
  assert.equal(ctx.RokMediaViewerBatchButton({ sources: ['/a/1.png'], captions: [], embedded: false }), null);
  const mvBtn = ctx.RokMediaViewerBatchButton({ sources: ['/a/1.png', '/a/2.jpg', '/a/video.mp4'], captions: ['One', 'Two'], embedded: false });
  assert.equal(mvBtn.type, 'button');
  assert.equal(mvBtn.props['data-rokbot-batch-download'], 'media-viewer');

  // Verify no emoji characters anywhere in the extension UI
  assert.doesNotMatch(extSource, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
});
