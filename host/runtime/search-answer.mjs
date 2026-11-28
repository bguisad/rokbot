// The interface reads every search reply as { matches, coverage }; a bare match array (what the
// recovered Host kernel answers with) is rejected as source/malformed-reply, which showed up as
// "search unavailable" on Android. searchAgents and searchMedia are answered in that shape on the
// gateway API the clients actually talk to, not only on the server's /api facade.

/** Keep the Host's coverage when it pages, and answer every other readable reply as one complete page. */
export function searchAnswer(reply) {
  // Only a reply that actually carries matches may keep a paged coverage.
  const list = Array.isArray(reply) ? reply : Array.isArray(reply?.matches) ? reply.matches : null;
  const matches = list ?? [];
  const coverage = list ? reply?.coverage?.kind : undefined;
  return { matches, coverage: coverage === 'recent' || coverage === 'resumable' ? reply.coverage : { kind: 'complete' } };
}

const SEARCH_METHODS = ['searchAgents', 'searchMedia'];

export function withSearchAnswer(api) {
  if (api == null) return api;
  const wrapped = { ...api };
  for (const name of SEARCH_METHODS) {
    if (typeof api[name] !== 'function') continue;
    wrapped[name] = async (...args) => searchAnswer(await api[name](...args));
  }
  return wrapped;
}
