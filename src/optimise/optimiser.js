import { makeGraphAdapter } from '../adapter/GraphAdapter.js'
import { makePartition } from '../partition/MutablePartition.js'
import createGraph from 'ngraph.graph'
import ngraphRandom from 'ngraph.random'
import { diffModularity, diffModularityDirected } from '../quality/modularity.js'
import { diffCPM } from '../quality/cpm.js'

// Constants used in hot paths to avoid magic numbers/strings
const DEFAULT_MAX_LEVELS = 50;
const DEFAULT_MAX_LOCAL_PASSES = 20;
const GAIN_EPSILON = 1e-12;

/*
Candidate selection policy for the local move phase.

This dictates which target communities we consider when deciding where to move
a node. Different policies trade off search breadth vs. speed:
  - Neighbors: only communities adjacent via edges (typical Louvain default; fast).
  - All: every existing community (exhaustive; slow on large graphs).
  - RandomAny: a small random sample from all communities (broad but bounded cost).
  - RandomNeighbor: a small random sample from neighbor communities (local but cheap).

We resolve the chosen policy to a small integer once per run so the inner loops
can do cheap comparisons without string checks or function dispatch.
*/
const CandidateStrategy = {
  Neighbors: 0, // neighbor communities only
  All: 1,       // all communities
  RandomAny: 2, // random among all
  RandomNeighbor: 3 // random among neighbor communities
};

export function runLouvainUndirectedModularity(graph, optionsInput = {}) {
  const options = normalizeOptions(optionsInput);
  // Outer loop with coarsening
  let currentGraph = graph;
  const levels = [];
  const rngSource = ngraphRandom(options.randomSeed);
  const random = () => rngSource.nextDouble();
  // Prepare original mapping
  const baseGraphAdapter = makeGraphAdapter(currentGraph, { directed: options.directed, ...optionsInput });
  const origN = baseGraphAdapter.n;
  const originalToCurrent = new Int32Array(origN);
  for (let i = 0; i < origN; i++) originalToCurrent[i] = i;

  // Fixed nodes mask on the original (finest) level
  let fixedNodeMask = null;
  if (options.fixedNodes) {
    const fixed = new Uint8Array(origN);
    const asSet = options.fixedNodes instanceof Set ? options.fixedNodes : new Set(options.fixedNodes);
    for (const id of asSet) {
      const idx = baseGraphAdapter.idToIndex.get(id);
      if (idx != null) fixed[idx] = 1;
    }
    fixedNodeMask = fixed;
  }

  for (let level = 0; level < options.maxLevels; level++) {
    const graphAdapter = level === 0 ? baseGraphAdapter : makeGraphAdapter(currentGraph, { directed: options.directed, ...optionsInput });
    const partition = makePartition(graphAdapter);
    // attach graph reference for strategy helpers
    partition.graph = graphAdapter;
    partition.initializeAggregates();

    const order = new Int32Array(graphAdapter.n);
    for (let i = 0; i < graphAdapter.n; i++) order[i] = i;

    let improved = true;
    let localPasses = 0;
    const strategyCode = options.candidateStrategyCode;
    while (improved) {
      improved = false;
      localPasses++;
      shuffleArrayInPlace(order, random);
      for (let idx = 0; idx < order.length; idx++) {
        const nodeIndex = order[idx];
        // Skip fixed nodes at the finest level
        if (level === 0 && fixedNodeMask && fixedNodeMask[nodeIndex]) continue;
        const candidateCount = partition.accumulateNeighborCommunityEdgeWeights(nodeIndex);
        let bestCommunityId = partition.nodeCommunity[nodeIndex];
        let bestGain = 0;
        const maxCommunitySize = options.maxCommunitySize;
        // iterate candidates per strategy
        if (strategyCode === CandidateStrategy.All) {
          for (let communityId = 0; communityId < partition.communityCount; communityId++) {
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (maxCommunitySize < Infinity && (partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] > maxCommunitySize)) continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) { bestGain = gain; bestCommunityId = communityId; }
          }
        } else if (strategyCode === CandidateStrategy.RandomAny) {
          const tries = Math.min(10, Math.max(1, partition.communityCount));
          for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
            const communityId = (random() * partition.communityCount) | 0;
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (maxCommunitySize < Infinity && (partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] > maxCommunitySize)) continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) { bestGain = gain; bestCommunityId = communityId; }
          }
        } else if (strategyCode === CandidateStrategy.RandomNeighbor) {
          const tries = Math.min(10, Math.max(1, candidateCount));
          for (let trialIndex = 0; trialIndex < tries; trialIndex++) {
            const communityId = partition.getCandidateCommunityAt((random() * candidateCount) | 0);
            if (communityId === partition.nodeCommunity[nodeIndex]) continue;
            if (maxCommunitySize < Infinity && (partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex] > maxCommunitySize)) continue;
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) { bestGain = gain; bestCommunityId = communityId; }
          }
        } else {
          for (let trialIndex = 0; trialIndex < candidateCount; trialIndex++) {
            const communityId = partition.getCandidateCommunityAt(trialIndex);
            if (maxCommunitySize < Infinity) {
              const nextSize = partition.getCommunityTotalSize(communityId) + graphAdapter.size[nodeIndex];
              if (nextSize > maxCommunitySize) continue;
            }
            const gain = computeQualityGain(partition, nodeIndex, communityId, options);
            if (gain > bestGain) { bestGain = gain; bestCommunityId = communityId; }
          }
        }
        // Optionally consider moving to a fresh singleton community id = current q
        if (options.allowNewCommunity) {
          const newCommunityId = partition.communityCount; // new community candidate
          const gain = computeQualityGain(partition, nodeIndex, newCommunityId, options);
          if (gain > bestGain) { bestGain = gain; bestCommunityId = newCommunityId; }
        }
        if (bestCommunityId !== partition.nodeCommunity[nodeIndex] && bestGain > GAIN_EPSILON) {
          partition.moveNodeToCommunity(nodeIndex, bestCommunityId);
          improved = true;
        }
      }
      if (localPasses > options.maxLocalPasses) break;
    }

    // Renumber communities with optional preservation map or policy
    renumberCommunities(partition, options.preserveLabels);

    // Optional Leiden refinement: split communities by constrained improvement inside each coarse community
    let effectivePartition = partition;
    if (options.refine) {
      const refined = refineWithinCoarseCommunities(graphAdapter, partition, random, options, level === 0 ? fixedNodeMask : null);
      renumberCommunities(refined, options.preserveLabels);
      effectivePartition = refined;
    }

    levels.push({ graph: graphAdapter, partition: effectivePartition });
    // Update mapping from original nodes into coarse nodes of next level
    const fineToCoarse = effectivePartition.nodeCommunity;
    for (let i = 0; i < originalToCurrent.length; i++) {
      originalToCurrent[i] = fineToCoarse[originalToCurrent[i]];
    }

    // Coarsen; stop if no aggregation
    if (partition.communityCount === graphAdapter.n) break;
    currentGraph = buildCoarseGraph(graphAdapter, effectivePartition);
  }

  // Use the finest level membership (levels[levels.length - 1])
  const last = levels[levels.length - 1];
  return { graph: last.graph, partition: last.partition, levels, originalToCurrent, originalNodeIds: baseGraphAdapter.nodeIds };
}

