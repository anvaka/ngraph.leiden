import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

// Chain of 3 cliques connected by single edges; Leiden refinement should not merge all into one
function makeChainCliques() {
  const g = createGraph()
  const groups = [Array.from({length:5}, (_,i)=>i), Array.from({length:5}, (_,i)=>i+5), Array.from({length:5}, (_,i)=>i+10)]
  for (const group of groups) group.forEach(v => g.addNode(v))
  for (const group of groups) {
    for (let i = 0; i < group.length; i++) for (let j = i+1; j < group.length; j++) {
      g.addLink(group[i], group[j]); g.addLink(group[j], group[i])
    }
  }
  // single bridges
  g.addLink(4,5); g.addLink(5,4)
  g.addLink(9,10); g.addLink(10,9)
  return g
}

describe('refinement', () => {
  it('keeps cliques separated across refinement', () => {
    const g = makeChainCliques()
    const clusters = detectClusters(g, { randomSeed: 1, refine: true })
    const c0 = new Set([0,1,2,3,4].map(i => clusters.getClass(i)))
    const c1 = new Set([5,6,7,8,9].map(i => clusters.getClass(i)))
    const c2 = new Set([10,11,12,13,14].map(i => clusters.getClass(i)))
    expect(c0.size).toBe(1)
    expect(c1.size).toBe(1)
    expect(c2.size).toBe(1)
    expect([...c0][0]).not.toBe([...c1][0])
    expect([...c1][0]).not.toBe([...c2][0])
  })
})
