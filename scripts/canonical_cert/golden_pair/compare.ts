/**
 * Golden pair: leaf-by-leaf comparison of two measure files (every consumer response, every field).
 *
 *   npx tsx scripts/canonical_cert/golden_pair/compare.ts --a M --b I [--routes dashboard,health] [--all]
 *
 * Identity / clock leaves (ids, *_at timestamps, run ids, generated dates, timings) are listed separately
 * as "non-economic" and never hidden: pass --all to print them too. Every other differing leaf is printed
 * as a VARIANCE with both values and the numeric difference.
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const load = (l: string) => JSON.parse(fs.readFileSync(path.resolve('.canonical-cert', 'gp', `measure-${l}.json`), 'utf8')).out as Record<string, { status: number; json: unknown }>;

/** Leaves whose values are identities or clocks, not economics. */
export const NON_ECONOMIC = /(^|\.)(id|[a-z_]*_id|[a-zA-Z]*Id|ids|[a-z_]*_ids|[a-z_]*_at|[a-zA-Z]*At|generatedAt|computedAt|calculatedAt|asOf|as_of|as_of_date|snapshot_date|run_id|runId|reportId|version|ms|created|updated|timestamp|date|payload_hash|hash|trace_id|request_id|expires_at|cache_key)$/;

export function flatten(v: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (v === null || typeof v !== 'object') { out[prefix] = v; return out; }
  if (Array.isArray(v)) { if (v.length === 0) out[prefix] = '[]'; v.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out)); return out; }
  const e = Object.entries(v as Record<string, unknown>);
  if (e.length === 0) out[prefix] = '{}';
  for (const [k, x] of e) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

export function compareMeasures(a: Record<string, { status: number; json: unknown }>, b: Record<string, { status: number; json: unknown }>, only?: string[]) {
  const variances: { route: string; path: string; a: unknown; b: unknown; diff: number | null }[] = [];
  const nonEconomic: { route: string; path: string; a: unknown; b: unknown }[] = [];
  const routes = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((r) => !only || only.some((o) => r.includes(o)));
  for (const r of routes) {
    if (!a[r] || !b[r]) { variances.push({ route: r, path: '(route)', a: a[r]?.status ?? 'absent', b: b[r]?.status ?? 'absent', diff: null }); continue; }
    if (a[r].status !== b[r].status) variances.push({ route: r, path: '(status)', a: a[r].status, b: b[r].status, diff: null });
    const fa = flatten(a[r].json); const fb = flatten(b[r].json);
    for (const p of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      const va = fa[p]; const vb = fb[p];
      if (JSON.stringify(va) === JSON.stringify(vb)) continue;
      const leaf = p.replace(/\[\d+\]/g, '');
      if (NON_ECONOMIC.test(leaf)) { nonEconomic.push({ route: r, path: p, a: va, b: vb }); continue; }
      const diff = typeof va === 'number' && typeof vb === 'number' ? Math.round((vb - va) * 1e6) / 1e6 : null;
      variances.push({ route: r, path: p, a: va, b: vb, diff });
    }
  }
  return { variances, nonEconomic };
}

if (process.argv[1] && process.argv[1].endsWith('compare.ts')) {
  const A = arg('--a')!; const B = arg('--b')!;
  const only = arg('--routes')?.split(',');
  const { variances, nonEconomic } = compareMeasures(load(A), load(B), only);
  console.log(`${A} vs ${B}: ${variances.length} differing economic/descriptive leaves, ${nonEconomic.length} identity/clock leaves`);
  for (const v of variances) console.log(`VAR  ${v.route} :: ${v.path}  ${A}=${JSON.stringify(v.a)?.slice(0, 120)}  ${B}=${JSON.stringify(v.b)?.slice(0, 120)}${v.diff !== null ? `  diff=${v.diff}` : ''}`);
  if (args.includes('--all')) for (const v of nonEconomic) console.log(`ID   ${v.route} :: ${v.path}  ${JSON.stringify(v.a)?.slice(0, 80)} | ${JSON.stringify(v.b)?.slice(0, 80)}`);
}