function buildCoarseGraph(g, p) {
  // Build a coarse graph using ngraph.graph compatible API
  const coarse = createGraph();
  // Add coarse nodes
  for (let c = 0; c < p.communityCount; c++) {
    coarse.addNode(c, { size: p.communityTotalSize[c] });
  }
  // Accumulate inter-community weights and self-loops using a map per source
  const acc = new Map(); // key: `${cu}:${cv}` -> weight
  for (let i = 0; i < g.n; i++) {
    const cu = p.nodeCommunity[i];
    const list = g.outEdges[i];
    for (let k = 0; k < list.length; k++) {
      const j = list[k].to; const w = list[k].w;
      const cv = p.nodeCommunity[j];
      const key = cu + ':' + cv;
      acc.set(key, (acc.get(key) || 0) + w);
    }
  }
  // Emit links; avoid duplicating undirected pairs (we kept original edges; for undirected graphs
  // this already has both directions if input had both). We'll add directed edges as-is.
  for (const [key, w] of acc.entries()) {
    const [cuStr, cvStr] = key.split(':');
    const cu = +cuStr, cv = +cvStr;
    coarse.addLink(cu, cv, { weight: w });
  }
  return coarse;
}

// Leiden-style refinement: moves are constrained within coarse communities
function refineWithinCoarseCommunities(g, basePart, rng, opts, fixedMask0) {
  const p = makePartition(g);
  // initialize to singletons
  // membership is already initialized to i in makePartition(); just rebuild admin
  p.initializeAggregates();
  p.graph = g;
  const macro = basePart.nodeCommunity; // coarse community per node
  // Map comm -> macro id; initially each comm i has macro[i] = macro[i]
  // We'll maintain an array of macro ids per community; size grows with q
  let commMacro = new Int32Array(p.communityCount);
  for (let i = 0; i < p.communityCount; i++) commMacro[i] = macro[i];

  const order = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) order[i] = i;
  let improved = true;
  let passes = 0;
  while (improved) {
    improved = false;
    passes++;
    shuffleArrayInPlace(order, rng);
    for (let idx = 0; idx < order.length; idx++) {
      const v = order[idx];
      // Skip fixed nodes at the finest level only (refinement runs at level 0 with original graph)
      if (fixedMask0 && fixedMask0[v]) continue;
      const macroV = macro[v];
      const touchedCount = p.accumulateNeighborCommunityEdgeWeights(v);
      let bestC = p.nodeCommunity[v];
      let bestGain = 0;
      const maxSize = (Number.isFinite(opts.maxCommunitySize) ? opts.maxCommunitySize : Infinity);
      for (let t = 0; t < touchedCount; t++) {
        const c = p.getCandidateCommunityAt(t);
        if (commMacro[c] !== macroV) continue; // constrain within macro
        if (maxSize < Infinity) {
          const nextSize = p.getCommunityTotalSize(c) + g.size[v];
          if (nextSize > maxSize) continue;
        }
        const gain = computeQualityGain(p, v, c, opts);
        if (gain > bestGain) { bestGain = gain; bestC = c; }
      }
      if (bestC !== p.nodeCommunity[v] && bestGain > GAIN_EPSILON) {
        p.moveNodeToCommunity(v, bestC);
        improved = true;
      }
    }
    if (passes > (opts.maxLocalPasses || DEFAULT_MAX_LOCAL_PASSES)) break;
  }
  // After moves, reassign commMacro for new community ids if needed on renumber
  // We'll recompute commMacro after renumber if required by callers; not used further here
  return p;
}

