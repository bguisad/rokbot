import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OMITTED_IMAGE_NOTE,
  optimizeMessageImages,
  pruneHistoricalImages,
  resetImageCache,
} from '../runtime/image-context.mjs';
import { createModelSession } from '../runtime/model-session.mjs';
import { catalogContextPolicy } from '../runtime/model-policy.mjs';

function makeImageConversation(count, { tailOnly = false } = {}) {
  const messages = [];
  if (tailOnly) {
    messages.push({ role: 'user', content: 'start' });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: 'ready' }] });
    messages.push({
      role: 'user',
      content: Array.from({ length: count }, (_, idx) => ({
        type: 'image',
        image: Buffer.from(`img-${idx}`).toString('base64'),
        mimeType: 'image/png',
      })),
    });
    return messages;
  }

  for (let i = 0; i < count; i++) {
    if (i % 3 === 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `turn ${i}` },
          { type: 'image', image: Buffer.from(`img-${i}`).toString('base64'), mimeType: 'image/png' },
        ],
      });
    } else if (i % 3 === 1) {
      messages.push({
        role: 'user',
        content: [
          { type: 'file', data: `data:image/png;base64,${Buffer.from(`img-${i}`).toString('base64')}`, mimeType: 'image/png' },
        ],
      });
    } else {
      messages.push({
        role: 'tool',
        content: [{
          type: 'tool-result',
          toolCallId: `call_${i}`,
          toolName: 'Screenshot',
          result: 'ok',
          experimental_content: [
            { type: 'image', data: Buffer.from(`img-${i}`).toString('base64'), mimeType: 'image/png' },
          ],
        }],
      });
    }
    if (i < count - 1) {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: `ack ${i}` }] });
    }
  }
  return messages;
}

function countImages(messages) {
  let kept = 0, omitted = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content) {
      if (p.type === 'image' || p.type === 'file') kept++;
      if (p.type === 'text' && p.text === OMITTED_IMAGE_NOTE) omitted++;
      if (p.type === 'tool-result' && Array.isArray(p.experimental_content)) {
        for (const e of p.experimental_content) {
          if (e.type === 'image') kept++;
          if (e.type === 'text' && e.text === OMITTED_IMAGE_NOTE) omitted++;
        }
      }
    }
  }
  return { kept, omitted };
}

test('pruneHistoricalImages uses step-function batches for KV-cache stability and never mutates input', () => {
  for (let n = 1; n <= 8; n++) {
    const msgs = makeImageConversation(n);
    const pruned = pruneHistoricalImages(msgs);
    assert.equal(pruned, msgs, `n=${n} should not evict`);
    assert.deepEqual(countImages(pruned), { kept: n, omitted: 0 });
  }

  const orig9 = makeImageConversation(9);
  const snapshot = structuredClone(orig9);
  const pruned9 = pruneHistoricalImages(orig9);
  assert.deepEqual(orig9, snapshot, 'input must not be mutated');
  assert.deepEqual(countImages(pruned9), { kept: 5, omitted: 4 });

  const pruned10 = pruneHistoricalImages(makeImageConversation(10));
  const pruned11 = pruneHistoricalImages(makeImageConversation(11));
  assert.deepEqual(countImages(pruned10), { kept: 6, omitted: 4 });
  assert.deepEqual(countImages(pruned11), { kept: 7, omitted: 4 });
  assert.deepEqual(
    pruned10.slice(0, pruned9.length),
    pruned9,
    'prefix must stay identical from 9 to 10 images to preserve KV cache',
  );
  assert.deepEqual(
    pruned11.slice(0, pruned9.length),
    pruned9,
    'prefix must stay identical from 9 to 11 images to preserve KV cache',
  );

  const pruned12 = pruneHistoricalImages(makeImageConversation(12));
  const pruned13 = pruneHistoricalImages(makeImageConversation(13));
  assert.deepEqual(countImages(pruned12), { kept: 4, omitted: 8 });
  assert.deepEqual(countImages(pruned13), { kept: 5, omitted: 8 });
});

test('pruneHistoricalImages never evicts images from the current turn after the last assistant message', () => {
  const msgs = makeImageConversation(10, { tailOnly: true });
  const pruned = pruneHistoricalImages(msgs);
  assert.deepEqual(countImages(pruned), { kept: 10, omitted: 0 });
});

