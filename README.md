## ngraph.leiden

Leiden/Louvain community detection for ngraph.graph. Fast, deterministic (seeded), and flexible: undirected/directed modularity, CPM with resolution, multilayer aggregation, fixed nodes, and custom weights/sizes.

Quick online demo: https://anvaka.github.io/ngraph.leiden/

If you prefer command line: `cat graph.dot | npx ngraph.leiden` - prints node/community membership

## Install

Install the published package in your project:

```sh
npm i ngraph.leiden
```

This repository uses Node 18+ for development. To work on the repo locally:

```sh
npm install
npm test
npm run build
```

## Quick start

```js
import createGraph from 'ngraph.graph'
import { detectClusters } from 'ngraph.leiden'

const g = createGraph()
// Undirected graphs: just add a single link; adapter will symmetrize for you
g.addNode('a'); g.addNode('b'); g.addNode('c'); g.addNode('d')
g.addLink('a','b')
g.addLink('c','d')

const result = detectClusters(g, { randomSeed: 42 })

// Get a community id for a node
console.log('a ->', result.getClass('a'))

// Group membership as Map<communityId, nodeId[]>
console.log(result.getCommunities())

// Partition quality for the chosen objective
console.log('Q =', result.quality())
```

CommonJS:

```js
const createGraph = require('ngraph.graph')
const { detectClusters } = require('ngraph.leiden')
```

## API

Signature
- `detectClusters(input, options?) => Clusters`

Input
- `input`: either
  - an `ngraph.graph` instance; or
  - a multilayer array: `[{ graph, weight?, linkWeight?, nodeSize? }]` — all layers must share the same node ids (see Multilayer graphs).

Return value: `Clusters`
- `getClass(nodeId): number` — community id for `nodeId`.
- `getCommunities(): Map<number, string[]>` — nodes grouped by community id.
- `quality(): number` — objective value for the final partition. With `quality: 'cpm'`, see CPM on how it’s computed and `options.cpmMode`.
- `toJSON(): { membership: Record<id, number>, meta: { levels: number, quality: number, options: object } }`.

Options

Each option below is optional. Defaults are shown in backticks.

### quality
- What: Objective to optimize.
- Values: `'modularity'` | `'cpm'`. Default: `'modularity'`.
- Why: Use `'modularity'` for classic community detection; use `'cpm'` (Constant Potts Model) when you need explicit control over community granularity via `resolution` or when modularity’s resolution limit is an issue.
- When: Prefer `'cpm'` for very large graphs or when you want consistent small communities; otherwise `'modularity'` is a strong default.

### resolution (CPM)
- What: The `gamma` parameter for CPM.
- Value: `number`. Default: `1.0`.
- Why: Larger `resolution` yields more/smaller communities; smaller yields fewer/larger.
- When: Tune to match desired granularity; try `0.1`, `1.0`, `5.0` as starting points.

### directed
- What: Enable Leicht–Newman directed modularity.
- Value: `boolean`. Default: `false`.
- Why: For directed networks where in/out strengths matter.
- When: Set `true` for directed graphs. For undirected, keep `false` and add reciprocal links in your graph.

### randomSeed
- What: Seed for the internal RNG used for node order shuffles.
- Value: `number`. Default: `42`.
- Why: Ensures deterministic, reproducible partitions.
- When: Set explicitly for reproducible experiments or tests.

### candidateStrategy
- What: Controls which target communities are considered when moving a node.
- Values: `'neighbors'` (default), `'all'`, `'random'`, `'random-neighbor'`.
- Why: Trade-off between speed and search breadth.
- When:
  - `'neighbors'`: fastest and typical; consider only adjacent communities.
  - `'all'`: exhaustive but slow on large graphs.
  - `'random'`: sample from all communities (broader search at bounded cost).
  - `'random-neighbor'`: sample from neighbor communities (cheap, slightly more exploratory).

### allowNewCommunity
- What: Allow moves that create a fresh singleton community.
- Value: `boolean`. Default: `false`.
- Why: Can help escape local minima in specific structures.
- When: Rarely needed; try enabling if you see over-merged communities.

### maxCommunitySize
- What: Upper bound on a community’s total size.
- Value: `number`. Default: `Infinity`.
- How measured: Uses `nodeSize` (default `1` per node). A move that would exceed this bound is skipped.
- Why: Enforce capacity or balance constraints.
- When: Useful for constrained clustering or to avoid giant communities.

### refine
- What: Enable Leiden-style refinement between coarsening levels.
- Value: `boolean`. Default: `true`.
- Why: Improves partitions by re-optimizing within coarse communities.
- When: Keep `true` for best quality; turn off for speed-sensitive runs.

### fixedNodes
- What: Nodes that must remain in their initial communities at the finest level.
- Value: `Set` or `Array` of node ids.
- Why: Respect domain constraints or anchor communities.
- When: Use to pin landmarks, seeds, or known group members.

### preserveLabels
- What: Control how community ids are compacted after renumbering.
- Values: `false` (default), `true` (preserve old order), or `Map<oldId, order>`.
- Why: Stable ids across runs or alignment to a predefined ordering.
- When: Advanced; mostly for downstream integration/visualization.

### linkWeight
- What: Function to read an edge’s weight.
- Signature: `(link) => number`. Default: `link.data?.weight ?? 1`.
- Why: Use custom attributes (e.g., frequency, strength) as weights.
- Example:
  ```js
  const res = detectClusters(g, { linkWeight: l => Math.max(0, l.data?.w ?? 0) })
  ```

