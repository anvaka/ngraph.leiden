// Lightweight adapter around ngraph.graph with precomputed strengths and caches

export function makeGraphAdapter(graph, opts = {}) {
  const linkWeight = opts.linkWeight || ((link) => (link.data && typeof link.data.weight === 'number') ? link.data.weight : 1);
  const nodeSize = opts.nodeSize || ((node) => (node.data && typeof node.data.size === 'number') ? node.data.size : 1);
  const directed = !!opts.directed; // Simple toggle for now
  const baseNodeIds = opts.baseNodeIds;

  // Build dense node index mapping
  const nodeIds = [];
  const idToIndex = new Map();
  if (Array.isArray(baseNodeIds) && baseNodeIds.length > 0) {
    // Use provided order and verify nodes exist
    for (let i = 0; i < baseNodeIds.length; i++) {
      const id = baseNodeIds[i];
      const node = graph.getNode ? graph.getNode(id) : null;
      if (!node) throw new Error('Multilayer graphs must share identical node ids. Missing: ' + id);
      idToIndex.set(id, i);
      nodeIds.push(id);
    }
  } else {
    graph.forEachNode(n => {
      idToIndex.set(n.id, nodeIds.length);
      nodeIds.push(n.id);
    });
  }
  const n = nodeIds.length;

  // Storage
  const size = new Float64Array(n);
  const selfLoop = new Float64Array(n);
  const strengthOut = new Float64Array(n);
  const strengthIn = new Float64Array(n);

  // Edge list by source for fast iteration
  const outEdges = new Array(n);
  const inEdges = new Array(n);
  for (let i = 0; i < n; i++) { outEdges[i] = []; inEdges[i] = []; }

  // Populate from graph
  if (directed) {
    // Keep edges as-is for directed graphs
    graph.forEachLink(l => {
      const from = idToIndex.get(l.fromId);
      const to = idToIndex.get(l.toId);
      if (from == null || to == null) return; // defensive
      const w = +linkWeight(l) || 0;
      if (from === to) {
        selfLoop[from] += w;
      }
      outEdges[from].push({ to, w });
      inEdges[to].push({ from, w });
      strengthOut[from] += w;
      strengthIn[to] += w;
    });
  } else {
    // Undirected mode: symmetrize edges so callers don't need to add reciprocal links.
    // We aggregate weights per unordered pair (i,j) and, if both directions exist,
    // we average them to avoid double-counting compared to users who added reciprocals.
    const pairAgg = new Map(); // key: "i:j" with i<j -> { sum: number, seenAB: boolean, seenBA: boolean }

    graph.forEachLink(l => {
      const a = idToIndex.get(l.fromId);
      const b = idToIndex.get(l.toId);
      if (a == null || b == null) return; // defensive
      const w = +linkWeight(l) || 0;
      if (a === b) {
        // self-loops are kept as-is; counted once in strength and in selfLoop
        selfLoop[a] += w;
        return;
      }
      const i = a < b ? a : b;
      const j = a < b ? b : a;
      const key = i + ':' + j;
      let rec = pairAgg.get(key);
      if (!rec) { rec = { sum: 0, seenAB: 0, seenBA: 0 }; pairAgg.set(key, rec); }
      rec.sum += w;
      if (a === i) rec.seenAB = 1; else rec.seenBA = 1;
    });

    // Emit symmetric edges with averaged weight when both directions present
    for (const [key, rec] of pairAgg.entries()) {
      const [iStr, jStr] = key.split(':');
      const i = +iStr, j = +jStr;
      const dirCount = (rec.seenAB ? 1 : 0) + (rec.seenBA ? 1 : 0);
      const w = dirCount > 0 ? rec.sum / dirCount : 0;
      if (w === 0) continue;
      outEdges[i].push({ to: j, w });
      outEdges[j].push({ to: i, w });
      inEdges[i].push({ from: j, w });
      inEdges[j].push({ from: i, w });
      strengthOut[i] += w; strengthOut[j] += w;
      strengthIn[i] += w; strengthIn[j] += w;
    }

    // Add self-loops into adjacency and strengths once (consistent with directed path)
    for (let v = 0; v < n; v++) {
      const w = selfLoop[v];
      if (w !== 0) {
        outEdges[v].push({ to: v, w });
        inEdges[v].push({ from: v, w });
        strengthOut[v] += w;
        strengthIn[v] += w;
      }
    }
  }

  // Node sizes
  graph.forEachNode(nNode => {
    const i = idToIndex.get(nNode.id);
    size[i] = +nodeSize(nNode) || 0;
  });

  // Totals
  const totalWeight = strengthOut.reduce((a, b) => a + b, 0);

  // Neighbour cache helpers
  function forEachNeighbor(i, cb) {
    const list = outEdges[i];
    for (let k = 0; k < list.length; k++) cb(list[k].to, list[k].w);
  }

  return {
    n,
    nodeIds,
    idToIndex,
    size,
    selfLoop,
    strengthOut,
    strengthIn,
    outEdges,
  inEdges,
    directed,
    totalWeight,
    forEachNeighbor,
  };
}
