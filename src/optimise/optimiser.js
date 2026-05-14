import { makeGraphAdapter } from '../adapter/GraphAdapter.js'
import { makePartition } from '../partition/MutablePartition.js'
import createGraph from 'ngraph.graph'
import ngraphRandom from 'ngraph.random'
import { diffModularity, diffModularityDirected } from '../quality/modularity.js'
import { diffCPM } from '../quality/cpm.js'

// Implements the Leiden algorithm from Traag, Waltman, van Eck (2019),
// "From Louvain to Leiden: guaranteeing well-connected communities".
//
// Outer loop: at each level, run MoveNodesFast (queue-based local move), then
// RefinePartition (per-macro stochastic merges with well-connectedness gates),
// then aggregate. The next level's partition is seeded so that refined
// sub-communities from the same macro start in the same community — this is the
// "key Leiden trick" that lets the algorithm both split and merge across levels.
//
// Modularity and CPM are both supported. For modularity the size function used
// by the well-connectedness gates is node strength (k_v) and γ is divided by the
// total weight, matching the rescaling described in the paper's Section IV.

const DEFAULT_MAX_LEVELS = 50
const GAIN_EPSILON = 1e-12
const DEFAULT_THETA = 0.01

// Backward-compatible export name. The original signature called this
// "runLouvainUndirectedModularity" before it was a Leiden implementation.
export function runLouvainUndirectedModularity(graph, optionsInput = {}) {
  return runLeiden(graph, optionsInput)
}

export function runLeiden(graph, optionsInput = {}) {
  const options = normalizeOptions(optionsInput)
  const rngSource = ngraphRandom(options.randomSeed)
  const random = () => rngSource.nextDouble()

  const baseAdapter = makeGraphAdapter(graph, { directed: options.directed, ...optionsInput })
  const origN = baseAdapter.n

  let fixedMask0 = null
  if (options.fixedNodes) {
    const fixed = new Uint8Array(origN)
    const asSet = options.fixedNodes instanceof Set ? options.fixedNodes : new Set(options.fixedNodes)
    for (const id of asSet) {
      const idx = baseAdapter.idToIndex.get(id)
      if (idx != null) fixed[idx] = 1
    }
    fixedMask0 = fixed
  }

  // Maps original (level-0) node index to its current coarse-level node id.
  const originalToCurrent = new Int32Array(origN)
  for (let i = 0; i < origN; i++) originalToCurrent[i] = i

  let currentAdapter = baseAdapter
  // Seed for the next level's partition: array indexed by coarse node id giving
  // the macro id to start in. Null means "singletons".
  let seedAssignment = null
  const levels = []

  for (let level = 0; level < options.maxLevels; level++) {
    const partition = makePartition(currentAdapter)
    partition.graph = currentAdapter

    if (seedAssignment) {
      // Apply seeded partition: each coarse node starts in its macro community.
      // We need contiguous community ids for the partition's aggregate arrays
      // to make sense, but `seedAssignment[c]` already contains macro ids that
      // are 0..(macroCount-1) from the previous level's compaction.
      for (let i = 0; i < currentAdapter.n; i++) {
        partition.nodeCommunity[i] = seedAssignment[i]
      }
    }
    partition.initializeAggregates()

    const fixedMaskHere = level === 0 ? fixedMask0 : null

    moveNodesFast(currentAdapter, partition, options, random, fixedMaskHere)
    renumberCommunities(partition, options.preserveLabels)

    // Terminate when each node is its own community: no further coarsening possible.
    if (partition.communityCount === currentAdapter.n) {
      levels.push({ graph: currentAdapter, partition })
      const fineToCoarse = partition.nodeCommunity
      for (let i = 0; i < originalToCurrent.length; i++) {
        originalToCurrent[i] = fineToCoarse[originalToCurrent[i]]
      }
      break
    }

    // Refinement
    let effectivePartition = partition
    let refinedToMacro = null
    if (options.refine) {
      const refined = refinePartition(currentAdapter, partition, options, random, fixedMaskHere)
      refinedToMacro = refined.refinedToMacro
      effectivePartition = refined.partition
    }

    levels.push({ graph: currentAdapter, partition: effectivePartition })

    const fineToCoarse = effectivePartition.nodeCommunity
    for (let i = 0; i < originalToCurrent.length; i++) {
      originalToCurrent[i] = fineToCoarse[originalToCurrent[i]]
    }

    const coarseGraph = buildCoarseGraph(currentAdapter, effectivePartition)
    currentAdapter = makeGraphAdapter(coarseGraph, { directed: options.directed, ...optionsInput })

    // Seed the next level: coarse node c starts in community refinedToMacro[c].
    // Without refinement, each coarse node is its own macro (singletons), so
    // leave seedAssignment null and let the next level init as singletons.
    seedAssignment = refinedToMacro
  }

  const last = levels[levels.length - 1]
  return {
    graph: last.graph,
    partition: last.partition,
    levels,
    originalToCurrent,
    originalNodeIds: baseAdapter.nodeIds,
  }
}

