import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

function makeWeightedSizeGraph() {
  // Two cliques of sizes 4 and 4 with one weak bridge; nodes in first clique have larger sizes.
  const g = createGraph()
  const A = [0,1,2,3], B = [4,5,6,7]
  A.concat(B).forEach(i => g.addNode(i, { size: A.includes(i) ? 5 : 1 }))
  for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]) }
  for (let i = 0; i < B.length; i++) for (let j = i+1; j < B.length; j++) { g.addLink(B[i], B[j]); g.addLink(B[j], B[i]) }
  g.addLink(3,4); g.addLink(4,3)
  return g
}

describe('CPM size-aware mode', () => {
  it('penalizes large-size communities more than unit mode', () => {
    const g = makeWeightedSizeGraph()
    const gamma = 0.5
    const unit = detectClusters(g, { quality: 'cpm', cpmMode: 'unit', resolution: gamma, randomSeed: 3 })
    const sized = detectClusters(g, { quality: 'cpm', cpmMode: 'size-aware', resolution: gamma, randomSeed: 3 })
    // With size-aware penalty, quality should be lower or equal (more penalty) for the same partition
    expect(sized.quality()).toBeLessThanOrEqual(unit.quality())
    // Both should still find 2 communities for this simple case
    const count = (cl) => new Set([0,1,2,3,4,5,6,7].map(i => cl.getClass(i))).size
    expect(count(unit)).toBe(2)
    expect(count(sized)).toBe(2)
  })
})
