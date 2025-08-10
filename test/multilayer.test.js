import { describe, it, expect } from 'vitest'
import createGraph from 'ngraph.graph'
import { detectClusters } from '../src/index.js'

describe('multilayer', () => {
  it('aggregation yields correct communities', () => {
  // Two layers: strong signal in layer 1, weak noisy links in layer 2
  const idsA = ['a1','a2','a3','a4'];
  const idsB = ['b1','b2','b3','b4'];
  const layer1 = createGraph();
  [...idsA, ...idsB].forEach(id => layer1.addNode(id));
  // strong cliques in layer1
  for (let i = 0; i < idsA.length; i++) for (let j = i+1; j < idsA.length; j++) { layer1.addLink(idsA[i], idsA[j]); layer1.addLink(idsA[j], idsA[i]); }
  for (let i = 0; i < idsB.length; i++) for (let j = i+1; j < idsB.length; j++) { layer1.addLink(idsB[i], idsB[j]); layer1.addLink(idsB[j], idsB[i]); }
  // single weak bridge
  layer1.addLink('a1','b1'); layer1.addLink('b1','a1');

  const layer2 = createGraph();
  [...idsA, ...idsB].forEach(id => layer2.addNode(id));
  // layer2 adds some random noise across groups
  layer2.addLink('a2','b2'); layer2.addLink('b2','a2');
  layer2.addLink('a3','b3'); layer2.addLink('b3','a3');

  const result = detectClusters([
    { graph: layer1, weight: 1.0 },
    { graph: layer2, weight: 0.2 }
  ], { quality: 'modularity', directed: false, refine: true, randomSeed: 7 });

  const comms = result.getCommunities();
  // Expect 2 communities and that they respect clique structure despite noise
  expect(comms.size).toBe(2);
  const groups = [...comms.values()].map(arr => new Set(arr));
  const groupFor = (id) => groups.find(g => g.has(id));
  expect(groupFor('a1')).toBe(groupFor('a4'));
  expect(groupFor('b1')).toBe(groupFor('b4'));
  expect(groupFor('a1')).not.toBe(groupFor('b1'));
  });
});
