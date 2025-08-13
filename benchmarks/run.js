#!/usr/bin/env node
/* eslint-disable no-console */
import Benchmark from 'benchmark'
import createGraph from 'ngraph.graph'
import { detectClusters, evaluateQuality } from '../src/index.js'
import louvain from 'ngraph.louvain'

// Simple graph generators ----------------------------------------------------
function ringOfCliques({ cliques = 8, size = 16, bridgeWeight = 1 }) {
  const graph = createGraph()
  for (let cliqueIndex = 0; cliqueIndex < cliques; cliqueIndex++) {
    const cliqueStartNodeId = cliqueIndex * size
    for (let localNode = 0; localNode < size; localNode++) graph.addNode(cliqueStartNodeId + localNode)
    for (let i = 0; i < size; i++) {
      for (let j = i + 1; j < size; j++) {
        graph.addLink(cliqueStartNodeId + i, cliqueStartNodeId + j)
        graph.addLink(cliqueStartNodeId + j, cliqueStartNodeId + i)
      }
    }
    const nextCliqueStart = ((cliqueIndex + 1) % cliques) * size
  graph.addLink(cliqueStartNodeId + size - 1, nextCliqueStart)
  graph.addLink(nextCliqueStart, cliqueStartNodeId + size - 1)
    if (bridgeWeight !== 1) {
      const bridgeLink = graph.getLink(cliqueStartNodeId + size - 1, nextCliqueStart)
      if (bridgeLink) bridgeLink.data = { weight: bridgeWeight }
    }
  }
  return graph
}

function randomGNM({ n = 2000, m = 8000 }) {
  const graph = createGraph()
  for (let nodeId = 0; nodeId < n; nodeId++) graph.addNode(nodeId)
  for (let edgeIndex = 0; edgeIndex < m; edgeIndex++) {
    const source = (Math.random() * n) | 0
    let target = (Math.random() * n) | 0
    if (source === target) target = (target + 1) % n
    graph.addLink(source, target)
  }
  return graph
}

function grid2d({ n = 64 }) { // n = side length -> n^2 nodes
  const graph = createGraph()
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const nodeId = row * n + col
      graph.addNode(nodeId)
      if (col + 1 < n) graph.addLink(nodeId, row * n + (col + 1))
      if (row + 1 < n) graph.addLink(nodeId, (row + 1) * n + col)
    }
  }
  return graph
}

function scaleFree({ n = 5000, m = 3 }) { // Barabasi-Albert (directed)
  const graph = createGraph()
  const degreeBiasedTargets = [] // nodes repeated proportionally to (out)degree for preferential attachment
  // Initialize seed clique of size m
  for (let seedId = 0; seedId < m; seedId++) {
    graph.addNode(seedId)
    for (let prev = 0; prev < seedId; prev++) {
      graph.addLink(seedId, prev)
      // Add both endpoints to bias array so initial degrees are represented
      degreeBiasedTargets.push(seedId, prev)
    }
    // Ensure each seed appears at least once
    if (!degreeBiasedTargets.includes(seedId)) degreeBiasedTargets.push(seedId)
  }
  for (let newNodeId = m; newNodeId < n; newNodeId++) {
    graph.addNode(newNodeId)
    const chosenTargets = new Set()
    // Fallback: if bias array is somehow empty, connect to previous nodes directly.
    if (degreeBiasedTargets.length === 0) {
      for (let t = 0; t < Math.min(m, newNodeId); t++) chosenTargets.add(t)
    } else {
      let guard = 0
      while (chosenTargets.size < m && guard < m * 50) { // safety guard to prevent infinite loop
        const pick = degreeBiasedTargets[(Math.random() * degreeBiasedTargets.length) | 0]
        if (pick !== undefined && pick !== newNodeId) chosenTargets.add(pick)
        guard++
      }
      // If we failed to pick enough distinct targets (pathological), fill with random previous nodes
      if (chosenTargets.size < m) {
        while (chosenTargets.size < m) {
          const fallback = (Math.random() * newNodeId) | 0
            if (fallback !== newNodeId) chosenTargets.add(fallback)
        }
      }
    }
    for (const targetId of chosenTargets) graph.addLink(newNodeId, targetId)
    // Update bias array: new node gets an entry; each target gets another entry per new link
    degreeBiasedTargets.push(newNodeId)
    for (const targetId of chosenTargets) degreeBiasedTargets.push(targetId)
  }
  return graph
}

const generators = {
  ringOfCliques,
  randomGNM,
  grid2d,
  scaleFree
}

// Benchmark harness ----------------------------------------------------------
// Internal fast benchmark settings to keep runtime reasonable.
const BENCH_SETTINGS = { maxTime: 0.4, minSamples: 3 }
const GLOBAL_TIME_BUDGET_SEC = 10