// Fast local move (paper Algorithm 2, MoveNodesFast). Only nodes whose
// neighbourhood changed since their last visit get re-evaluated.
function moveNodesFast(g, partition, options, rng, fixedMask) {
  const n = g.n
  const queueCap = Math.max(n, 1)
  const queue = new Int32Array(queueCap)
  const inQueue = new Uint8Array(n)

  // Initial fill in random order.
  const order = new Int32Array(n)
  for (let i = 0; i < n; i++) order[i] = i
  shuffleArrayInPlace(order, rng)
  let head = 0
  let tail = 0
  let size = 0
  for (let i = 0; i < n; i++) {
    queue[tail] = order[i]
    tail = (tail + 1) % queueCap
    size++
    inQueue[order[i]] = 1
  }

  const allowNew = options.allowNewCommunity
  const strategyCode = options.candidateStrategyCode

  while (size > 0) {
    const v = queue[head]
    head = (head + 1) % queueCap
    size--
    inQueue[v] = 0

    if (fixedMask && fixedMask[v]) continue

    const candidateCount = partition.accumulateNeighborCommunityEdgeWeights(v)
    let bestC = partition.nodeCommunity[v]
    let bestGain = 0

    if (strategyCode === 1) {
      // 'all' — exhaustive scan over communities; kept for backward compat.
      for (let c = 0; c < partition.communityCount; c++) {
        if (c === partition.nodeCommunity[v]) continue
        if (!passesSizeCap(partition, g, v, c, options.maxCommunitySize)) continue
        const gain = computeQualityGain(partition, v, c, options)
        if (gain > bestGain) { bestGain = gain; bestC = c }
      }
    } else if (strategyCode === 2) {
      // 'random' — random sample from all communities.
      const tries = Math.min(10, Math.max(1, partition.communityCount))
      for (let t = 0; t < tries; t++) {
        const c = (rng() * partition.communityCount) | 0
        if (c === partition.nodeCommunity[v]) continue
        if (!passesSizeCap(partition, g, v, c, options.maxCommunitySize)) continue
        const gain = computeQualityGain(partition, v, c, options)
        if (gain > bestGain) { bestGain = gain; bestC = c }
      }
    } else if (strategyCode === 3) {
      // 'random-neighbor' — random sample from neighbour communities.
      const tries = Math.min(10, Math.max(1, candidateCount))
      for (let t = 0; t < tries; t++) {
        const c = partition.getCandidateCommunityAt((rng() * candidateCount) | 0)
        if (c === partition.nodeCommunity[v]) continue
        if (!passesSizeCap(partition, g, v, c, options.maxCommunitySize)) continue
        const gain = computeQualityGain(partition, v, c, options)
        if (gain > bestGain) { bestGain = gain; bestC = c }
      }
    } else {
      // 'neighbors' — Leiden default: only adjacent communities.
      for (let i = 0; i < candidateCount; i++) {
        const c = partition.getCandidateCommunityAt(i)
        if (!passesSizeCap(partition, g, v, c, options.maxCommunitySize)) continue
        const gain = computeQualityGain(partition, v, c, options)
        if (gain > bestGain) { bestGain = gain; bestC = c }
      }
    }

    if (allowNew) {
      const newCid = partition.communityCount
      if (passesSizeCap(partition, g, v, newCid, options.maxCommunitySize)) {
        const gain = computeQualityGain(partition, v, newCid, options)
        if (gain > bestGain) { bestGain = gain; bestC = newCid }
      }
    }

    if (bestC !== partition.nodeCommunity[v] && bestGain > GAIN_EPSILON) {
      partition.moveNodeToCommunity(v, bestC)
      // Re-enqueue neighbours that are not in v's new community.
      const adj = g.outEdges[v]
      for (let k = 0; k < adj.length; k++) {
        const u = adj[k].to
        if (u === v) continue
        if (partition.nodeCommunity[u] === bestC) continue
        if (inQueue[u]) continue
        queue[tail] = u
        tail = (tail + 1) % queueCap
        size++
        inQueue[u] = 1
      }
    }
  }
}

