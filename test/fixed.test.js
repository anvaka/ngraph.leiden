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

describe('fixed nodes', () => {
  it('does not force fixed nodes to leave their clique communities', () => {
    const g = makeTwoCliquesBridge()
    const fixedRun = detectClusters(g, { randomSeed: 11, refine: true, fixedNodes: new Set([3,4]) })
    const c3 = fixedRun.getClass(3)
    const c4 = fixedRun.getClass(4)
    // Node 3 should be grouped with its clique {0,1,2,3} and not with node 4's clique
    expect(fixedRun.getClass(0)).toBe(c3)
    expect(fixedRun.getClass(1)).toBe(c3)
    expect(fixedRun.getClass(2)).toBe(c3)
    expect(fixedRun.getClass(4)).not.toBe(c3)
    // Node 4 should be grouped with {4,5,6,7}
    expect(fixedRun.getClass(5)).toBe(c4)
    expect(fixedRun.getClass(6)).toBe(c4)
    expect(fixedRun.getClass(7)).toBe(c4)
  })
})
