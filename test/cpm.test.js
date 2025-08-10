import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

function makeTwoCliquesBridge() {
  const g = createGraph()
  const A = [0,1,2,3], B = [4,5,6,7]
  A.concat(B).forEach(i => g.addNode(i))
  for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]) }
  for (let i = 0; i < B.length; i++) for (let j = i+1; j < B.length; j++) { g.addLink(B[i], B[j]); g.addLink(B[j], B[i]) }
  g.addLink(3,4); g.addLink(4,3)
  return g
}

describe('CPM resolution tuning', () => {
  it('splits more with higher gamma', () => {
    const g = makeTwoCliquesBridge()
    const low = detectClusters(g, { quality: 'cpm', resolution: 0.01, randomSeed: 1 })
    const high = detectClusters(g, { quality: 'cpm', resolution: 10.0, randomSeed: 1 })
    const countCommunities = (clusters) => new Set([...Array(8).keys()].map(i => clusters.getClass(i))).size
    expect(countCommunities(low)).toBeLessThanOrEqual(countCommunities(high))
  })
})
