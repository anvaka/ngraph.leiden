import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

// Two strongly connected subgraphs with one-way weak link A->B
function makeDirected() {
  const g = createGraph()
  const A = [0,1,2], B = [3,4,5]
  A.concat(B).forEach(i => g.addNode(i))
  // dense inside each group (directed)
  for (let i = 0; i < A.length; i++) for (let j = 0; j < A.length; j++) if (i !== j) g.addLink(A[i], A[j])
  for (let i = 0; i < B.length; i++) for (let j = 0; j < B.length; j++) if (i !== j) g.addLink(B[i], B[j])
  // weak one-way bridge
  g.addLink(2,3)
  return g
}

describe('directed modularity', () => {
  it('finds two communities in directed case', () => {
    const g = makeDirected()
    const clusters = detectClusters(g, { directed: true, randomSeed: 2 })
    const cA = new Set([0,1,2].map(i => clusters.getClass(i)))
    const cB = new Set([3,4,5].map(i => clusters.getClass(i)))
    expect(cA.size).toBe(1)
    expect(cB.size).toBe(1)
    expect([...cA][0]).not.toBe([...cB][0])
  })
})
