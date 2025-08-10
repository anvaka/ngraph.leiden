import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const bin = path.resolve(__dirname, '../bin/ngraph-leiden.js')

describe('CLI basic', () => {
  it('reads DOT from stdin and prints membership', () => {
    const dot = 'graph { a -- b; b -- c; x -- y }\n'
    const res = spawnSync('node', [bin, '--format', 'dot', '--membership-only'], { input: dot, encoding: 'utf8' })
    expect(res.status).toBe(0)
    const m = JSON.parse(res.stdout)
    // Two components -> different community ids; ensure keys exist
    expect(m.a).toBeDefined()
    expect(m.b).toBeDefined()
    expect(m.c).toBeDefined()
    expect(m.x).toBeDefined()
  })

  it('reads JSON edges and writes to file', () => {
    const tmp = path.join(__dirname, 'tmp-membership.json')
    const edges = JSON.stringify([{ source: 'a', target: 'b' }, { source: 'c', target: 'd' }])
    const res = spawnSync('node', [bin, '--format', 'json', '--out', tmp], { input: edges, encoding: 'utf8' })
    expect(res.status).toBe(0)
    const data = JSON.parse(fs.readFileSync(tmp, 'utf8'))
    expect(data.membership).toBeDefined()
    fs.unlinkSync(tmp)
  })

  it('supports CSV output', () => {
    const dot = 'graph { a -- b; c -- d }\n'
    const res = spawnSync('node', [bin, '--format', 'dot', '--out-format', 'csv'], { input: dot, encoding: 'utf8' })
    expect(res.status).toBe(0)
    expect(res.stdout.split('\n')[0]).toBe('nodeId,communityId')
  })

  it('outputs DOT with community attributes', () => {
    const dot = 'graph { a -- b; c -- d }\n'
      const res = spawnSync('node', [bin, '--format', 'dot', '--out-format', 'dot'], { input: dot, encoding: 'utf8' })
      if (res.status !== 0 && (res.stderr || '').includes('DOT output requires ngraph.todot')) {
        // Skip in environments without ngraph.todot installed
        return;
      }
      expect(res.status).toBe(0)
      const out = res.stdout
      // Should be a directed dot and include community attributes for nodes
      expect(out).toContain('digraph G {')
      expect(out).toMatch(/"a"\s*\[community=/)
      expect(out).toMatch(/"b"\s*\[community=/)
  })

  it('evaluates quality for provided membership', () => {
    const dot = 'graph { a -- b; c -- d }\n'
    // Write temporary membership mapping
    const tmpM = path.join(__dirname, 'tmp-mem.json')
    fs.writeFileSync(tmpM, JSON.stringify({ a: 0, b: 0, c: 1, d: 1 }), 'utf8')
    const res = spawnSync('node', [bin, '--format', 'dot', '--evaluate', '--membership', tmpM], { input: dot, encoding: 'utf8' })
    fs.unlinkSync(tmpM)
    expect(res.status).toBe(0)
    expect(Number(res.stdout.trim())).toSatisfy(Number.isFinite)
  })
})
