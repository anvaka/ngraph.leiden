#!/usr/bin/env node
/*
CLI for ngraph.leiden

Usage examples:
  npx ngraph.leiden --in graph.dot --format dot --out membership.json
  npx ngraph.leiden --in graph.json --format json --out membership.json
  cat graph.dot | npx ngraph.leiden --format dot

Outputs membership as JSON to stdout by default.
*/

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import fromdot from 'ngraph.fromdot';
import createGraph from 'ngraph.graph';
let detectClusters;
let evaluateQuality;

function printHelp() {
  const msg = `ngraph-leiden - Community detection (Leiden/Louvain) for ngraph graphs\n\n` +
    `Usage:\n` +
  `  ngraph-leiden --in <file> [--format dot|json] [options]\n` +
  `  cat file.dot | ngraph-leiden [--format dot|json] [options]\n\n` +
  `Input format is auto-detected by file extension (.dot/.gv/.json) or content; use --format to override.\n\n` +
    `Options:\n` +
  `  --in <file>           Input file path. If omitted, reads from stdin.\n` +
  `  --format <dot|json>   Override input format detection: 'dot' for Graphviz DOT, 'json' for simple edge list JSON.\n` +
    `  --out <file>          Write membership JSON to file instead of stdout.\n` +
    `  --out-format <json|csv|dot>  Output format. Default json.\n` +
    `  --directed            Treat graph as directed.\n` +
    `  --quality <q>         Quality function: modularity (default) or cpm.\n` +
    `  --resolution <r>      Resolution (gamma) for CPM. Default 1.0.\n` +
    `  --max-levels <n>      Max coarsening levels. Default 50.\n` +
    `  --max-local-passes <n> Max local passes per level. Default 20.\n` +
    `  --candidate-strategy <neighbors|all|random|random-neighbor>\n` +
    `  --max-community-size <num>  Upper bound on community total size.\n` +
    `  --random-seed <n>     Seed for RNG. Default 42.\n` +
    `  --allow-new-community Allow creating new singleton communities during local moves.\n` +
    `  --no-refine           Disable Leiden refinement phase.\n` +
    `  --fixed <file>        File with newline-separated node ids to keep fixed (level 0).\n` +
    `  --membership-only     Print only mapping { nodeId: communityId } without meta.\n` +
    `\nQuality and evaluation:\n` +
    `  --evaluate            Compute quality only (no community detection).\n` +
    `  --membership <file>   JSON file with membership mapping to use for evaluation or to emit with --out-format.\n` +
    `  -h, --help            Show this help.\n`;
  console.error(msg);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { args.help = true; continue; }
    if (a === '-v' || a === '--version') { args.version = true; continue; }
    if (a === '--in') { args.in = argv[++i]; continue; }
    if (a === '--format') { args.format = argv[++i]; continue; }
    if (a === '--out') { args.out = argv[++i]; continue; }
    if (a === '--out-format') { args.outFormat = argv[++i]; continue; }
    if (a === '--directed') { args.directed = true; continue; }
    if (a === '--quality') { args.quality = argv[++i]; continue; }
    if (a === '--resolution') { args.resolution = parseFloat(argv[++i]); continue; }
    if (a === '--max-levels') { args.maxLevels = parseInt(argv[++i], 10); continue; }
    if (a === '--max-local-passes') { args.maxLocalPasses = parseInt(argv[++i], 10); continue; }
    if (a === '--candidate-strategy') { args.candidateStrategy = argv[++i]; continue; }
    if (a === '--max-community-size') { args.maxCommunitySize = parseFloat(argv[++i]); continue; }
    if (a === '--random-seed') { args.randomSeed = parseInt(argv[++i], 10); continue; }
    if (a === '--allow-new-community') { args.allowNewCommunity = true; continue; }
    if (a === '--no-refine') { args.refine = false; continue; }
    if (a === '--fixed') { args.fixed = argv[++i]; continue; }
    if (a === '--membership-only') { args.membershipOnly = true; continue; }
    if (a === '--evaluate') { args.evaluate = true; continue; }
    if (a === '--membership') { args.membership = argv[++i]; continue; }
    if (a.startsWith('-')) { console.error('Unknown option:', a); args.bad = true; }
  }
  return args;
}

function readAllStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function buildGraphFromJSON(text) {
  // Accept either { nodes:[{id}], links:[{source, target, weight?}]} or [{source,target,weight?}] array
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('Failed to parse JSON input: ' + e.message); }
  const g = createGraph();
  function addNodeMaybe(id) { if (g.getNode(id) == null) g.addNode(id); }
  if (Array.isArray(data)) {
    for (const e of data) { addNodeMaybe(e.source); addNodeMaybe(e.target); g.addLink(e.source, e.target, { weight: e.weight ?? 1 }); }
  } else if (data && Array.isArray(data.links)) {
    if (Array.isArray(data.nodes)) { for (const n of data.nodes) addNodeMaybe(n.id); }
    for (const e of data.links) { addNodeMaybe(e.source); addNodeMaybe(e.target); g.addLink(e.source, e.target, { weight: e.weight ?? 1 }); }
  } else {
    throw new Error('Unsupported JSON shape. Expect an array of edges or an object with nodes/links.');
  }
  return g;
}

async function main() {
  // Resolve library entry: prefer src in repo; fallback to dist for published/npx
  const baseDir = path.dirname(new URL(import.meta.url).pathname)
  async function loadLib() {
    try {
      if (fs.existsSync(path.resolve(baseDir, '../src/index.js'))) {
        return await import('../src/index.js')
      }
    } catch { }
    try {
      return await import('../dist/ngraph-leiden.es.js')
    } catch (e) {
      console.error('Failed to load ngraph.leiden library:', e?.message || e)
      process.exit(1)
    }
  }
  const lib = await loadLib()
  detectClusters = lib.detectClusters
  evaluateQuality = lib.evaluateQuality
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }
  if (args.version) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../package.json'), 'utf8'))
      console.log(pkg.version)
    } catch {
      console.log('0.0.0')
    }
    process.exit(0)
  }
  // If no input file and no stdin piped, show help
  if (!args.in && process.stdin.isTTY) {
    console.error('Provide --in <file> or pipe data on stdin. Use --format to override autodetection.');
    printHelp();
    process.exit(1);
  }

  let inputText;
  if (args.in) {
    inputText = fs.readFileSync(path.resolve(process.cwd(), args.in), 'utf8');
    if (!args.format) {
      const ext = path.extname(args.in).toLowerCase();
      if (ext === '.dot' || ext === '.gv') args.format = 'dot';
      else if (ext === '.json') args.format = 'json';
      else args.format = sniffFormat(inputText);
    }
  } else {
    inputText = await readAllStdin();
    if (!args.format) {
      args.format = sniffFormat(inputText);
    }
  }
  const fmt = (args.format || 'dot').toLowerCase();
  let graph;
  if (fmt === 'dot') {
    graph = fromdot(inputText);
  } else if (fmt === 'json') {
    graph = buildGraphFromJSON(inputText);
  } else {
    console.error('Unknown --format:', fmt);
    process.exit(2);
  }

  // Membership input (optional)
  let inputMembership = null;
  if (args.membership) {
    const mText = fs.readFileSync(path.resolve(process.cwd(), args.membership), 'utf8');
    inputMembership = JSON.parse(mText);
  }

  let fixedNodes;
  if (args.fixed) {
    const txt = fs.readFileSync(path.resolve(process.cwd(), args.fixed), 'utf8');
    fixedNodes = txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  }

  // lib already loaded above

  // Evaluate-only path
  if (args.evaluate) {
    if (!inputMembership) {
      console.error('Evaluation requires --membership <file> with a JSON mapping of nodeId -> communityId.');
      process.exit(3);
    }
    const q = evaluateQuality(graph, inputMembership, {
      directed: !!args.directed,
      quality: args.quality || 'modularity',
      resolution: Number.isFinite(args.resolution) ? args.resolution : undefined
    });
    const out = String(q) + '\n';
    if (args.out) fs.writeFileSync(path.resolve(process.cwd(), args.out), out, 'utf8');
    else process.stdout.write(out);
    return;
  }

  // Detect communities
  const result = detectClusters(graph, {
    directed: !!args.directed,
    quality: args.quality || 'modularity',
    resolution: Number.isFinite(args.resolution) ? args.resolution : undefined,
    maxLevels: Number.isFinite(args.maxLevels) ? args.maxLevels : undefined,
    maxLocalPasses: Number.isFinite(args.maxLocalPasses) ? args.maxLocalPasses : undefined,
    candidateStrategy: args.candidateStrategy,
    maxCommunitySize: Number.isFinite(args.maxCommunitySize) ? args.maxCommunitySize : undefined,
    randomSeed: Number.isFinite(args.randomSeed) ? args.randomSeed : undefined,
    allowNewCommunity: !!args.allowNewCommunity,
    refine: args.refine !== false,
    fixedNodes
  });

  // If user supplied an input membership for reformatting, prefer that membership; otherwise use detection
  const membership = inputMembership || result.toJSON().membership;
  const meta = inputMembership ? { quality: evaluateQuality?.(graph, inputMembership, { directed: !!args.directed, quality: args.quality || 'modularity', resolution: args.resolution }) } : result.toJSON().meta;

  // Decide output format
  const outFmt = (args.outFormat || 'json').toLowerCase();
  let output;
  if (outFmt === 'json') {
    output = args.membershipOnly ? JSON.stringify(membership, null, 2) : JSON.stringify({ membership, meta }, null, 2);
  } else if (outFmt === 'csv') {
    // nodeId,communityId
    const lines = ['nodeId,communityId'];
    for (const id of Object.keys(membership)) lines.push(`${escapeCsv(id)},${escapeCsv(membership[id])}`);
    output = lines.join('\n');
  } else if (outFmt === 'dot') {
    // Emit DOT and add a community attribute per node via node.data overlay
    let toDotFn;
    try {
      ({ default: toDotFn } = await import('ngraph.todot'))
    } catch (e) {
      console.error('DOT output requires ngraph.todot to be installed.');
      process.exit(5);
    }
    const gWithComm = overlayNodeData(graph, membership);
  output = toDotFn(gWithComm);
  // Some versions of ngraph.todot stringify attribute keys, producing ["community"=...].
  // Normalize to unquoted attribute key to satisfy Graphviz syntax and tests: [community=...]
  // Only touch the 'community' key to avoid altering user data unexpectedly.
  output = output.replace(/\[\s*"community"\s*=\s*/g, '[community=');
  } else {
    console.error('Unknown --out-format:', outFmt);
    process.exit(4);
  }

  if (args.out) {
    fs.writeFileSync(path.resolve(process.cwd(), args.out), output + (outFmt === 'json' ? '\n' : ''), 'utf8');
  } else {
    process.stdout.write(output + (outFmt === 'json' ? '\n' : '\n'));
  }
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});

function escapeCsv(v) {
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replaceAll('"', '""') + '"';
  return s;
}

function overlayNodeData(graph, membership) {
  if (!membership) return graph;
  return {
    forEachLink(cb) { return graph.forEachLink(cb); },
    forEachNode(cb) {
      return graph.forEachNode(node => {
        const comm = membership[node.id];
        if (comm == null) return cb(node);
        const orig = node.data;
        let data;
        if (orig && typeof orig === 'object') data = { ...orig, community: String(comm) };
        else data = { community: String(comm) };
        cb({ id: node.id, data });
      });
    },
    getLinks(id) { return graph.getLinks(id); }
  };
}

function sniffFormat(text) {
  // Try quick JSON parse if it looks like JSON; otherwise check DOT keywords; default to 'dot'
  const t = String(text).trimStart();
  const first = t[0];
  if (first === '{' || first === '[') {
    try {
      JSON.parse(t);
      return 'json';
    } catch { /* fall through */ }
  }
  if (/^(strict\s+)?(di)?graph\b/i.test(t)) return 'dot';
  // Heuristic: if it contains semicolons and braces typical for DOT
  if (t.includes('{') && t.includes('}') && /;\s*$/m.test(t)) return 'dot';
  // Default
  return 'json';
}
