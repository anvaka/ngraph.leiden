# Benchmarks

This folder contains micro + meso benchmarks comparing `ngraph.leiden` against `ngraph.louvain` for several synthetic graphs.

Run:

```sh
npm run bench
```

Outputs a table with ops/sec and time per run.

Graph generators:
- ringOfCliques (tests resolution limit / community separation)
- randomGNM (Erdos–Renyi G(n, m))
- grid2d (planar lattice)
- scaleFree (preferential attachment)

Metrics recorded:
- Detection wall time per library per generator & size.
- Resulting number of communities and modularity via a single unified evaluator (ngraph.leiden's O(m) scan) applied to both partitions for fair comparison.

Options:
- `--quick` runs a reduced set/smaller graphs for faster iteration.
- `--graph <name>` filters to a specific generator (can repeat).

Add or adjust graphs by editing `benchmarks/run.js`.
