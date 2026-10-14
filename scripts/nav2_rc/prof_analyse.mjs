// Aggregates a .cpuprofile (node --cpu-prof) into the top self-time functions and the top inclusive-time functions inside this repository.
//   node scripts/nav2_rc/prof_analyse.mjs <file.cpuprofile> [top]
import fs from 'node:fs';
const [file, topArg] = process.argv.slice(2);
const top = Number(topArg ?? 25);
const p = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(p.nodes.map((n) => [n.id, n]));
const self = new Map();
const dt = p.timeDeltas;
for (let i = 0; i < p.samples.length; i++) self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + (dt[i] ?? 0));
const label = (n) => `${n.callFrame.functionName || '(anon)'} ${String(n.callFrame.url).replace(/^.*[\\/](lib|app|components|scripts|node_modules)[\\/]/, '$1/')}:${n.callFrame.lineNumber + 1}`;
const bySelf = new Map();
for (const [id, t] of self) bySelf.set(label(nodes.get(id)), (bySelf.get(label(nodes.get(id))) ?? 0) + t);
const total = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`total sampled ${(total / 1000).toFixed(0)} ms`);
console.log('--- top self time');
for (const [k, v] of [...bySelf].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000).toFixed(0).padStart(7)} ms  ${k}`);
// inclusive time per function (children included) for repository code only
const incl = new Map();
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
for (const [id, t] of self) {
  const seen = new Set();
  for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
    const l = label(nodes.get(cur));
    if (seen.has(l)) continue;
    seen.add(l);
    if (/lib\/|app\/|components\//.test(l)) incl.set(l, (incl.get(l) ?? 0) + t);
  }
}
console.log('--- top inclusive time (repository code)');
for (const [k, v] of [...incl].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`${(v / 1000).toFixed(0).padStart(7)} ms  ${k}`);