test('optimizeMessageImages compresses large images, hits SHA-256 cache, skips tiny/remote/errors cleanly', async () => {
  resetImageCache();
  const largePng = Buffer.alloc(120 * 1024, 0x41);
  const largeB64 = largePng.toString('base64');
  const smallB64 = Buffer.from('AAAA').toString('base64');
  let calls = 0;

  const compressImage = async (bytes) => {
    calls++;
    assert.equal(bytes.length, largePng.length);
    return {
      bytes: Buffer.from('compressed-jpeg-bytes'),
      mimeType: 'image/jpeg',
      origWidth: 1920,
      origHeight: 1080,
      width: 1024,
      height: 576,
    };
  };

  const messages = [
    {
      role: 'user',
      content: [
        { type: 'image', image: smallB64, mimeType: 'image/png' },
        { type: 'image', image: 'https://example.com/pic.png', mimeType: 'image/png' },
        { type: 'image', image: `data:image/png;base64,${largeB64}`, mimeType: 'image/png' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'saw it' }] },
    {
      role: 'tool',
      content: [{
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'Screenshot',
        result: 'ok',
        experimental_content: [
          { type: 'image', data: largeB64, mimeType: 'image/png' },
        ],
      }],
    },
  ];

  const first = await optimizeMessageImages(messages, { compressImage });
  assert.equal(calls, 1, 'same image payload in second message should hit SHA-256 cache');
  assert.equal(first[0].content[0].image, smallB64, 'tiny image remains untouched');
  assert.equal(first[0].content[1].image, 'https://example.com/pic.png', 'remote URL remains untouched');
  assert.equal(first[0].content[2].mimeType, 'image/jpeg');
  assert.equal(first[0].content[2].image, `data:image/jpeg;base64,${Buffer.from('compressed-jpeg-bytes').toString('base64')}`);
  assert.equal(first[2].content[0].experimental_content[0].mimeType, 'image/jpeg');
  assert.equal(first[2].content[0].experimental_content[0].data, Buffer.from('compressed-jpeg-bytes').toString('base64'));

  // Repeat on next turn -> 0 additional compressImage calls.
  await optimizeMessageImages(messages, { compressImage });
  assert.equal(calls, 1);

  // Failing compressor falls back gracefully to original image.
  resetImageCache();
  const broken = await optimizeMessageImages(messages, {
    compressImage: async () => { throw new Error('decoder boom'); },
  });
  assert.equal(broken[0].content[2].image, `data:image/png;base64,${largeB64}`);

  // Non-shrinking compressor keeps original image.
  resetImageCache();
  const bigger = await optimizeMessageImages(messages, {
    compressImage: async (bytes) => ({ bytes: Buffer.alloc(bytes.length + 100, 1), mimeType: 'image/jpeg' }),
  });
  assert.equal(bigger[0].content[2].mimeType, 'image/png');
});

function sseForFormat(apiFormat) {
  if (apiFormat === 'anthropic') {
    const events = [
      { type: 'message_start', message: { id: 'm1', usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  if (apiFormat === 'openai-responses') {
    const events = [
      { type: 'response.output_text.delta', output_index: 0, item_id: 'msg_1', delta: 'ok' },
      { type: 'response.completed', response: { id: 'r1', model: 'm', output: [{ id: 'msg_1', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 10, output_tokens: 1 } } },
    ];
    return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }
  const events = [
    { id: 'c1', model: 'm', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 1 } },
  ];
  return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

test('createModelSession applies image pruning and compression across all 3 API formats', async () => {
  resetImageCache();
  const bigPng = Buffer.alloc(100 * 1024, 0x55).toString('base64');
  const smallJpeg = Buffer.from('tiny-jpeg');
  const compressImage = async () => ({ bytes: smallJpeg, mimeType: 'image/jpeg' });

  for (const apiFormat of ['openai', 'openai-responses', 'anthropic']) {
    resetImageCache();
    let capturedBody;
    const messages = [];
    for (let i = 0; i < 9; i++) {
      messages.push({ role: 'user', content: [{ type: 'image', image: bigPng, mimeType: 'image/png' }] });
      if (i < 8) messages.push({ role: 'assistant', content: [{ type: 'text', text: `r${i}` }] });
    }
    const session = createModelSession({
      apiFormat,
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'test-model',
      imageContext: { compressImage },
      fetchImpl: async (_url, options) => {
        capturedBody = JSON.parse(options.body);
        return sseForFormat(apiFormat);
      },
    });
    const res = session.getExecutor(messages).stream({}, 'inv-img', []);
    for await (const _ of res.fullStream) { /* drain */ }
    await res.response;

    const serialized = JSON.stringify(capturedBody);
    const jpegMatches = serialized.match(/image\/jpeg;base64,/g) || serialized.match(/"media_type":"image\/jpeg"/g) || [];
    assert.equal(jpegMatches.length, 5, `${apiFormat} should send 5 compressed JPEG images (9 - 4 evicted)`);
    assert.ok(serialized.includes('Earlier image omitted from context'), `${apiFormat} should include omission marker`);
  }
});

test('catalogContextPolicy scales summaryThresholdTokens proportionally for 1M and smaller context windows', () => {
  assert.deepEqual(catalogContextPolicy('deepseek-v4.1-flash', 1_048_576), {
    contextWindowTokens: 1_048_576,
    summaryThresholdTokens: 786_000,
    contextSource: 'provider',
  });
  assert.deepEqual(catalogContextPolicy('provider-200k', 200_000), {
    contextWindowTokens: 200_000,
    summaryThresholdTokens: 150_000,
    contextSource: 'provider',
  });
  assert.deepEqual(catalogContextPolicy('provider-128k', 128_000), {
    contextWindowTokens: 128_000,
    summaryThresholdTokens: 96_000,
    contextSource: 'provider',
  });
});
