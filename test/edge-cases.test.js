import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

describe('edge cases', () => {
  it('keeps isolated node as its own community', () => {
    const g = createGraph()
    g.addNode('x')
    g.addNode('y')
    g.addNode('z') // isolated
    g.addLink('x', 'y'); g.addLink('y', 'x')

    const clusters = detectClusters(g, { randomSeed: 123 })
    const cx = clusters.getClass('x')
    const cy = clusters.getClass('y')
    const cz = clusters.getClass('z')
    expect(cx).toBe(cy)
    expect(cz).not.toBe(cx)
  })

  it('handles negative weights and preserves intuitive split', () => {
    // Two cliques with negative-weight bridge between them
    const g = createGraph()
    const A = ['a1','a2','a3','a4']
    const B = ['b1','b2','b3','b4']
    for (const id of [...A, ...B]) g.addNode(id)
    for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]) }
    for (let i = 0; i < B.length; i++) for (let j = i+1; j < B.length; j++) { g.addLink(B[i], B[j]); g.addLink(B[j], B[i]) }
    // negative bridges
    g.addLink('a4','b1', { weight: -2 }); g.addLink('b1','a4', { weight: -2 })
    g.addLink('a3','b2', { weight: -1 }); g.addLink('b2','a3', { weight: -1 })

    const clusters = detectClusters(g, { randomSeed: 7 })
    const cA = new Set(A.map(i => clusters.getClass(i)))
    const cB = new Set(B.map(i => clusters.getClass(i)))
    expect(cA.size).toBe(1)
    expect(cB.size).toBe(1)
    expect([...cA][0]).not.toBe([...cB][0])
  })

  it('self-loop biases node to remain separate under weak external ties (CPM)', () => {
    const g = createGraph()
    g.addNode('a'); g.addNode('b')
    // strong self-loop on a
    g.addLink('a','a', { weight: 5 })
    // weak a<->b ties
    g.addLink('a','b', { weight: 0.1 }); g.addLink('b','a', { weight: 0.1 })

  const clusters = detectClusters(g, { randomSeed: 5, quality: 'cpm', resolution: 1.0 })
    const ca = clusters.getClass('a')
    const cb = clusters.getClass('b')
    expect(ca).not.toBe(cb)
  })

  it('treats a disconnected clique as its own isolated community', () => {
    // Component A: a 3-node clique; Component B: a single connected pair
    const g = createGraph()
    const A = ['a1','a2','a3']
    const B = ['b1','b2']
    for (const id of [...A, ...B]) g.addNode(id)
    // clique A
    for (let i = 0; i < A.length; i++) for (let j = i+1; j < A.length; j++) { g.addLink(A[i], A[j]); g.addLink(A[j], A[i]) }
    // pair B
    g.addLink('b1','b2'); g.addLink('b2','b1')

    const clusters = detectClusters(g, { randomSeed: 321 })
    const cA = new Set(A.map(i => clusters.getClass(i)))
    const cB = new Set(B.map(i => clusters.getClass(i)))
    expect(cA.size).toBe(1)
    expect(cB.size).toBe(1)
    expect([...cA][0]).not.toBe([...cB][0])
  })
})
