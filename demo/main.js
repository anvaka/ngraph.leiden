import { createScene } from 'w-gl';
import createLayout from 'ngraph.forcelayout';
import miserables from 'miserables';
import { detectClusters } from 'ngraph.leiden';
import { buildCommunityPalette, uniqueColorsCount } from './color/communitiesColors.js';

// Minimal file drop loader for .dot (optional progressive enhancement)
import fromdot from 'ngraph.fromdot';

// Import minimal point/line collections (subset) using w-gl
import SimplePointCollection from './gl/SimplePointCollection.js';
import SimpleLineCollection from './gl/SimpleLineCollection.js';
import MSDFTextCollection from './gl/MSDFTextCollection.js';
import { createCommunityTree } from './ui/CommunityTree.js';

let graph = miserables.create();
const canvas = document.getElementById('cnv');
let scene, nodes, lines, labels, layout, rafId;
let currentClusters = null;
let communityTree = null;
let selectedCommunityId = null;
// Base alpha for edges depends on number of links in the graph (more links -> more transparent)
let edgeAlpha = 0x20; // default fallback

function computeEdgeAlpha(linkCount) {
  // Target: ~0x20 at ~200 edges, fade to ~0x06 at thousands, up to ~0x40 for tiny graphs
  if (!Number.isFinite(linkCount) || linkCount <= 0) return 0x40;
  const base = 32 * Math.sqrt(200 / linkCount);
  const a = Math.max(6, Math.min(64, Math.round(base)));
  return a & 0xFF;
}
function whiteWithAlpha(a) { return (0xFFFFFF00 | (a & 0xFF)) >>> 0; }

init(graph);

// UI
const layoutBtn = document.getElementById('layoutBtn');
const detectBtn = document.getElementById('detectBtn');
const settingsToggle = document.getElementById('settingsToggle');
const cfgForm = document.getElementById('configForm');

settingsToggle?.addEventListener('click', () => {
  cfgForm?.classList.toggle('hidden');
});

layoutBtn.addEventListener('click', () => {
  if (cfgForm?.classList.contains('hidden')) cfgForm.classList.remove('hidden');
  runLayout(200);
});
detectBtn.addEventListener('click', () => {
  if (cfgForm?.classList.contains('hidden')) cfgForm.classList.remove('hidden');
  colorByCommunities(getOptionsFromUI());
});
cfgForm?.addEventListener('change', () => {
  // Live re-color on option changes if clusters exist
  if (currentClusters) colorByCommunities(getOptionsFromUI());
});

// Drag&drop .dot support
window.addEventListener('dragover', (e) => { e.preventDefault() });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  if (!file.name.endsWith('.dot')) return;
  const text = await file.text();
  const g = fromdot(text);
  loadGraph(g);
  // Auto-open settings after loading a file
  cfgForm?.classList.remove('hidden');
});

function init(g) {
  scene = createScene(canvas);
  scene.setClearColor(12/255, 41/255, 82/255, 1);
  const sz = 40;
  scene.setViewBox({ left: -sz, top: -sz, right: sz, bottom: sz });
  loadGraph(g);
  // Initialize community tree UI
  const treeContainer = document.getElementById('communityTree');
  if (treeContainer) {
    communityTree = createCommunityTree({
      container: treeContainer,
      onSelectCommunity: (cid) => selectCommunity(cid),
      onSelectNode: (nid) => flyToNode(nid)
    });
    communityTree.update({ graph, clusters: currentClusters, colors: getCommunityColors(), selected: selectedCommunityId });
  }
  rafId = requestAnimationFrame(frame);
  // Run a bit of layout and detect on start
  runLayout(300);
  colorByCommunities(getOptionsFromUI());
}

