/**
 * Collects every .canonical-cert/obu-*-results.json written by the DEV certification journeys into one JSON summary per spec step.
 *   node scripts/canonical_cert/final/obu_collect_results.mjs [--md]
 * Counts only; the per-step prose and evidence labels live in docs/ownership/DEV_CERT_STEP_RESULTS_06-10-2026.md.
 */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('.canonical-cert');
const files = fs.readdirSync(dir).filter((f) => /^obu-.*-results\.json$/.test(f) && !/updated-scripts/.test(f));
const by = {};
for (const f of files) {
  for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
    const k = String(r.step ?? r.label?.slice(0, 3) ?? '?');
    by[k] ??= { pass: 0, fail: 0, info: 0, files: new Set(), fails: [] };
    if (r.ok === true) by[k].pass += 1; else if (r.ok === false) { by[k].fail += 1; by[k].fails.push(r.label); } else by[k].info += 1;
    by[k].files.add(f.replace(/^obu-|-results\.json$/g, ''));
  }
}
const rows = Object.entries(by).sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true }));
if (process.argv.includes('--md')) {
  console.log('| Step | PASS | FAIL | INFO | Journeys |\n|---|---|---|---|---|');
  for (const [k, v] of rows) console.log(`| ${k} | ${v.pass} | ${v.fail} | ${v.info} | ${[...v.files].join(', ')} |`);
} else {
  console.log(JSON.stringify(Object.fromEntries(rows.map(([k, v]) => [k, { ...v, files: [...v.files] }])), null, 2));
}
