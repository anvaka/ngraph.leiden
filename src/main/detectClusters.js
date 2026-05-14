import { runLeiden } from '../optimise/optimiser.js'
import { aggregateLayers } from '../adapter/aggregateLayers.js'
import { evaluateQuality } from '../evaluate.js'

export function detectClusters(graph, options = {}) {
  // Accept a single graph or an array of layers { graph, weight?, linkWeight?, nodeSize? }
  let inputGraph = graph;
  if (Array.isArray(graph)) {
    inputGraph = aggregateLayers(graph, { directed: !!options.directed });
  }
  const { levels, originalToCurrent, originalNodeIds } = runLeiden(inputGraph, options);
  // Map each original node index -> class at last level via originalToCurrent
  const idToClass = new Map();
  for (let i = 0; i < originalNodeIds.length; i++) {
    idToClass.set(originalNodeIds[i], originalToCurrent[i]);
  }

  return {
    getClass(nodeId) { return idToClass.get(nodeId); },
    getCommunities() {
      const out = new Map();
      for (const [id, c] of idToClass) {
        if (!out.has(c)) out.set(c, []);
        out.get(c).push(id);
      }
      return out;
    },
    quality() {
      // Evaluate on the original (base) graph so the reported quality matches
      // what a user would compute with their own implementation given the
      // membership map. Coarse-level partition bookkeeping would not reflect
      // unit-mode CPM correctly (its node count is coarse, not base).
      const membership = {};
      for (const [id, c] of idToClass) membership[id] = c;
      return evaluateQuality(inputGraph, membership, options);
    },
    toJSON() {
      const membershipObj = {};
      for (const [id, c] of idToClass) membershipObj[id] = c;
      return { membership: membershipObj, meta: { levels: levels.length, quality: this.quality(), options } };
    }
  };
}
