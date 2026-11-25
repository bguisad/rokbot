import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { installRemoteBoxAdapter } from '../runtime/remote-box.mjs';

const run = promisify(execFile);
const CHUNK = 12 * 1024;

// The box shell, run locally: the real python3 reader script against a real file.
function remoteBox({ onExec = async () => {} } = {}) {
  const stats = { execs: 0, inFlight: 0, maxInFlight: 0 };
  class LoopbackSandBox {
    constructor(options) { this.options = options; }
    async assertFileReadAllowed() {}
    async ensureReady() {
      return { remoteAccessor: { get: () => ({ execute: async (_ctx, args) => {
        stats.execs += 1; stats.inFlight += 1; stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        try {
          await onExec(stats);
          const { stdout } = await run('sh', ['-c', args.command], { maxBuffer: 1 << 20 });
          return { result: { case: 'success', value: { exitCode: 0, stdout } } };
        } catch (error) {
          if (error.code === undefined) throw error;
          return { result: { case: 'success', value: { exitCode: error.code, stdout: '' } } };
        } finally { stats.inFlight -= 1; }
      } }) } };
    }
  }
  class BoxFileUnreadableError extends Error {}
  const bindings = { LoopbackSandBox, buildHostShellArgs: args => args };
  installRemoteBoxAdapter(bindings, { shellExecutorResource: Symbol('shell'), BoxFileUnreadableError },
    { ROKBOT_BOX_HOST: 'box' });
  return { box: bindings.createSandBox({}), stats, BoxFileUnreadableError };
}

async function fixture(t, bytes) {
  const dir = await mkdtemp(join(tmpdir(), 'rokbot-remote-box-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'promo.mp4');
  await writeFile(file, bytes);
  return file;
}

test('RemoteBox downloads a multi-chunk box file byte for byte with several reads in flight', async t => {
  const bytes = randomBytes(40 * CHUNK + 321);
  const file = await fixture(t, bytes);
  const { box, stats } = remoteBox({ onExec: () => new Promise(resolve => setTimeout(resolve, 5)) });
  const downloaded = await box.downloadFile({}, 'agent', file);
  assert.deepEqual(Buffer.from(downloaded), bytes);
  assert.equal(stats.execs, 41);
  assert.ok(stats.maxInFlight > 1 && stats.maxInFlight <= 8, `in flight: ${stats.maxInFlight}`);

  for (const size of [0, 1, CHUNK, CHUNK + 1]) {
    const small = randomBytes(size);
    assert.deepEqual(Buffer.from(await remoteBox().box.downloadFile({}, 'agent', await fixture(t, small))), small);
  }
});

test('RemoteBox rejects a box file that changes mid-download and stops reading', async t => {
  const file = await fixture(t, randomBytes(30 * CHUNK));
  const { box, stats } = remoteBox({ onExec: async ({ execs }) => { if (execs === 3) await appendFile(file, 'x'); } });
  await assert.rejects(box.downloadFile({}, 'agent', file), /changed during download/);
  assert.ok(stats.execs < 30, `stopped after ${stats.execs} reads`);
});

test('RemoteBox reports a missing box file and honours cancellation', async t => {
  const { box, BoxFileUnreadableError } = remoteBox();
  await assert.rejects(box.downloadFile({}, 'agent', join(tmpdir(), 'rokbot-missing-file.mp4')), BoxFileUnreadableError);
  const file = await fixture(t, randomBytes(4 * CHUNK));
  const controller = new AbortController();
  controller.abort(new Error('cancelled by the caller'));
  await assert.rejects(box.downloadFile({ signal: controller.signal }, 'agent', file), /cancelled by the caller/);
});
