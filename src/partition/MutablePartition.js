// Mutable community assignment with per-community aggregates.
// WHY: Optimiser moves nodes between communities and needs fast ΔQ (quality) updates.
//      This structure keeps per-community totals and per-move scratch accumulators so
//      we can compute modularity/CPM gains in O(neighborhood) time without rescanning
//      the whole graph after each move.
// HOW: Maintains arrays for community sizes, node counts, internal edge weights and
//      strengths (undirected: totalStrength; directed: totalOutStrength/totalInStrength).
//      For each node under consideration, it accumulates edge weights to neighboring
//      communities into scratch buffers and evaluates ΔQ for candidate communities.
//      Supports undirected and directed modularity and CPM.

export function makePartition(graph) {
  const n = graph.n;
  // initial mapping: each node in its own community
  const nodeCommunity = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeCommunity[i] = i;
  let communityCount = n; // communities are 0..communityCount-1 initially

  // per-community aggregates
  let communityTotalSize = new Float64Array(communityCount);
  let communityNodeCount = new Int32Array(communityCount);
  let communityInternalEdgeWeight = new Float64Array(communityCount); // edges fully inside community
  let communityTotalStrength = new Float64Array(communityCount); // undirected: sum of strengths
  let communityTotalOutStrength = new Float64Array(communityCount); // directed: Σ k_out
  let communityTotalInStrength = new Float64Array(communityCount);  // directed: Σ k_in

  // scratch buffers for neighbor community accumulation
  let candidateCommunities = new Int32Array(n);
  let candidateCommunityCount = 0;
  let neighborEdgeWeightToCommunity = new Float64Array(n); // undirected/outgoing weight to community
  let outEdgeWeightToCommunity = new Float64Array(n); // directed: v->C sum
  let inEdgeWeightFromCommunity = new Float64Array(n);  // directed: C->v sum
  let isCandidateCommunity = new Uint8Array(n);

  function ensureCommCapacity(newCount) {
    if (newCount <= communityTotalSize.length) return;
    const growTo = Math.max(newCount, Math.ceil(communityTotalSize.length * 1.5));
    communityTotalSize = growFloat(communityTotalSize, growTo);
    communityNodeCount = growInt(communityNodeCount, growTo);
    communityInternalEdgeWeight = growFloat(communityInternalEdgeWeight, growTo);
    communityTotalStrength = growFloat(communityTotalStrength, growTo);
    communityTotalOutStrength = growFloat(communityTotalOutStrength, growTo);
    communityTotalInStrength = growFloat(communityTotalInStrength, growTo);
  }

  function initializeAggregates() {
    communityTotalSize.fill(0);
    communityNodeCount.fill(0);
    communityInternalEdgeWeight.fill(0);
    communityTotalStrength.fill(0);
    communityTotalOutStrength.fill(0);
    communityTotalInStrength.fill(0);
    for (let i = 0; i < n; i++) {
      const c = nodeCommunity[i];
      communityTotalSize[c] += graph.size[i];
      communityNodeCount[c] += 1;
      if (graph.directed) {
        communityTotalOutStrength[c] += graph.strengthOut[i];
        communityTotalInStrength[c] += graph.strengthIn[i];
      } else {
        communityTotalStrength[c] += graph.strengthOut[i];
      }
      // self-loop contributes to internal
      if (graph.selfLoop[i] !== 0) communityInternalEdgeWeight[c] += graph.selfLoop[i];
    }
    // accumulate internal weights from edges
    if (graph.directed) {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const neighbors = graph.outEdges[i];
        for (let k = 0; k < neighbors.length; k++) {
          const { to: j, w } = neighbors[k];
          if (ci === nodeCommunity[j]) communityInternalEdgeWeight[ci] += w;
        }
      }
    } else {
      // avoid double counting by only i -> j where i < j
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const neighbors = graph.outEdges[i];
        for (let k = 0; k < neighbors.length; k++) {
          const { to: j, w } = neighbors[k];
          if (j <= i) continue;
          if (ci === nodeCommunity[j]) communityInternalEdgeWeight[ci] += w;
        }
      }
    }
  }

  function resetScratch() {
    for (let i = 0; i < candidateCommunityCount; i++) {
      const c = candidateCommunities[i];
      isCandidateCommunity[c] = 0;
      neighborEdgeWeightToCommunity[c] = 0;
      outEdgeWeightToCommunity[c] = 0;
      inEdgeWeightFromCommunity[c] = 0;
    }
    candidateCommunityCount = 0;
  }

  function touch(c) {
    if (isCandidateCommunity[c]) return;
    isCandidateCommunity[c] = 1;
    candidateCommunities[candidateCommunityCount++] = c;
  }

  function accumulateNeighborCommunityEdgeWeights(v) {
    resetScratch();
    const ci = nodeCommunity[v];
    // include staying in same community
    touch(ci);
    // accumulate over neighbors
    if (graph.directed) {
      const outL = graph.outEdges[v];
      for (let k = 0; k < outL.length; k++) {
        const j = outL[k].to; const w = outL[k].w;
        const cj = nodeCommunity[j];
        touch(cj);
        outEdgeWeightToCommunity[cj] += w;
      }
      const inL = graph.inEdges[v];
      for (let k = 0; k < inL.length; k++) {
        const i2 = inL[k].from; const w = inL[k].w;
        const ci2 = nodeCommunity[i2];
        touch(ci2);
        inEdgeWeightFromCommunity[ci2] += w;
      }
    } else {
      const list = graph.outEdges[v];
      for (let k = 0; k < list.length; k++) {
        const j = list[k].to; const w = list[k].w;
        const cj = nodeCommunity[j];
        touch(cj);
        neighborEdgeWeightToCommunity[cj] += w;
      }
    }
    return candidateCommunityCount;
  }

  // Quality support: undirected modularity
  const twoMUndirected = graph.totalWeight; // sum of strengths (2m for undirected)
  function deltaModularityUndirected(v, newC) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    const strengthV = graph.strengthOut[v];
    const weightToNew = (newC < neighborEdgeWeightToCommunity.length ? (neighborEdgeWeightToCommunity[newC] || 0) : 0); // weight from v to newC
    const weightToOld = neighborEdgeWeightToCommunity[oldC] || 0; // weight from v to oldC
    const totalStrengthNew = newC < communityTotalStrength.length ? communityTotalStrength[newC] : 0;
    const totalStrengthOld = communityTotalStrength[oldC];

    // Modularity gain formula (Blondel 2008), adjusted for removal/addition
    const gain_remove = - (weightToOld / twoMUndirected - (strengthV * totalStrengthOld) / (twoMUndirected * twoMUndirected));
    const gain_add = (weightToNew / twoMUndirected - (strengthV * totalStrengthNew) / (twoMUndirected * twoMUndirected));
    return gain_remove + gain_add;
  }
  // Directed modularity (Leicht-Newman). Here m = totalWeight (sum of all edges' weights)
  function deltaModularityDirected(v, newC) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    const totalEdgeWeight = graph.totalWeight;
    const strengthOutV = graph.strengthOut[v];
    const strengthInV = graph.strengthIn[v];
    const inFromNew = (newC < inEdgeWeightFromCommunity.length ? (inEdgeWeightFromCommunity[newC] || 0) : 0);
    const outToNew = (newC < outEdgeWeightToCommunity.length ? (outEdgeWeightToCommunity[newC] || 0) : 0);
    const inFromOld = inEdgeWeightFromCommunity[oldC] || 0;
    const outToOld = outEdgeWeightToCommunity[oldC] || 0;
    const totalInStrengthNew = (newC < communityTotalInStrength.length ? communityTotalInStrength[newC] : 0);
    const totalOutStrengthNew = (newC < communityTotalOutStrength.length ? communityTotalOutStrength[newC] : 0);
    const totalInStrengthOld = communityTotalInStrength[oldC];
    const totalOutStrengthOld = communityTotalOutStrength[oldC];
    const deltaInternal = (inFromNew + outToNew - inFromOld - outToOld) / totalEdgeWeight;
    const deltaExpected = (strengthOutV * (totalInStrengthNew - totalInStrengthOld) + strengthInV * (totalOutStrengthNew - totalOutStrengthOld)) / (totalEdgeWeight * totalEdgeWeight);
    return deltaInternal - deltaExpected;
  }

  // CPM (Constant Potts Model) diff for undirected case (unit-size correct; sizes generalized via s_v)
  function deltaCPM(v, newC, gamma = 1.0) {
    const oldC = nodeCommunity[v];
    if (newC === oldC) return 0;
    const weightToOld = neighborEdgeWeightToCommunity[oldC] || 0;
    const weightToNew = (newC < neighborEdgeWeightToCommunity.length ? (neighborEdgeWeightToCommunity[newC] || 0) : 0);
    const nodeSize = graph.size[v] || 1;
    const sizeOld = communityTotalSize[oldC] || 0;
    const sizeNew = (newC < communityTotalSize.length ? communityTotalSize[newC] : 0);
    // ΔQ_internal = (w_new - w_old)
    // ΔQ_penalty = -gamma * s_v * (S_new - S_old + s_v)
    return (weightToNew - weightToOld) - gamma * nodeSize * (sizeNew - sizeOld + nodeSize);
  }

  function moveNodeToCommunity(v, newC) {
    const oldC = nodeCommunity[v];
    if (oldC === newC) return false;
    // creating a brand new community if newC equals current q
    if (newC >= communityCount) {
      ensureCommCapacity(newC + 1);
      // zero-initialize new slots (already zero by default arrays)
      communityCount = newC + 1;
    }
    const strengthOutV = graph.strengthOut[v];
    const strengthInV = graph.strengthIn[v];
    const selfLoopWeight = graph.selfLoop[v];
    const nodeSize = graph.size[v];

    // update community totals
    communityNodeCount[oldC] -= 1; communityNodeCount[newC] += 1;
    communityTotalSize[oldC] -= nodeSize; communityTotalSize[newC] += nodeSize;
    if (graph.directed) {
      communityTotalOutStrength[oldC] -= strengthOutV; communityTotalOutStrength[newC] += strengthOutV;
      communityTotalInStrength[oldC] -= strengthInV; communityTotalInStrength[newC] += strengthInV;
    } else {
      communityTotalStrength[oldC] -= strengthOutV; communityTotalStrength[newC] += strengthOutV;
    }

    // internal weights: subtract connections to old, add to new
    if (graph.directed) {
      const outToOld = outEdgeWeightToCommunity[oldC] || 0;
      const inFromOld = inEdgeWeightFromCommunity[oldC] || 0;
      const outToNew = (newC < outEdgeWeightToCommunity.length ? (outEdgeWeightToCommunity[newC] || 0) : 0);
      const inFromNew = (newC < inEdgeWeightFromCommunity.length ? (inEdgeWeightFromCommunity[newC] || 0) : 0);
      communityInternalEdgeWeight[oldC] -= (outToOld + inFromOld + selfLoopWeight);
      communityInternalEdgeWeight[newC] += (outToNew + inFromNew + selfLoopWeight);
    } else {
      const weightToOld = neighborEdgeWeightToCommunity[oldC] || 0;
      const weightToNew = neighborEdgeWeightToCommunity[newC] || 0;
      communityInternalEdgeWeight[oldC] -= 2 * weightToOld + selfLoopWeight;
      communityInternalEdgeWeight[newC] += 2 * weightToNew + selfLoopWeight;
    }

    nodeCommunity[v] = newC;
    return true;
  }

  function compactCommunityIds(opts = {}) {
    // compact to 0..q'-1
    const ids = [];
    for (let c = 0; c < communityCount; c++) if (communityNodeCount[c] > 0) ids.push(c);
    if (opts.keepOldOrder) {
      // Preserve existing order: stable by old id
      ids.sort((a, b) => a - b);
    } else if (opts.preserveMap instanceof Map) {
      // Sort by provided mapping first (ascending), then by size as tiebreaker
      ids.sort((a, b) => {
        const pa = opts.preserveMap.get(a);
        const pb = opts.preserveMap.get(b);
        if (pa != null && pb != null && pa !== pb) return pa - pb;
        if (pa != null && pb == null) return -1;
        if (pb != null && pa == null) return 1;
        return (communityTotalSize[b] - communityTotalSize[a]) || (communityNodeCount[b] - communityNodeCount[a]) || (a - b);
      });
    } else {
      // default: decreasing by size then count then old id
      ids.sort((a, b) => (communityTotalSize[b] - communityTotalSize[a]) || (communityNodeCount[b] - communityNodeCount[a]) || (a - b));
    }
    const newId = new Int32Array(communityCount).fill(-1);
    ids.forEach((c, i) => { newId[c] = i; });
    for (let i = 0; i < nodeCommunity.length; i++) nodeCommunity[i] = newId[nodeCommunity[i]];
    // rebuild aggregates in new order
    const remappedCount = ids.length;
    const newTotalSize = new Float64Array(remappedCount);
    const newNodeCount = new Int32Array(remappedCount);
    const newInternalEdgeWeight = new Float64Array(remappedCount);
    const newTotalStrength = new Float64Array(remappedCount);
    const newTotalOutStrength = new Float64Array(remappedCount);
    const newTotalInStrength = new Float64Array(remappedCount);
    for (let i = 0; i < n; i++) {
      const c = nodeCommunity[i];
      newTotalSize[c] += graph.size[i];
      newNodeCount[c] += 1;
      if (graph.directed) {
        newTotalOutStrength[c] += graph.strengthOut[i];
        newTotalInStrength[c] += graph.strengthIn[i];
      } else {
        newTotalStrength[c] += graph.strengthOut[i];
      }
    }
    // recompute wIn by scanning edges once
    if (graph.directed) {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const list = graph.outEdges[i];
        for (let k = 0; k < list.length; k++) {
          const { to: j, w } = list[k];
          if (ci === nodeCommunity[j]) newInternalEdgeWeight[ci] += w;
        }
      }
    } else {
      for (let i = 0; i < n; i++) {
        const ci = nodeCommunity[i];
        const list = graph.outEdges[i];
        for (let k = 0; k < list.length; k++) {
          const { to: j, w } = list[k];
          if (j <= i) continue;
          if (ci === nodeCommunity[j]) newInternalEdgeWeight[ci] += w;
        }
      }
    }
    communityCount = remappedCount;
    communityTotalSize = newTotalSize;
    communityNodeCount = newNodeCount;
    communityInternalEdgeWeight = newInternalEdgeWeight;
    communityTotalStrength = newTotalStrength;
    communityTotalOutStrength = newTotalOutStrength;
    communityTotalInStrength = newTotalInStrength;
  }

  function getCommunityMembers() {
    const comms = new Array(communityCount); for (let i = 0; i < communityCount; i++) comms[i] = [];
    for (let i = 0; i < n; i++) comms[nodeCommunity[i]].push(i);
    return comms;
  }

  function getCommunityTotalSize(c) { return c < communityTotalSize.length ? communityTotalSize[c] : 0; }
  function getCommunityNodeCount(c) { return c < communityNodeCount.length ? communityNodeCount[c] : 0; }

  // Expose minimal API
  return {
    n,
    get communityCount() { return communityCount; },
    nodeCommunity,
    communityTotalSize,
    communityNodeCount,
    communityInternalEdgeWeight,
    communityTotalStrength,
    communityTotalOutStrength,
    communityTotalInStrength,
    initializeAggregates,
    accumulateNeighborCommunityEdgeWeights,
    getCandidateCommunityCount: () => candidateCommunityCount,
    getCandidateCommunityAt: (i) => candidateCommunities[i],
    getNeighborEdgeWeightToCommunity: (c) => neighborEdgeWeightToCommunity[c] || 0,
    getOutEdgeWeightToCommunity: (c) => outEdgeWeightToCommunity[c] || 0,
    getInEdgeWeightFromCommunity: (c) => inEdgeWeightFromCommunity[c] || 0,
    deltaModularityUndirected,
    deltaModularityDirected,
    deltaCPM,
    moveNodeToCommunity,
    compactCommunityIds,
    getCommunityMembers,
    getCommunityTotalSize,
    getCommunityNodeCount,
  };
}

function growFloat(a, to) { const b = new Float64Array(to); b.set(a); return b; }
function growInt(a, to) { const b = new Int32Array(to); b.set(a); return b; }