function loadGraph(g) {
  if (layout) layout.dispose?.();
  // Properly remove old collections from the scene before disposing,
  // per w-gl Architecture (scene.removeChild + dispose)
  if (lines) {
    try { scene.removeChild(lines); } catch (_) {}
    lines.dispose?.();
    lines = null;
  }
  if (nodes) {
    try { scene.removeChild(nodes); } catch (_) {}
    nodes.dispose?.();
    nodes = null;
  }
  if (labels) {
    try { scene.removeChild(labels); } catch (_) {}
    labels.dispose?.();
    labels = null;
  }

  graph = g;
  // Recalculate base edge transparency for this graph
  edgeAlpha = computeEdgeAlpha(graph.getLinksCount());
  // Reset clusters and selection for a new graph
  currentClusters = null;
  selectedCommunityId = null;
  layout = createLayout(graph, { timeStep: 0.5, springLength: 10, springCoefficient: 0.8, gravity: -12, dragCoefficient: 0.9 });
  layout.step();

  // Create GL collections
  const gl = scene.getGL();
  nodes = new SimplePointCollection(gl, { capacity: graph.getNodesCount() });
  lines = new SimpleLineCollection(gl, { capacity: graph.getLinksCount() });
  labels = new MSDFTextCollection(gl, { fontSize: 1, fontPath: 'https://raw.githubusercontent.com/anvaka/graph-start/refs/heads/main/public/fonts' });

  // Initialize UI objects
  graph.forEachNode((n) => {
    const p = layout.getNodePosition(n.id);
    const color = 0x90f8fcff; // default
    const size = 1;
    n.ui = { position: [p.x, p.y, p.z || 0], color, size };
    n.uiId = nodes.add(n.ui);
  });
  graph.forEachLink((l) => {
    const fp = layout.getNodePosition(l.fromId);
    const tp = layout.getNodePosition(l.toId);
    const color = whiteWithAlpha(edgeAlpha);
    l.ui = { from: [fp.x, fp.y, fp.z || 0], to: [tp.x, tp.y, tp.z || 0], color };
    l.uiId = lines.add(l.ui);
  });

  scene.appendChild(lines);
  scene.appendChild(nodes);
  scene.appendChild(labels);
  redrawLabels();
  // Update tree with new graph; no clusters yet
  if (communityTree) communityTree.update({ graph, clusters: currentClusters, colors: null, selected: selectedCommunityId });
}

function runLayout(steps) {
  for (let i = 0; i < steps; i++) layout.step();
}

function frame() {
  rafId = requestAnimationFrame(frame);
  // update positions
  graph.forEachNode((n) => {
    const p = layout.getNodePosition(n.id);
    const pos = n.ui.position;
    pos[0] = p.x; pos[1] = p.y; pos[2] = p.z || 0;
    nodes.update(n.uiId, n.ui);
  });
  graph.forEachLink((l) => {
    const fp = layout.getNodePosition(l.fromId);
    const tp = layout.getNodePosition(l.toId);
    const { from, to } = l.ui;
    from[0] = fp.x; from[1] = fp.y; from[2] = fp.z || 0;
    to[0] = tp.x; to[1] = tp.y; to[2] = tp.z || 0;
    lines.update(l.uiId, l.ui);
  });
  // labels can be heavy; only redraw when layout changed a lot or on demand.
  // Here we keep it simple and redraw every frame once fonts ready.
  if (labels?.isReady) redrawLabels();
  scene.renderFrame();
}

function redrawLabels() {
  if (!labels) return;
  labels.clear();
  // If we have cluster info, show community name; else show node id
  const comm = currentClusters;
  graph.forEachNode((n) => {
    const p = n.ui?.position;
    if (!p) return;
    const cid = comm ? comm.getClass(n.id) : null;
    const text = cid != null ? String(cid) : String(n.id);
    const sz = n.ui?.size || 1;
    labels.addText({
      text,
      x: p[0],
      y: p[1] - sz * 0.6, // slightly below center
      limit: sz,          // fit into node size width like graph-start
      cx: 0.5,
    });
  });
}

function colorByCommunities(options = {}) {
  const res = detectClusters(graph, options);
  currentClusters = res;
  const commMap = res.getCommunities();
  const palette = buildCommunityPalette(commMap.keys());
  graph.forEachNode((n) => {
    const c = res.getClass(n.id);
    n.ui.color = palette.get(c) || 0x90f8fcff;
    nodes.update(n.uiId, n.ui);
  });
  // Also refresh labels to reflect community ids
  redrawLabels();
  // Quality badge update
  const qv = document.getElementById('qualityValue');
  if (qv) qv.textContent = Number(res.quality()).toFixed(6);
  // Show counts in a subtle way near quality
  const commBadge = document.getElementById('communityStats');
  if (commBadge) {
    const unique = uniqueColorsCount(palette);
    commBadge.textContent = `${commMap.size} communities • ${unique} colors`;
  }
  if (communityTree) communityTree.update({ graph, clusters: currentClusters, colors: getCommunityColors(), selected: selectedCommunityId });
  // Maintain highlight state across recolor
  applyHighlight();
}

// Map community id -> color from current render palette
function getCommunityColors() {
  if (!currentClusters) return null;
  const commMap = currentClusters.getCommunities();
  const palette = buildCommunityPalette(commMap.keys());
  const out = new Map();
  for (const cid of commMap.keys()) out.set(cid, palette.get(cid));
  return out;
}

