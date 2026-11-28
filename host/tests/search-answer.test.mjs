import assert from 'node:assert/strict';
import test from 'node:test';
import { searchAnswer, withSearchAnswer } from '../runtime/search-answer.mjs';

test('a bare match array becomes one complete page', () => {
  const matches = [{ agentId: 'a', entryId: 'e1' }];
  assert.deepEqual(searchAnswer(matches), { matches, coverage: { kind: 'complete' } });
});

test('an answer that already carries coverage keeps a paged coverage', () => {
  const matches = [{ agentId: 'a', fileName: 'x.png' }];
  assert.deepEqual(searchAnswer({ matches, coverage: { kind: 'recent' } }), { matches, coverage: { kind: 'recent' } });
  assert.deepEqual(searchAnswer({ matches, coverage: { kind: 'resumable' } }), { matches, coverage: { kind: 'resumable' } });
  assert.deepEqual(searchAnswer({ matches, coverage: { kind: 'weird' } }), { matches, coverage: { kind: 'complete' } });
});

test('an unreadable reply answers an empty complete page', () => {
  for (const reply of [null, undefined, 'nonsense', 7, {}, { coverage: { kind: 'recent' } }]) {
    assert.deepEqual(searchAnswer(reply), { matches: [], coverage: { kind: 'complete' } });
  }
});

test('the gateway API answers searchAgents and searchMedia in the container shape', async () => {
  const seen = [];
  const api = {
    searchAgents: async (...args) => { seen.push(['searchAgents', args]); return [{ agentId: 'a', snippet: 'ip' }]; },
    searchMedia: async (...args) => { seen.push(['searchMedia', args]); return { matches: [], coverage: { kind: 'resumable' } }; },
  };
  const wrapped = withSearchAnswer(api);
  assert.deepEqual(await wrapped.searchAgents({ query: 'ip', limit: 5 }),
    { matches: [{ agentId: 'a', snippet: 'ip' }], coverage: { kind: 'complete' } });
  assert.deepEqual(await wrapped.searchMedia({ query: 'ip' }),
    { matches: [], coverage: { kind: 'resumable' } });
  assert.deepEqual(seen, [['searchAgents', [{ query: 'ip', limit: 5 }]], ['searchMedia', [{ query: 'ip' }]]]);
  // Other methods pass through untouched, and a Host error still propagates.
  const failing = withSearchAnswer({ searchAgents: async () => { throw new Error('Search unavailable'); } });
  await assert.rejects(() => failing.searchAgents({ query: 'x' }), /Search unavailable/);
});
