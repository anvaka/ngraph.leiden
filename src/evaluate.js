import { makeGraphAdapter } from './adapter/GraphAdapter.js'
import { makePartition } from './partition/MutablePartition.js'
import { qualityModularity } from './quality/modularity.js'
import { qualityCPM, qualityCPMSizeAware } from './quality/cpm.js'

export function evaluateQuality(graph, membership, options = {}) {
  // membership: Map<string, number|string> | { [id: string]: number|string }
  const directed = !!options.directed;
  const adapter = makeGraphAdapter(graph, { directed, ...options });
  const part = makePartition(adapter);
  // attach graph reference for internal recomputations
  part.graph = adapter;
  const idToIndex = adapter.idToIndex;
  // Assign provided communities where available; others remain singleton by default
  const getter = (id) => membership instanceof Map ? membership.get(id) : membership?.[id];
  for (let i = 0; i < adapter.nodeIds.length; i++) {
    const id = adapter.nodeIds[i];
    const val = getter(id);
    if (val == null) {
      if (options.requireMembership) throw new Error('Missing membership for node: ' + id);
      continue; // keep singleton community id = i
    }
    const c = normalizeCommunity(val);
    part.nodeCommunity[idToIndex.get(id)] = c;
  }
  // Compact to contiguous ids and rebuild aggregates based on adapter
  part.compactCommunityIds();
  // Use requested quality
  const q = (options.quality || 'modularity').toLowerCase();
  if (q === 'cpm') {
    const gamma = typeof options.resolution === 'number' ? options.resolution : 1.0;
    if ((options.cpmMode || 'unit') === 'size-aware') return qualityCPMSizeAware(part, adapter, gamma);
    return qualityCPM(part, adapter, gamma);
  }
  return qualityModularity(part, adapter);
}

function normalizeCommunity(v) {
  if (typeof v === 'number') return (v|0);
  if (typeof v === 'string') {
    // Try parseInt, else hash-like stable mapping by string's own index via Map outside
    const n = Number(v);
    if (Number.isFinite(n)) return (n|0);
    // For non-numeric strings, a stable mapping should be done by caller. Here, fallback to
    // a simple deterministic hash to get an int id.
    return stringHash(v);
  }
  return 0;
}

function stringHash(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0; // ensure non-negative
}