// Apply highlight based on selectedCommunityId.
function applyHighlight() {
  if (!nodes || !lines) return;
  const selected = selectedCommunityId;
  if (!currentClusters || selected == null) {
    // restore original colors based on currentClusters/palette
    if (!currentClusters) return;
    const commMap = currentClusters.getCommunities();
    const palette = buildCommunityPalette(commMap.keys());
    graph.forEachNode((n) => {
      const c = currentClusters.getClass(n.id);
      n.ui.color = palette.get(c) || 0x90f8fcff;
      nodes.update(n.uiId, n.ui);
    });
    graph.forEachLink((l) => {
      l.ui.color = whiteWithAlpha(edgeAlpha);
      lines.update(l.uiId, l.ui);
    });
    return;
  }
  // Dim all others
  const dimNode = 0x80808055; // gray translucent
  const dimLink = whiteWithAlpha(Math.max(Math.round(edgeAlpha * 0.5), 4));
  const commMap = currentClusters.getCommunities();
  const palette = buildCommunityPalette(commMap.keys());
  graph.forEachNode((n) => {
    const c = currentClusters.getClass(n.id);
    const isIn = String(c) === String(selected);
    n.ui.color = isIn ? (palette.get(c) || 0x90f8fcff) : dimNode;
    nodes.update(n.uiId, n.ui);
  });
  graph.forEachLink((l) => {
    const cFrom = currentClusters.getClass(l.fromId);
    const cTo = currentClusters.getClass(l.toId);
    const isIn = String(cFrom) === String(selected) && String(cTo) === String(selected);
    const hiA = Math.min(edgeAlpha * 2, 0x80);
    l.ui.color = isIn ? whiteWithAlpha(hiA) : dimLink;
    lines.update(l.uiId, l.ui);
  });
}

function selectCommunity(cid) {
  selectedCommunityId = cid == null ? null : cid;
  applyHighlight();
  if (communityTree) communityTree.setSelected(selectedCommunityId);
}

function flyToNode(nodeId) {
  // Use w-gl's built-in flyTo API (x, y, optional durationMs)
  const p = layout.getNodePosition(nodeId);
  if (!p) return;
  scene.flyTo({ x: p.x, y: p.y, durationMs: 350 });
}

// resetColors removed per UI simplification

// hsvToABGR moved to ./color/communitiesColors.js

// end classes
function getOptionsFromUI() {
  const form = document.getElementById('configForm');
  if (!form) return { quality: 'modularity' };
  const fd = new FormData(form);
  const quality = fd.get('quality') || 'modularity';
  const directed = fd.get('directed') === 'on';
  const refine = fd.get('refine') !== 'off';
  const allowNewCommunity = fd.get('allowNewCommunity') === 'on';
  // preserveLabels options removed from UI
  const candidateStrategy = fd.get('candidateStrategy') || 'neighbors';
  const maxCommunitySizeRaw = fd.get('maxCommunitySize');
  const resolutionRaw = fd.get('resolution');
  const randomSeedRaw = fd.get('randomSeed');
  const cpmMode = fd.get('cpmMode') || 'unit';
  // fixedNodes removed from UI
  const linkWeightExpr = fd.get('linkWeightExpr');
  const nodeSizeExpr = fd.get('nodeSizeExpr');
  const maxLevelsRaw = fd.get('maxLevels');
  const maxLocalPassesRaw = fd.get('maxLocalPasses');

  const opts = {
    quality: String(quality),
    directed,
    refine,
    allowNewCommunity,
    candidateStrategy: String(candidateStrategy)
  };
  if (resolutionRaw) opts.resolution = Number(resolutionRaw);
  if (randomSeedRaw) opts.randomSeed = Number(randomSeedRaw);
  if (maxCommunitySizeRaw) opts.maxCommunitySize = Number(maxCommunitySizeRaw);
  if (quality === 'cpm' && cpmMode) opts.cpmMode = String(cpmMode);
  if (linkWeightExpr) {
    try { opts.linkWeight = Function('l', `return (${linkWeightExpr})(l)`); } catch (e) { console.warn('Bad linkWeight fn'); }
  }
  if (nodeSizeExpr) {
    try { opts.nodeSize = Function('n', `return (${nodeSizeExpr})(n)`); } catch (e) { console.warn('Bad nodeSize fn'); }
  }
  if (maxLevelsRaw) opts.maxLevels = Number(maxLevelsRaw);
  if (maxLocalPassesRaw) opts.maxLocalPasses = Number(maxLocalPassesRaw);
  return opts;
}
