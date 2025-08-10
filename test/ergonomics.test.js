import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

function makeTwoCliques(n = 4) {
  const g = createGraph()
  const A = Array.from({length: n}, (_,i)=>'a'+i)
  const B = Array.from({length: n}, (_,i)=>'b'+i)
  for (const id of [...A, ...B]) g.addNode(id)
  for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]) }
  for (let i = 0; i < B.length; i++) for (let j = i+1; j < B.length; j++) { g.addLink(B[i], B[j]); g.addLink(B[j], B[i]) }
  // one weak bridge
  g.addLink(A[A.length-1], B[0]); g.addLink(B[0], A[A.length-1])
  return { g, A, B }
}

describe('ergonomics & constraints', () => {
  it('maxCommunitySize is enforced', () => {
    const { g, A, B } = makeTwoCliques(3)
    const clusters = detectClusters(g, { randomSeed: 123, maxCommunitySize: 3 })
    // Each clique has 3 nodes, so it should form its own community and not merge
    const cA = new Set(A.map(i => clusters.getClass(i)))
    const cB = new Set(B.map(i => clusters.getClass(i)))
    expect(cA.size).toBe(1)
    expect(cB.size).toBe(1)
    expect([...cA][0]).not.toBe([...cB][0])
  })

  it('deterministic with fixed seed even with random strategies', () => {
    const { g } = makeTwoCliques(4)
    const opts = { randomSeed: 2024, candidateStrategy: 'random-neighbor' }
    const a = detectClusters(g, opts)
    const b = detectClusters(g, opts)
    const classesA = new Map();
    const classesB = new Map();
    g.forEachNode(n => { classesA.set(n.id, a.getClass(n.id)); classesB.set(n.id, b.getClass(n.id)); })
    expect(JSON.stringify([...classesA.entries()].sort())).toBe(JSON.stringify([...classesB.entries()].sort()))
  })
})
