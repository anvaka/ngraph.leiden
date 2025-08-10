import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

function makeTwoCliquesBridge() {
  const g = createGraph();
  const A = [0,1,2,3], B = [4,5,6,7]
  A.concat(B).forEach(i => g.addNode(i))
  // cliques
  for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]); }
  for (let i = 0; i < B.length; i++) for (let j = i+1; j < B.length; j++) { g.addLink(B[i], B[j]); g.addLink(B[j], B[i]); }
  // weak bridge
  g.addLink(3, 4); g.addLink(4, 3)
  return g
}

describe('detectClusters', () => {
  it('splits two cliques with a weak bridge', () => {
    const g = makeTwoCliquesBridge()
    const clusters = detectClusters(g, { randomSeed: 1 })
    const cA = new Set([0,1,2,3].map(i => clusters.getClass(i)))
    const cB = new Set([4,5,6,7].map(i => clusters.getClass(i)))
    expect(cA.size).toBe(1)
    expect(cB.size).toBe(1)
    expect([...cA][0]).not.toBe([...cB][0])
  })
})
