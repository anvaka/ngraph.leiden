// Simple, modular tree view: Graph -> Communities -> Nodes
// Contract:
//   createCommunityTree({ container }): { update({ graph, clusters }): void, clear(): void }
// - graph: ngraph.graph instance
// - clusters: result of detectClusters(graph, options) or null
// Behavior:
// - Renders a collapsed-by-default root "graph".
// - Under root, communities (id and size). All collapsed by default.
// - Expanding a community lazily renders node ids belonging to it.
// - Handles large graphs gracefully by deferring node rendering until expansion.

export function createCommunityTree({ container, onSelectCommunity, onSelectNode }) {
  if (!container) throw new Error('container is required');

  // State
  let lastGraph = null;
  let lastClusters = null;
  let communityToNodes = null; // Map<communityId, Array<nodeId>>
  let communityColors = null;   // Map<communityId, ABGR color number>
  let selectedCommunityId = null;
  // Element refs to allow in-place updates without rerendering whole tree
  let headerSelectedEl = null;
  /** @type {Map<string, {summary: HTMLElement, title: HTMLElement}>} */
  let summaryRefs = new Map();

  function clear() {
    container.textContent = '';
    lastGraph = null;
    lastClusters = null;
    communityToNodes = null;
  // Render empty placeholder
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No data yet. Detect communities to populate.';
    container.appendChild(empty);
  }

  function buildIndex(graph, clusters) {
    if (!graph || !clusters) return new Map();
    // clusters.getCommunities() returns Map<cid, nodeId[]>
    const commMap = clusters.getCommunities();
    // We want deterministic ordering: sort community ids ascending if they look like numbers/strings
    const sorted = Array.from(commMap.keys()).sort((a, b) => {
      const na = Number(a), nb = Number(b);
      const aNum = Number.isFinite(na), bNum = Number.isFinite(nb);
      if (aNum && bNum) return na - nb;
      return String(a).localeCompare(String(b));
    });
    const index = new Map();
    for (const cid of sorted) {
      const nodes = commMap.get(cid).slice();
      // Sort nodes too for determinism
      nodes.sort((a, b) => String(a).localeCompare(String(b)));
      index.set(cid, nodes);
    }
    return index;
  }

  function render() {
    container.textContent = '';

    const rootDetails = document.createElement('details');
    rootDetails.open = false; // collapsed by default
    const rootSummary = document.createElement('summary');
    rootSummary.innerHTML = `<span class="twisty">▸</span> graph`;
    rootDetails.appendChild(rootSummary);

    // Container for communities
    const commList = document.createElement('div');
    commList.setAttribute('role', 'group');

    // Selection helper header
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.margin = '4px 0 8px';
    const sel = document.createElement('span');
    sel.className = 'muted';
    sel.textContent = selectedCommunityId == null ? 'No selection' : `Selected: ${selectedCommunityId}`;
    headerSelectedEl = sel;
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.className = 'btn';
    clearBtn.style.padding = '2px 6px';
    clearBtn.style.fontSize = '12px';
    clearBtn.addEventListener('click', () => onSelectCommunity && onSelectCommunity(null));
    header.appendChild(sel);
    header.appendChild(clearBtn);
    commList.appendChild(header);

    if (!communityToNodes || communityToNodes.size === 0) {
      const msg = document.createElement('div');
      msg.className = 'muted';
      msg.textContent = 'No communities yet.';
      commList.appendChild(msg);
    } else {
      summaryRefs = new Map();
      for (const [cid, nodeIds] of communityToNodes) {
        const det = document.createElement('details');
        det.open = false;
        const summary = document.createElement('summary');
        const color = communityColors?.get(cid);
        const css = color != null ? abgrToRgbaCSS(color) : null;
        if (css) {
          const sw = document.createElement('span');
          sw.style.display = 'inline-block';
          sw.style.width = '10px';
          sw.style.height = '10px';
          sw.style.borderRadius = '2px';
          sw.style.background = css;
          sw.style.marginRight = '6px';
          sw.style.verticalAlign = 'middle';
          sw.style.border = '1px solid #0006';
          summary.appendChild(sw);
        }
        const twisty = document.createElement('span');
        twisty.className = 'twisty';
        twisty.textContent = '▸';
        summary.appendChild(twisty);
        summary.appendChild(document.createTextNode(' '));
        const title = document.createElement('span');
        title.textContent = `community ${String(cid)}`;
        if (selectedCommunityId != null && String(selectedCommunityId) === String(cid)) {
          title.style.fontWeight = '600';
          title.style.textDecoration = 'underline';
        }
        summary.appendChild(title);
        summary.appendChild(document.createTextNode(' '));
        const count = document.createElement('span');
        count.className = 'muted';
        count.textContent = `(${nodeIds.length})`;
        summary.appendChild(count);
        summary.addEventListener('click', (e) => {
          // Toggle select on click
          if (onSelectCommunity) {
            const same = selectedCommunityId != null && String(selectedCommunityId) === String(cid);
            onSelectCommunity(same ? null : cid);
          }
        });
        det.appendChild(summary);
        const list = document.createElement('ul');
        // Lazy populate on first toggle open
        let populated = false;
        det.addEventListener('toggle', () => {
          twisty.textContent = det.open ? '▾' : '▸';
          if (det.open && !populated) {
            // Render nodes now
            for (const nid of nodeIds) {
              const li = document.createElement('li');
              li.textContent = String(nid);
              li.style.cursor = 'pointer';
              li.addEventListener('click', (e) => {
                e.stopPropagation();
                onSelectNode && onSelectNode(nid);
              });
              list.appendChild(li);
            }
            populated = true;
          }
        });
        det.appendChild(list);
        commList.appendChild(det);
        summaryRefs.set(String(cid), { summary, title });
      }
    }

    rootDetails.appendChild(commList);
    rootDetails.addEventListener('toggle', () => {
      const twisty = rootSummary.querySelector('.twisty');
      if (twisty) twisty.textContent = rootDetails.open ? '▾' : '▸';
    });

    container.appendChild(rootDetails);
  }

  function update({ graph, clusters, colors, selected }) {
    lastGraph = graph || null;
    lastClusters = clusters || null;
    communityToNodes = buildIndex(lastGraph, lastClusters);
    communityColors = colors || null;
    selectedCommunityId = selected ?? null;
    render();
  }

  // initial state
  clear();

  function setSelected(selected) {
    selectedCommunityId = selected == null ? null : selected;
    if (headerSelectedEl) headerSelectedEl.textContent = selectedCommunityId == null ? 'No selection' : `Selected: ${selectedCommunityId}`;
    // Update titles styling without full rerender
    for (const [cid, { title }] of summaryRefs) {
      const isSel = selectedCommunityId != null && String(selectedCommunityId) === String(cid);
      title.style.fontWeight = isSel ? '600' : '';
      title.style.textDecoration = isSel ? 'underline' : '';
    }
  }

  return { update, clear, setSelected };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function abgrToRgbaCSS(color) {
  // Our palette packs as (R<<24)|(G<<16)|(B<<8)|A
  const r = (color >>> 24) & 0xff;
  const g = (color >>> 16) & 0xff;
  const b = (color >>> 8) & 0xff;
  const a = color & 0xff;
  const alpha = (a / 255).toFixed(3);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
