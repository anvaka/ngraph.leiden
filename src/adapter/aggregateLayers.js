import createGraph from 'ngraph.graph'

// Aggregate multiple layers into a single graph by summing weighted edge weights.
// layers: Array<{ graph, weight?: number, linkWeight?: fn, nodeSize?: fn }>
// opts: { directed?: boolean }
export function aggregateLayers(layers, opts = {}) {
  if (!Array.isArray(layers) || layers.length === 0) throw new Error('layers must be a non-empty array');
  const directed = !!opts.directed; // currently unused; edges are added as provided
  const g0 = layers[0].graph;

  // Build base node list from the first layer
  const nodeIds = [];
  const hasNode = new Set();
  g0.forEachNode(n => { nodeIds.push(n.id); hasNode.add(n.id); });

  // Verify all layers have the same node set
  for (let l = 1; l < layers.length; l++) {
    const g = layers[l].graph;
    g.forEachNode(n => {
      if (!hasNode.has(n.id)) throw new Error('All layers must share identical node ids. Missing in base: ' + n.id);
    });
  }

  const agg = createGraph();
  // Node sizes: take from the first layer's nodeSize if provided, else default 1.
  const nodeSize0 = layers[0].nodeSize || ((node) => (node.data && typeof node.data.size === 'number') ? node.data.size : 1);
  for (let i = 0; i < nodeIds.length; i++) {
    const id = nodeIds[i];
    const n = g0.getNode ? g0.getNode(id) : null;
    const size = n ? nodeSize0(n) : 1;
    agg.addNode(id, { size });
  }

  // Accumulate edges
  const acc = new Map(); // key: `${u}\u0000${v}` -> weight
  for (let l = 0; l < layers.length; l++) {
    const { graph, weight = 1, linkWeight } = layers[l];
    const getW = linkWeight || ((link) => (link.data && typeof link.data.weight === 'number') ? link.data.weight : 1);
    graph.forEachLink(link => {
      const u = link.fromId; const v = link.toId;
      if (!hasNode.has(u) || !hasNode.has(v)) return; // defensive
      const w = weight * getW(link);
      if (w === 0) return;
      const key = u + '\u0000' + v;
      acc.set(key, (acc.get(key) || 0) + w);
    });
  }

  for (const [key, w] of acc.entries()) {
    const sep = key.indexOf('\u0000');
    const u = key.substring(0, sep);
    const v = key.substring(sep + 1);
    agg.addLink(u, v, { weight: w });
  }
  return agg;
}
