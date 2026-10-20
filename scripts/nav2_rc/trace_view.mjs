import fs from 'node:fs';
const L = JSON.parse(fs.readFileSync('test-artifacts/nav2_rc/trace_post.json', 'utf8'));
// group into runs of the same path that overlap or follow each other closely
const out = [];
for (const x of L) {
  const last = out[out.length - 1];
  const name = x.p.replace('/rest/v1/', '');
  if (last && last.name === name && x.start - (last.start + last.span) < 150) { last.n++; last.span = Math.max(last.span, x.start + x.ms - last.start); last.max = Math.max(last.max, x.ms); }
  else out.push({ name, start: x.start, span: x.ms, n: 1, max: x.ms });
}
for (const o of out) console.log(`${String(o.start).padStart(6)} ms  +${String(o.span).padStart(5)}  x${String(o.n).padStart(3)}  ${o.name}`);
