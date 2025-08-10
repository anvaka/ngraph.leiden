import { runLouvainUndirectedModularity } from '../optimise/optimiser.js'
import { qualityModularity } from '../quality/modularity.js'
import { qualityCPM, qualityCPMSizeAware } from '../quality/cpm.js'
import { aggregateLayers } from '../adapter/aggregateLayers.js'

export function detectClusters(graph, options = {}) {
  // Accept a single graph or an array of layers { graph, weight?, linkWeight?, nodeSize? }
  let inputGraph = graph;
  if (Array.isArray(graph)) {
    inputGraph = aggregateLayers(graph, { directed: !!options.directed });
  }
  const { graph: finalGraph, partition, levels, originalToCurrent, originalNodeIds } = runLouvainUndirectedModularity(inputGraph, options);
  // Map each original node index -> class at last level via originalToCurrent
  const idToClass = new Map();
  for (let i = 0; i < originalNodeIds.length; i++) {
    const comm = originalToCurrent[i];
    idToClass.set(originalNodeIds[i], comm);
  }

  return {
    getClass(nodeId) { return idToClass.get(nodeId); },
    getCommunities() {
      const out = new Map();
      // Reconstruct from idToClass
      for (const [id, c] of idToClass) {
        if (!out.has(c)) out.set(c, []);
        out.get(c).push(id);
      }
      return out;
    },
    quality() {
      const q = (options.quality || 'modularity').toLowerCase();
      if (q === 'cpm') {
        const gamma = typeof options.resolution === 'number' ? options.resolution : 1.0;
        if ((options.cpmMode || 'unit') === 'size-aware') return qualityCPMSizeAware(partition, finalGraph, gamma);
        return qualityCPM(partition, finalGraph, gamma);
      } else {
        return qualityModularity(partition, finalGraph);
      }
    },
    toJSON() {
      const membershipObj = {};
      for (const [id, c] of idToClass) membershipObj[id] = c;
      return { membership: membershipObj, meta: { levels: levels.length, quality: this.quality(), options } };
    }
  };
}