### nodeSize
- What: Function to read a node’s size (used by CPM and `maxCommunitySize`).
- Signature: `(node) => number`. Default: `node.data?.size ?? 1`.
- Why: Make CPM size-aware or weight capacity by node importance.
- Example:
  ```js
  const res = detectClusters(g, { nodeSize: n => n.data?.pop ?? 1, quality: 'cpm' })
  ```

### maxLevels, maxLocalPasses
- What: Internal performance knobs for the multi-level loop and local passes.
- Values: `number`. Defaults are conservative and usually fine.
- Why/When: Only tune if you profile and identify a need.

## Vocabulary

- Modularity: Measures how much more densely connected nodes are within communities than expected at random. Directed modularity (Leicht–Newman) uses in/out strengths. Higher is better; can suffer from a resolution limit on very large graphs.
- CPM (Constant Potts Model): Maximizes internal edge weight minus gamma × a penalty for community size. Gamma (resolution) controls granularity: larger gamma → more/smaller communities; smaller gamma → fewer/larger. Supports custom node sizes via nodeSize.

## CPM

CPM is a resolution-tunable objective. During optimization this package uses node sizes (via nodeSize), so gains reflect community size; with default nodeSize=1 this matches “unit-count” CPM. If you supply custom node sizes, the optimization becomes size-aware. The quality() reporter supports:

- options.cpmMode: 'unit' | 'size-aware' (affects only how quality() is computed, not the move heuristic). If you use custom node sizes and want "unit-count" reporting, keep cpmMode='unit'.

## Multilayer graphs

Pass an array of layers: [{ graph, weight?, linkWeight?, nodeSize? }]. Edges are aggregated by summing weight * linkWeight(link) per layer. All layers must have the same set of node ids. Node sizes default to the first layer’s nodeSize.

Example:

```js
const result = detectClusters([
  { graph: layer1, weight: 1.0 },
  { graph: layer2, weight: 0.2 },
], { quality: 'modularity', randomSeed: 7 })
```

When to use it
- Multiplex networks: combine different relation types (e.g., friendship + collaboration).
- Temporal smoothing: blend snapshots with weights to reduce short-term noise.
- Heterogeneous signals: fuse a strong–sparse layer with a weak–dense layer.
- Denoising: add a lightly weighted prior layer to stabilize communities.

## Directed graphs

Set { directed: true } to use Leicht–Newman directed modularity. Edges are taken as-is; no reciprocal links are needed.

Undirected handling
- If directed: false (default), the adapter symmetrizes edges so you don’t need to add reciprocal links to your ngraph.graph.
- If both directions exist between two nodes with possibly different weights, the adapter averages them: w_undirected = (w_ij + w_ji) / 2, then emits symmetric edges with that weight. This preserves total weight and keeps results consistent whether you supplied one or both directions.

## Constraints and ergonomics

- Fixed nodes: keep given nodes in their initial communities at the finest level (also respected during refinement).
- Community size limit: maxCommunitySize prevents moves that would exceed the given total nodeSize.
- Determinism: randomSeed controls shuffle order; repeated runs with the same seed and inputs are deterministic.
- Negative weights and self-loops are supported; use negative weights with care as modularity assumptions may not hold theoretically.

## Examples

Modularity with custom weights

```js
const g = createGraph()
g.addNode('x'); g.addNode('y'); g.addNode('z')
g.addLink('x','y', { weight: 2 }); g.addLink('y','x', { weight: 2 })
g.addLink('y','z', { weight: 0.3 }); g.addLink('z','y', { weight: 0.3 })

const res = detectClusters(g, { quality: 'modularity', randomSeed: 1, linkWeight: l => l.data?.weight ?? 1 })
```

CPM with resolution and node sizes

```js
const res = detectClusters(g, {
  quality: 'cpm',
  resolution: 0.5,
  nodeSize: n => n.data?.size ?? 1,
  randomSeed: 3,
})
```

Fix a subset of nodes

```js
const res = detectClusters(g, { fixedNodes: new Set(['x','z']), randomSeed: 11, refine: true })
```

## Build and test

- Build library bundles: `npm run build`
- Run tests: `npm test`

## CLI

This package ships a small CLI for quick community detection (via npx or installed locally).

Input format is auto-detected by file extension (.dot/.gv/.json) or by content (tries JSON first, then DOT). Use --format to override.

Usage examples

- From a DOT file

```sh
npx ngraph.leiden --in graph.dot --out membership.json
```

- From stdin

```sh
cat graph.dot | npx ngraph.leiden --membership-only
```

- From a JSON edgelist (either an array of {source,target,weight?} or {nodes,links})

```sh
cat edges.json | npx ngraph.leiden > out.json
```

Options

- `--directed` — treat input as directed
- `--quality` modularity|cpm (default modularity)
- `--resolution <gamma>` — CPM resolution parameter
- `--candidate-strategy` neighbors|all|random|random-neighbor
- `--max-levels`, `--max-local-passes`, `--random-seed`
- `--max-community-size <num>`
- `--allow-new-community`, `--no-refine`
- `--fixed <file>` — newline-separated node ids to keep fixed at level 0
- `--membership-only` — print only the id->community map

Output

- Defaults to JSON on stdout; use `--out <file>` to write to a file.
- Formats:
  - JSON (default): full object `{membership, meta}` or mapping only with `--membership-only`.
  - CSV: `--out-format csv` prints header `nodeId,communityId`.
  - DOT: `--out-format dot` overlays `community="..."` on nodes using ngraph.todot.

Quality-only evaluation

Evaluate modularity/CPM for an existing membership mapping without running detection:

```sh
npx ngraph.leiden \
  --in graph.dot --format dot \
  --evaluate --membership membership.json \
  --quality modularity
```

## License

MIT © Andrei Kashcha