function computeQualityGain(partition, v, c, opts) {
  const quality = (opts.quality || 'modularity').toLowerCase();
  if (quality === 'cpm') {
    const gamma = typeof opts.resolution === 'number' ? opts.resolution : 1.0;
    return diffCPM(partition, partition.graph || {}, v, c, gamma) || partition.deltaCPM?.(v, c, gamma) || 0;
  }
  if (opts.directed) return diffModularityDirected(partition, partition.graph || {}, v, c) || partition.deltaModularityDirected?.(v, c) || 0;
  return diffModularity(partition, partition.graph || {}, v, c) || partition.deltaModularityUndirected?.(v, c) || 0;
}


function shuffleArrayInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

// Resolve candidate strategy once per run 
function resolveCandidateStrategy(options) {
  const val = options.candidateStrategy;
  if (typeof val !== 'string') return CandidateStrategy.Neighbors;
  switch (val) {
    case 'neighbors': return CandidateStrategy.Neighbors;
    case 'all': return CandidateStrategy.All;
    case 'random': return CandidateStrategy.RandomAny;
    case 'random-neighbor': return CandidateStrategy.RandomNeighbor;
    default: return CandidateStrategy.Neighbors;
  }
}

function normalizeOptions(options = {}) {
  // Resolve once to primitive values for hot paths
  const directed = !!options.directed;
  const randomSeed = Number.isFinite(options.randomSeed) ? options.randomSeed : 42;
  const maxLevels = Number.isFinite(options.maxLevels) ? options.maxLevels : DEFAULT_MAX_LEVELS;
  const maxLocalPasses = Number.isFinite(options.maxLocalPasses) ? options.maxLocalPasses : DEFAULT_MAX_LOCAL_PASSES;
  // Whether moves may create a fresh singleton community
  const allowNewCommunity = !!options.allowNewCommunity;
  const candidateStrategyCode = resolveCandidateStrategy(options);
  const quality = (options.quality || 'modularity').toLowerCase();
  const resolution = typeof options.resolution === 'number' ? options.resolution : 1.0;
  const refine = options.refine !== false;
  const preserveLabels = options.preserveLabels;
  const maxCommunitySize = Number.isFinite(options.maxCommunitySize) ? options.maxCommunitySize : Infinity;
  return {
    directed,
    randomSeed,
    maxLevels,
    maxLocalPasses,
    allowNewCommunity,
    candidateStrategyCode,
    quality,
    resolution,
    refine,
    preserveLabels,
    maxCommunitySize,
    fixedNodes: options.fixedNodes
  };
}

function renumberCommunities(partition, preserveLabels) {
  if (preserveLabels && preserveLabels instanceof Map) {
    partition.compactCommunityIds({ preserveMap: preserveLabels });
  } else if (preserveLabels === true) {
    partition.compactCommunityIds({ keepOldOrder: true });
  } else {
    partition.compactCommunityIds();
  }
}
