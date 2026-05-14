import { makeGraphAdapter } from './adapter/GraphAdapter.js'

// Universal ad-hoc quality evaluation.
// Inputs:
//  - graph: ngraph.graph instance
//  - membership: Map|Object mapping node id -> community id (string|number)
//  - options: { directed?, quality='modularity'|'cpm', resolution?, cpmMode? }
// Cost: O(n + m) per call (single pass to accumulate degrees + one pass over edges).
//
// rec.internal counts each undirected edge once and each self-loop once — matching the
// optimiser's partition bookkeeping and the paper's E(C,C). The modularity formula
// applies the 2× factor on the L term to keep parity with classical Newman modularity.
export function evaluateQuality(graph, membership, options = {}) {
  const directed = !!options.directed;
  const adapter = makeGraphAdapter(graph, { directed });
  const getter = (id) => membership instanceof Map ? membership.get(id) : membership?.[id];

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

  // Pass 1: nodes -> accumulate degree strengths, counts, and self-loop weight as internal.
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
      rec.strength += adapter.strengthOut[i];
    }
    rec.nodeCount += 1;
    rec.size += adapter.size[i] || 0;
    // Self-loops (excluded from adapter.outEdges) contribute once to internal weight.
    if (adapter.selfLoop[i]) rec.internal += adapter.selfLoop[i];
  }

  // Pass 2: edges -> add internal weight using the "counted once" convention.
  // For undirected: adapter emits both i→j and j→i with equal weight, so we add w/2 for
  // each direction to land at "each undirected edge once". For directed: each edge appears
  // once, so add w directly.
  if (directed) {
    for (let i = 0; i < adapter.n; i++) {
      const ci = getter(adapter.nodeIds[i]);
      if (ci == null) continue;
      const rec = comm.get(ci);
      const list = adapter.outEdges[i];
      for (let k = 0; k < list.length; k++) {
        const { to: j, w } = list[k];
        const cj = getter(adapter.nodeIds[j]);
        if (ci === cj) rec.internal += w;
      }
    }
  } else {
    for (let i = 0; i < adapter.n; i++) {
      const ci = getter(adapter.nodeIds[i]);
      if (ci == null) continue;
      const rec = comm.get(ci);
      const list = adapter.outEdges[i];
      for (let k = 0; k < list.length; k++) {
        const { to: j, w } = list[k];
        const cj = getter(adapter.nodeIds[j]);
        if (ci === cj) rec.internal += w / 2;
      }
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
    const m = adapter.totalWeight || 1;
    let sum = 0;
    for (const rec of comm.values()) {
      sum += (rec.internal / m) - (rec.strengthOut * rec.strengthIn) / (m * m);
    }
    return sum;
  } else {
    const m2 = adapter.totalWeight || 1;
    let sum = 0;
    for (const rec of comm.values()) {
      const dc = rec.strength;
      // rec.internal is L_c counted once. Classical Newman modularity needs 2L_c/m2.
      sum += (2 * rec.internal / m2) - (dc * dc) / (m2 * m2);
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
