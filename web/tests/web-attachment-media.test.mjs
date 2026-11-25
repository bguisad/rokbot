import assert from 'node:assert/strict';
import { resolveObjectURL } from 'node:buffer';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHUNK = 4 * 1024 * 1024;

/** web/client as the bundle lays it out: the shared desktop helpers under ./desktop. */
async function loadWebServices(t) {
  const stage = await mkdtemp(path.join(tmpdir(), 'rokbot-web-media-'));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await cp(path.join(repo, 'web/client'), path.join(stage, 'client'), { recursive: true });
  await cp(path.join(repo, 'mac/clients/desktop'), path.join(stage, 'client/desktop'), { recursive: true });
  return await import(pathToFileURL(path.join(stage, 'client/services.js')).href);
}

const blobBytes = async url => Buffer.from(await resolveObjectURL(url).arrayBuffer());

test('Web/Android plays Host video and audio attachments from blob URLs read through readAttachmentChunk', async t => {
  const { createAttachments, createStaging, playableMediaKind } = await loadWebServices(t);
  assert.equal(playableMediaKind('/a/clip.MP4'), 'video');
  assert.equal(playableMediaKind('/a/voice.m4a'), 'audio');
  assert.equal(playableMediaKind('/a/shot.png'), null);
  const video = Buffer.concat([Buffer.from('000000206674797069736f6d', 'hex'), Buffer.alloc(CHUNK + 99, 3)]);
  const audio = Buffer.from('fixture audio');
  const files = { '/data/agents/a/attachments/clip.mp4': [video, 'video/mp4'], '/data/agents/a/attachments/voice.mp3': [audio, 'audio/mpeg'] };
  const calls = [];
  const command = async (method, args) => {
    calls.push([method, args]);
    assert.equal(method, 'readAttachmentChunk', 'video and audio must not go through readAttachmentImage');
    const [bytes, mime] = files[args.path];
    return { totalSize: bytes.length, mime, bytesBase64: bytes.subarray(args.offset, args.offset + args.length).toString('base64') };
  };
  const staging = createStaging();
  const attachments = createAttachments({ command, staging, onProgress: () => {} });
  const source = 'file:///data/agents/a/attachments/clip.mp4';
  const [first, second] = await Promise.all([attachments.resolveAttachmentMedia({ source, rendition: 'preview' }),
    attachments.resolveAttachmentMedia({ source })]);
  assert.deepEqual(first, second);
  assert.equal(first.kind, 'video');
  assert.equal(first.width, null);
  assert.match(first.src, /^blob:/);
  const blob = resolveObjectURL(first.src);
  assert.equal(blob.type, 'video/mp4');
  assert.deepEqual(await blobBytes(first.src), video);
  assert.ok(calls.every(([, args]) => args.videoPlayback === true));
  assert.equal(calls.filter(([, args]) => args.length > 0).length, 2, 'one copy for concurrent renders');

  calls.length = 0;
  const sound = await attachments.resolveAttachmentMedia({ source: 'file:///data/agents/a/attachments/voice.mp3' });
  assert.equal(sound.kind, 'audio');
  assert.deepEqual(await blobBytes(sound.src), audio);
  assert.ok(calls.every(([, args]) => args.videoPlayback === undefined));

  const draft = staging.put('local.webm', new Uint8Array([1, 2, 3]));
  calls.length = 0;
  const local = await attachments.resolveAttachmentMedia({ source: draft });
  assert.equal(local.kind, 'video');
  assert.deepEqual(await blobBytes(local.src), Buffer.from([1, 2, 3]));
  assert.deepEqual(calls, [], 'a staged draft plays without a Host round trip');
});

test('Web/Android rejects a Host video that changes mid-read and retries it later', async t => {
  const { createAttachments, createStaging } = await loadWebServices(t);
  let size = CHUNK + 1;
  const command = async (_method, { offset, length }) =>
    ({ totalSize: offset ? size + 1 : size, mime: 'video/mp4', bytesBase64: Buffer.alloc(length, 1).toString('base64') });
  const attachments = createAttachments({ command, staging: createStaging(), onProgress: () => {} });
  const source = 'file:///data/agents/a/attachments/clip.mp4';
  await assert.rejects(attachments.resolveAttachmentMedia({ source }), /changed/i);
  size = 5;
  const media = await attachments.resolveAttachmentMedia({ source });
  assert.equal((await blobBytes(media.src)).length, 5);
});
