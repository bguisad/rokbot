// RokBot canvas SDK: layered layout for directed graphs (longest-path ranks, barycenter order).

export function countEdgeCrossings(rankGroups, edges, rank) {
  const pos = new Map();
  for (const ids of rankGroups.values()) ids.forEach((id, i) => pos.set(id, i));
  const byPair = new Map();
  for (const e of edges) {
    const a = rank.get(e.from);
    const b = rank.get(e.to);
    if (a == null || b == null || b <= a) continue;
    const k = `${a}:${b}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push([pos.get(e.from), pos.get(e.to)]);
  }
  let n = 0;
  for (const list of byPair.values()) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [s1, t1] = list[i];
        const [s2, t2] = list[j];
        if ((s1 - s2) * (t1 - t2) < 0) n++;
      }
    }
  }
  return n;
}

export function computeDAGLayout(options = {}) {
  const {
    nodes = [], edges = [], direction = "vertical", nodeWidth = 160, nodeHeight = 40, rankGap = 64, nodeGap = 48, padding = 24,
  } = options;
  const ids = [];
  const seen = new Set();
  for (const n of nodes) if (n && n.id != null && !seen.has(String(n.id))) { seen.add(String(n.id)); ids.push(String(n.id)); }
  const valid = edges.filter((e) => e && seen.has(String(e.from)) && seen.has(String(e.to))).map((e) => ({ from: String(e.from), to: String(e.to) }));

  // Back-edges via iterative DFS (white/gray/black), in node order.
  const out = new Map(ids.map((id) => [id, []]));
  valid.forEach((e, i) => out.get(e.from).push(i));
  const state = new Map();
  const back = new Set();
  for (const root of ids) {
    if (state.get(root)) continue;
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = out.get(top[0]);
      if (top[1] < list.length) {
        const ei = list[top[1]++];
        const to = valid[ei].to;
        const s = state.get(to);
        if (s === 1) back.add(ei);
        else if (!s) { state.set(to, 1); stack.push([to, 0]); }
      } else {
        state.set(top[0], 2);
        stack.pop();
      }
    }
  }
  const forward = valid.filter((e, i) => !back.has(i) && e.from !== e.to);

  // Longest-path ranking (Kahn's order over forward edges).
  const indeg = new Map(ids.map((id) => [id, 0]));
  const succ = new Map(ids.map((id) => [id, []]));
  const pred = new Map(ids.map((id) => [id, []]));
  for (const e of forward) { indeg.set(e.to, indeg.get(e.to) + 1); succ.get(e.from).push(e.to); pred.get(e.to).push(e.from); }
  const rank = new Map(ids.map((id) => [id, 0]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    for (const t of succ.get(id)) {
      rank.set(t, Math.max(rank.get(t), rank.get(id) + 1));
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) queue.push(t);
    }
  }

  const maxRank = ids.reduce((m, id) => Math.max(m, rank.get(id)), -1);
  let groups = new Map();
  for (let r = 0; r <= maxRank; r++) groups.set(r, []);
  for (const id of ids) groups.get(rank.get(id)).push(id);

  // Barycenter sweeps, keeping the ordering with the fewest crossings.
  const clone = (g) => new Map([...g].map(([k, v]) => [k, v.slice()]));
  let best = clone(groups);
  let bestX = countEdgeCrossings(best, forward, rank);
  const sweep = (down) => {
    const pos = new Map();
    for (const list of groups.values()) list.forEach((id, i) => pos.set(id, i));
    const ranks = [...groups.keys()];
    if (!down) ranks.reverse();
    for (const r of ranks.slice(1)) {
      const list = groups.get(r);
      const bary = new Map();
      list.forEach((id, i) => {
        const nb = (down ? pred : succ).get(id);
        bary.set(id, nb.length ? nb.reduce((a, n) => a + pos.get(n), 0) / nb.length : i);
      });
      list.sort((a, b) => bary.get(a) - bary.get(b) || pos.get(a) - pos.get(b));
      list.forEach((id, i) => pos.set(id, i));
    }
  };
  for (let it = 0; it < 8 && bestX > 0; it++) {
    sweep(it % 2 === 0);
    const x = countEdgeCrossings(groups, forward, rank);
    if (x < bestX) { bestX = x; best = clone(groups); }
  }
  groups = best;

  // Coordinates.
  const vertical = direction !== "horizontal";
  const along = vertical ? nodeWidth : nodeHeight; // size within a rank
  const across = vertical ? nodeHeight : nodeWidth; // size of a rank
  const widest = Math.max(0, ...[...groups.values()].map((l) => l.length * along + Math.max(0, l.length - 1) * nodeGap));
  const placed = new Map();
  const rankBoxes = [];
  for (const [r, list] of groups) {
    const span = list.length * along + Math.max(0, list.length - 1) * nodeGap;
    const start = padding + (widest - span) / 2;
    const offset = padding + r * (across + rankGap);
    list.forEach((id, i) => {
      const a = start + i * (along + nodeGap);
      placed.set(id, vertical ? { id, x: a, y: offset, rank: r, order: i } : { id, x: offset, y: a, rank: r, order: i });
    });
    rankBoxes.push(vertical
      ? { rank: r, x: start, y: offset, width: span, height: nodeHeight, nodeIds: list.slice() }
      : { rank: r, x: offset, y: start, width: nodeWidth, height: span, nodeIds: list.slice() });
  }
  const depth = maxRank + 1;
  const length = depth * across + Math.max(0, depth - 1) * rankGap;
  const width = padding * 2 + (vertical ? widest : length);
  const height = padding * 2 + (vertical ? length : widest);

  const outEdges = valid.map((e, i) => {
    const s = placed.get(e.from);
    const t = placed.get(e.to);
    return vertical
      ? { from: e.from, to: e.to, sourceX: s.x + nodeWidth / 2, sourceY: s.y + nodeHeight, targetX: t.x + nodeWidth / 2, targetY: t.y, isBackEdge: back.has(i) }
      : { from: e.from, to: e.to, sourceX: s.x + nodeWidth, sourceY: s.y + nodeHeight / 2, targetX: t.x, targetY: t.y + nodeHeight / 2, isBackEdge: back.has(i) };
  });

  return { nodes: ids.map((id) => placed.get(id)), edges: outEdges, ranks: rankBoxes, direction: vertical ? "vertical" : "horizontal", width, height };
}