function passesSizeCap(partition, g, v, c, cap) {
  if (!Number.isFinite(cap)) return true
  return partition.getCommunityTotalSize(c) + g.size[v] <= cap
}

// RefinePartition + per-macro MergeNodesSubset from the paper.
// Returns { partition: refinedPartition, refinedToMacro: Int32Array }
// where refinedToMacro[c] gives the original (basePart) macro id of refined comm c.
function refinePartition(g, basePart, opts, rng, fixedMask) {
  const refined = makePartition(g)
  refined.graph = g
  refined.initializeAggregates()

  const macro = basePart.nodeCommunity
  const macroBuckets = []
  for (let v = 0; v < g.n; v++) {
    const m = macro[v]
    if (!macroBuckets[m]) macroBuckets[m] = []
    macroBuckets[m].push(v)
  }

  // Buffers reused across macros — caller pays O(n) memory once.
  const inS = new Uint8Array(g.n)
  const eVtoS = new Float64Array(g.n)
  const commSize = new Float64Array(g.n)
  const commCutToS = new Float64Array(g.n)

  for (let m = 0; m < macroBuckets.length; m++) {
    const S = macroBuckets[m]
    if (!S || S.length <= 1) continue
    mergeNodesSubset(g, refined, S, opts, rng, fixedMask, inS, eVtoS, commSize, commCutToS)
  }

  // Capture each refined community's macro before compacting (using any member).
  const seen = new Int32Array(refined.communityCount).fill(-1)
  for (let v = 0; v < g.n; v++) {
    const c = refined.nodeCommunity[v]
    if (seen[c] === -1) seen[c] = macro[v]
  }

  renumberCommunities(refined, opts.preserveLabels)

  // Rebuild macro mapping for compacted ids.
  const refinedToMacro = new Int32Array(refined.communityCount).fill(-1)
  for (let v = 0; v < g.n; v++) {
    const c = refined.nodeCommunity[v]
    if (refinedToMacro[c] === -1) refinedToMacro[c] = macro[v]
  }

  return { partition: refined, refinedToMacro }
}

