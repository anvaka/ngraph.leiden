import { makeGraphAdapter } from './adapter/GraphAdapter.js'

// Universal ad-hoc quality evaluation.
// Inputs:
//  - graph: ngraph.graph instance
//  - membership: Map|Object mapping node id -> community id (string|number)
//  - options: { directed?, quality='modularity'|'cpm', resolution?, cpmMode? }
// Cost: O(n + m) per call (single pass to accumulate degrees + one pass over edges).
// Rationale: Simplicity & universality for external evaluations without relying on
//            internal optimiser partition structure or compaction assumptions.
export function evaluateQuality(graph, membership, options = {}) {
  const directed = !!options.directed;
  const adapter = makeGraphAdapter(graph, { directed });
  const getter = (id) => membership instanceof Map ? membership.get(id) : membership?.[id];

  // Aggregate per community. We keep a Map keyed by raw community id value.
  // Each record stores: strength / strengthOut, strengthIn (directed), internalEdgeWeight (A_ij sum),
  // nodeCount, totalSize.
  const comm = new Map();
  function ensure(cid) {
    let r = comm.get(cid);
    if (!r) {
      r = directed
        ? { strengthOut: 0, strengthIn: 0, internal: 0, nodeCount: 0, size: 0 }
        : { strength: 0, internal: 0, nodeCount: 0, size: 0 };
      comm.set(cid, r);
    }
    return r;
  }

  // Pass 1: nodes -> accumulate degree strengths & counts
  for (let i = 0; i < adapter.n; i++) {
    const id = adapter.nodeIds[i];
    const cid = getter(id);
    if (cid == null) {
      if (options.requireMembership) throw new Error('Missing membership for node: ' + id);
      continue;
    }
    const rec = ensure(cid);
    if (directed) {
      rec.strengthOut += adapter.strengthOut[i];
      rec.strengthIn += adapter.strengthIn[i];
    } else {
      rec.strength += adapter.strengthOut[i]; // strengthOut == degree (weighted) in undirected adapter
    }
    rec.nodeCount += 1;
    rec.size += adapter.size[i] || 0;
  }

  // Pass 2: edges -> accumulate internal adjacency weight.
  // For undirected graphs adapter.outEdges includes both directions for each edge (plus self loops once).
  // We purposely sum all A_ij where i and j are in same community. This double-counts
  // each undirected edge (consistent with optimiser's modularity representation) and
  // counts self-loops once. For directed graphs each edge appears once.
  for (let i = 0; i < adapter.n; i++) {
    const idI = adapter.nodeIds[i];
    const ci = getter(idI);
    if (ci == null) continue;
    const rec = comm.get(ci);
    const list = adapter.outEdges[i];
    for (let k = 0; k < list.length; k++) {
      const { to: j, w } = list[k];
      const cj = getter(adapter.nodeIds[j]);
      if (ci === cj) rec.internal += w;
    }
  }

  const qualityName = (options.quality || 'modularity').toLowerCase();
  if (qualityName === 'cpm') {
    return evaluateCPM(comm, adapter, options);
  }
  return evaluateModularity(comm, adapter, directed);
}

function evaluateModularity(comm, adapter, directed) {
  if (directed) {
    const m = adapter.totalWeight || 1; // sum of weights of directed edges
    let sum = 0;
    for (const rec of comm.values()) {
      // rec.internal already counts each internal directed edge once.
      sum += (rec.internal / m) - (rec.strengthOut * rec.strengthIn) / (m * m);
    }
    return sum;
  } else {
    const m2 = adapter.totalWeight || 1; // 2m (since strengths sum degrees)
    let sum = 0;
    for (const rec of comm.values()) {
      // rec.internal counts each undirected internal edge twice + self loops once.
      const dc = rec.strength;
      sum += (rec.internal / m2) - (dc * dc) / (m2 * m2);
    }
    return sum;
  }
}

function evaluateCPM(comm, adapter, options) {
  const gamma = typeof options.resolution === 'number' ? options.resolution : 1.0;
  const sizeAware = (options.cpmMode || 'unit') === 'size-aware';
  let sum = 0;
  for (const rec of comm.values()) {
    if (sizeAware) {
      const S = rec.size || 0;
      sum += rec.internal - gamma * (S * (S - 1)) / 2;
    } else {
      const n = rec.nodeCount;
      sum += rec.internal - gamma * (n * (n - 1)) / 2;
    }
  }
  return sum;
}
