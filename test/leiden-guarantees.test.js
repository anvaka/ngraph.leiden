import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters, evaluateQuality } from '../src/index.js'

// Helper: return true iff every community returned by `clusters` is a connected
// subgraph of `g`. The whole point of Leiden's refinement is to guarantee this.
function allCommunitiesAreConnected(g, clusters) {
  const byClass = new Map()
  g.forEachNode(n => {
    const c = clusters.getClass(n.id)
    if (c == null) return
    if (!byClass.has(c)) byClass.set(c, new Set())
    byClass.get(c).add(n.id)
  })
  for (const members of byClass.values()) {
    if (members.size <= 1) continue
    const start = members.values().next().value
    const seen = new Set([start])
    const stack = [start]
    while (stack.length) {
      const cur = stack.pop()
      g.forEachLinkedNode(cur, other => {
        if (members.has(other.id) && !seen.has(other.id)) {
          seen.add(other.id)
          stack.push(other.id)
        }
      }, false)
    }
    if (seen.size !== members.size) return false
  }
  return true
}

// A bridge-node construction that the paper uses to motivate Leiden. Two
// triangles linked through a shared bridge node — Louvain can leave the
// community disconnected after the bridge moves; Leiden's refinement should
// always return connected communities.
function makeBridgeGraph() {
  const g = createGraph()
  // Two clusters of 6 nodes plus a bridge node 12.
  const A = [0, 1, 2, 3, 4, 5]
  const B = [6, 7, 8, 9, 10, 11]
  ;[...A, ...B, 12].forEach(id => g.addNode(id))
  // strong cliques
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    g.addLink(A[i], A[j]); g.addLink(A[j], A[i])
  }
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    g.addLink(B[i], B[j]); g.addLink(B[j], B[i])
  }
  // bridge 12 attaches to one member of each side
  g.addLink(12, 0); g.addLink(0, 12)
  g.addLink(12, 6); g.addLink(6, 12)
  return g
}

describe('Leiden guarantees', () => {
  it('produces connected communities across many seeds (modularity)', () => {
    const g = makeBridgeGraph()
    for (let seed = 1; seed <= 20; seed++) {
      const clusters = detectClusters(g, { randomSeed: seed })
      expect(allCommunitiesAreConnected(g, clusters)).toBe(true)
    }
  })

  it('produces connected communities across many seeds (CPM)', () => {
    const g = makeBridgeGraph()
    for (let seed = 1; seed <= 20; seed++) {
      const clusters = detectClusters(g, { quality: 'cpm', resolution: 0.2, randomSeed: seed })
      expect(allCommunitiesAreConnected(g, clusters)).toBe(true)
    }
  })

  it('result.quality() matches evaluateQuality for modularity', () => {
    const g = makeBridgeGraph()
    const clusters = detectClusters(g, { randomSeed: 7 })
    const membership = {}
    g.forEachNode(n => { membership[n.id] = clusters.getClass(n.id) })
    const fromResult = clusters.quality()
    const fromEvaluator = evaluateQuality(g, membership, { quality: 'modularity' })
    expect(fromResult).toBeCloseTo(fromEvaluator, 10)
  })

  it('result.quality() matches evaluateQuality for CPM', () => {
    const g = makeBridgeGraph()
    const clusters = detectClusters(g, { quality: 'cpm', resolution: 0.5, randomSeed: 7 })
    const membership = {}
    g.forEachNode(n => { membership[n.id] = clusters.getClass(n.id) })
    const fromResult = clusters.quality()
    const fromEvaluator = evaluateQuality(g, membership, { quality: 'cpm', resolution: 0.5 })
    expect(fromResult).toBeCloseTo(fromEvaluator, 10)
  })

  it('classical modularity for a single-edge graph equals 0 when both nodes share a community', () => {
    // Tiny but precise: single edge a—b in one community should give Q=0 by the
    // standard Newman definition. Verifies the factor-of-2 fix on L.
    const g = createGraph()
    g.addNode('a'); g.addNode('b')
    g.addLink('a', 'b'); g.addLink('b', 'a')
    const q = evaluateQuality(g, { a: 0, b: 0 }, { quality: 'modularity' })
    expect(q).toBeCloseTo(0, 12)
  })
})