// MergeNodesSubset (paper Algorithm 2) restricted to a single macro community S.
// Implements the two well-connectedness gates and the stochastic exp(ΔH/θ) choice.
function mergeNodesSubset(g, refined, S, opts, rng, fixedMask, inS, eVtoS, commSize, commCutToS) {
  const gamma = opts.resolution
  const theta = opts.theta

  // Size function and γ rescaling per quality. The paper sets ||v|| = k_v and
  // rescales γ by 1/2m for modularity (Section IV); for CPM, ||v|| is the
  // user-supplied node size.
  let sizeOf, gammaEff
  if (opts.quality === 'cpm') {
    sizeOf = (v) => g.size[v]
    gammaEff = gamma
  } else if (g.directed) {
    // No canonical Leiden gates exist for directed modularity; use a reasonable
    // symmetric proxy that still rejects obviously-disconnected subsets.
    sizeOf = (v) => g.strengthOut[v] + g.strengthIn[v]
    gammaEff = gamma / (2 * g.totalWeight)
  } else {
    sizeOf = (v) => g.strengthOut[v]
    gammaEff = gamma / g.totalWeight
  }

  // Mark S, precompute E(v, S\v) for v ∈ S, accumulate total size.
  let totalSize = 0
  for (let i = 0; i < S.length; i++) {
    const v = S[i]
    inS[v] = 1
    totalSize += sizeOf(v)
  }
  for (let i = 0; i < S.length; i++) {
    const v = S[i]
    let sum = 0
    const adj = g.outEdges[v]
    for (let k = 0; k < adj.length; k++) {
      const u = adj[k].to
      if (inS[u]) sum += adj[k].w
    }
    eVtoS[v] = sum
  }

  // Initial singleton sub-community state.
  for (let i = 0; i < S.length; i++) {
    const v = S[i]
    commSize[v] = sizeOf(v)
    commCutToS[v] = eVtoS[v]
  }

  // R: well-connected nodes within S.
  const R = []
  for (let i = 0; i < S.length; i++) {
    const v = S[i]
    const sv = sizeOf(v)
    if (eVtoS[v] >= gammaEff * sv * (totalSize - sv)) R.push(v)
  }
  shuffleArrayInPlace(R, rng)

  // Reusable candidate buffer.
  const candC = []
  const candGain = []
  const candWeight = []

  for (let ri = 0; ri < R.length; ri++) {
    const v = R[ri]
    if (fixedMask && fixedMask[v]) continue
    const currentComm = refined.nodeCommunity[v]
    if (refined.communityNodeCount[currentComm] !== 1) continue

    const candidateCount = refined.accumulateNeighborCommunityEdgeWeights(v)

    candC.length = 0
    candGain.length = 0
    candWeight.length = 0
    let maxGain = 0

    for (let i = 0; i < candidateCount; i++) {
      const c = refined.getCandidateCommunityAt(i)
      if (c === currentComm) continue
      if (!inS[c]) continue
      const sizeC = commSize[c]
      if (commCutToS[c] < gammaEff * sizeC * (totalSize - sizeC)) continue
      const gain = computeQualityGain(refined, v, c, opts)
      if (gain < 0) continue
      candC.push(c)
      candGain.push(gain)
      if (gain > maxGain) maxGain = gain
    }

    if (candC.length === 0) continue

    // Sample with probability ∝ exp(ΔH / θ); subtract maxGain to avoid overflow.
    let totalW = 0
    for (let i = 0; i < candC.length; i++) {
      const w = Math.exp((candGain[i] - maxGain) / theta)
      candWeight.push(w)
      totalW += w
    }
    let r = rng() * totalW
    let chosen = candC[candC.length - 1]
    for (let i = 0; i < candC.length; i++) {
      r -= candWeight[i]
      if (r <= 0) { chosen = candC[i]; break }
    }

    // Update tracked state for chosen and the (now-empty) source comm.
    const wToChosen = refined.getNeighborEdgeWeightToCommunity(chosen)
    commCutToS[chosen] = commCutToS[chosen] + eVtoS[v] - 2 * wToChosen
    commSize[chosen] += sizeOf(v)
    commCutToS[currentComm] = 0
    commSize[currentComm] = 0

    refined.moveNodeToCommunity(v, chosen)
  }

  // Reset shared buffers for the next macro.
  for (let i = 0; i < S.length; i++) {
    const v = S[i]
    inS[v] = 0
    eVtoS[v] = 0
    commSize[v] = 0
    commCutToS[v] = 0
  }
}