function benchmarkGraph(generatorName, generatorArgs, detectOptions = {}) {
  const suite = new Benchmark.Suite()
  const graph = generators[generatorName](generatorArgs)
  const leidenOptions = { randomSeed: 1, ...detectOptions }

  suite
    .add('leiden', function () { detectClusters(graph, leidenOptions) }, BENCH_SETTINGS)
    .add('louvain', function () { louvain(graph) }, BENCH_SETTINGS)

  return new Promise(resolve => {
    const startedAt = Date.now()
    suite
      .on('start', () => console.log(`\n${generatorName} ${JSON.stringify(generatorArgs)}`))
      .on('cycle', event => console.log(String(event.target)))
      .on('complete', function () {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2)
        const results = { elapsedSeconds: Number(elapsed) }
        this.forEach(benchmark => { results[benchmark.name] = { hz: benchmark.hz, rme: benchmark.stats.rme, mean: benchmark.stats.mean } })
        try {
          // Run each algorithm once more to collect quality metrics.
          const leidenResult = detectClusters(graph, leidenOptions)
          const louvainResult = louvain(graph)
          const louvainMembership = {}
          graph.forEachNode(node => { louvainMembership[node.id] = louvainResult.getClass(node.id) })
          const louvainCommunityCount = new Set(Object.values(louvainMembership)).size
          const leidenMembership = {}
          leidenResult.getCommunities().forEach((nodes, commId) => {
            for (const nodeId of nodes) leidenMembership[nodeId] = commId
          })
          const leidenModularity = evaluateQuality(graph, leidenMembership, { quality: 'modularity' })
          const louvainModularity = evaluateQuality(graph, louvainMembership, { quality: 'modularity' })
          results.meta = {
            leidenModularity,
            louvainModularity,
            leidenCommunities: leidenResult.getCommunities().size,
            louvainCommunities: louvainCommunityCount
          }
        } catch (e) {
          results.meta = { error: e.message }
        }
        resolve({ name: generatorName, buildArgs: generatorArgs, results })
      })
      .run({ async: true })
  })
}

// No CLI args: simplified always-fast run.

async function main() {
  // Curated list sized to finish quickly (< ~10s on typical laptop)
  const selectedConfigs = [
    ['ringOfCliques', { cliques: 10, size: 8 }],     // 80 nodes; dense intra-clique
    ['randomGNM', { n: 1200, m: 6000 }],             // sparse-ish random graph
    ['grid2d', { n: 72 }],                           // 5184 nodes, ~2*(n*(n-1)) edges directional assumption
    ['scaleFree', { n: 3000, m: 3 }]                 // larger preferential attachment
  ]
  const startedAll = Date.now()
  const benchmarkResults = []
  for (const [name, args] of selectedConfigs) {
    if ((Date.now() - startedAll) / 1000 > GLOBAL_TIME_BUDGET_SEC) {
      console.log(`\nTime budget (${GLOBAL_TIME_BUDGET_SEC}s) exceeded. Skipping remaining benchmarks.`)
      break
    }
    // eslint-disable-next-line no-await-in-loop
    benchmarkResults.push(await benchmarkGraph(name, args))
  }
  // Pretty print summary
  console.log('\nBenchmark summary')
  for (const result of benchmarkResults) {
    const { name: generatorName, buildArgs: generatorArgs, results: runResults } = result
    const leidenStats = runResults.leiden
    const louvainStats = runResults.louvain
    const meta = runResults.meta || {}
    const graphTitle = `${generatorName} ${JSON.stringify(generatorArgs)}`
    const lHz = leidenStats.hz
    const lvHz = louvainStats.hz
    let winner;
    if (lvHz > lHz) winner = 'Louvain is faster'; else if (lHz > lvHz) winner = 'Leiden is faster'; else winner = 'Tie';
    console.log(`\n# ${graphTitle}:`)
    console.log(`Elapsed: ${runResults.elapsedSeconds?.toFixed?.(2) ?? '--'}s`)
    console.log(`Winner: ${winner}`)
    // Community quality comparison (modularity higher is better)
    if (meta && Number.isFinite(meta.leidenModularity) && Number.isFinite(meta.louvainModularity)) {
      const lm = meta.leidenModularity
      const lvm = meta.louvainModularity
      const diff = lm - lvm
      const rel = lvm !== 0 ? (diff / Math.abs(lvm)) : 0
      const absDiffStr = Math.abs(diff) < 0.0005 ? '<0.001' : Math.abs(diff).toFixed(3)
      if (Math.abs(diff) < 0.002) {
        console.log(`Community quality: Tie (modularity diff ${absDiffStr})`)
      } else if (diff > 0) {
        console.log(`Community quality: Leiden better (modularity ${formatMod(lm)} vs ${formatMod(lvm)}; +${(rel * 100).toFixed(1)}%)`)
      } else {
        console.log(`Community quality: Louvain better (modularity ${formatMod(lvm)} vs ${formatMod(lm)}; +${((-rel) * 100).toFixed(1)}%)`)
      }
    } else {
      console.log('Community quality: --')
    }
    console.log(`\n## Louvain:`)
    console.log(`* Operations per second: ${lvHz.toFixed(2)} (±${louvainStats.rme.toFixed(2)}%)`)
  console.log(`* Modularity: ${formatMod(meta.louvainModularity)}`)
    console.log(`* Communities Detected: ${meta.louvainCommunities ?? '--'}`)
    console.log(`\n## Leiden`)
    console.log(`* Operations per second: ${lHz.toFixed(2)} (±${leidenStats.rme.toFixed(2)}%)`)
  console.log(`* Modularity: ${formatMod(meta.leidenModularity)}`)
    console.log(`* Communities Detected: ${meta.leidenCommunities ?? '--'}`)
  }
}

function formatMod(q) {
  if (q == null || !Number.isFinite(q)) return '--'
  const abs = Math.abs(q)
  if (abs === 0) return '0'
  if (abs >= 0.01 && abs < 1000) return q.toFixed(2)
  return q.toPrecision(2)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1) })
}