function buildCoarseGraph(g, p) {
  const coarse = createGraph()
  for (let c = 0; c < p.communityCount; c++) {
    coarse.addNode(c, { size: p.communityTotalSize[c] })
  }
  // Pack (cu, cv) into a single integer key. Safe while q² ≤ 2⁵³ (q up to ~9e7).
  const q = p.communityCount
  const acc = new Map()
  if (g.directed) {
    // Directed edges appear once; copy as-is.
    for (let i = 0; i < g.n; i++) {
      const cu = p.nodeCommunity[i]
      const list = g.outEdges[i]
      for (let k = 0; k < list.length; k++) {
        const cv = p.nodeCommunity[list[k].to]
        const key = cu * q + cv
        acc.set(key, (acc.get(key) || 0) + list[k].w)
      }
    }
    // Directed self-loops live on g.selfLoop, not in outEdges.
    for (let i = 0; i < g.n; i++) {
      if (!g.selfLoop[i]) continue
      const cu = p.nodeCommunity[i]
      const key = cu * q + cu
      acc.set(key, (acc.get(key) || 0) + g.selfLoop[i])
    }
  } else {
    // Undirected: count each edge ONCE so the coarse self-loop weight equals the
    // base community's L_once (non-self internal + self-loops). This is the key
    // invariant that lets modularity and CPM survive coarsening.
    for (let i = 0; i < g.n; i++) {
      const cu = p.nodeCommunity[i]
      const list = g.outEdges[i]
      for (let k = 0; k < list.length; k++) {
        const j = list[k].to
        if (j <= i) continue
        const cv = p.nodeCommunity[j]
        const key = cu * q + cv
        acc.set(key, (acc.get(key) || 0) + list[k].w)
      }
    }
    // Self-loops fold into the coarse self-loop of their community.
    for (let i = 0; i < g.n; i++) {
      if (!g.selfLoop[i]) continue
      const cu = p.nodeCommunity[i]
      const key = cu * q + cu
      acc.set(key, (acc.get(key) || 0) + g.selfLoop[i])
    }
  }
  for (const [key, w] of acc.entries()) {
    const cu = (key / q) | 0
    const cv = key - cu * q
    coarse.addLink(cu, cv, { weight: w })
  }
  return coarse
}

function computeQualityGain(partition, v, c, opts) {
  const g = partition.graph
  if (opts.quality === 'cpm') return diffCPM(partition, g, v, c, opts.resolution)
  if (opts.directed) return diffModularityDirected(partition, g, v, c)
  return diffModularity(partition, g, v, c)
}

function shuffleArrayInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t
  }
  return arr
}

function resolveCandidateStrategy(options) {
  const val = options.candidateStrategy
  if (typeof val !== 'string') return 0
  switch (val) {
    case 'neighbors': return 0
    case 'all': return 1
    case 'random': return 2
    case 'random-neighbor': return 3
    default: return 0
  }
}

function normalizeOptions(options = {}) {
  const directed = !!options.directed
  const randomSeed = Number.isFinite(options.randomSeed) ? options.randomSeed : 42
  const maxLevels = Number.isFinite(options.maxLevels) ? options.maxLevels : DEFAULT_MAX_LEVELS
  const allowNewCommunity = !!options.allowNewCommunity
  const candidateStrategyCode = resolveCandidateStrategy(options)
  const quality = (options.quality || 'modularity').toLowerCase()
  const resolution = typeof options.resolution === 'number' ? options.resolution : 1.0
  const refine = options.refine !== false
  const preserveLabels = options.preserveLabels
  const maxCommunitySize = Number.isFinite(options.maxCommunitySize) ? options.maxCommunitySize : Infinity
  const theta = Number.isFinite(options.theta) ? options.theta : DEFAULT_THETA
  return {
    directed,
    randomSeed,
    maxLevels,
    allowNewCommunity,
    candidateStrategyCode,
    quality,
    resolution,
    refine,
    preserveLabels,
    maxCommunitySize,
    theta,
    fixedNodes: options.fixedNodes,
  }
}

function renumberCommunities(partition, preserveLabels) {
  if (preserveLabels && preserveLabels instanceof Map) {
    partition.compactCommunityIds({ preserveMap: preserveLabels })
  } else if (preserveLabels === true) {
    partition.compactCommunityIds({ keepOldOrder: true })
  } else {
    partition.compactCommunityIds()
  }
}
