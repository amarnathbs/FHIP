/* eslint-disable @typescript-eslint/no-explicit-any -- DEV-only journey script around the parser's loosely typed output */
// NAV2 release candidate: builds ONE synthetic genuine-format CAMS statement that holds `n` funds: the four standing funds with stored history (A, B, D, E) plus the
// first n-4 candidates of test-artifacts/nav2_rc/candidate_funds.json (funds with NO stored history on DEV). Every NAV is AMFI's published NAV (mfapi.in) for the
// purchase date. Investor and PAN are synthetic (never-real PCQAL prefix), folios start NAV2RC-.
//   npx tsx scripts/nav2_rc/build_big_statement.ts 30
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildStatement, FUNDS, type StatementSpec } from '../nav2_stage3/build_statements';

async function main() {
  const n = Number(process.argv[2] ?? 30);
  const { db } = await import('../nav2_stage3/_lib.mjs');
  const cand = JSON.parse(readFileSync(join(process.cwd(), 'test-artifacts', 'nav2_rc', 'candidate_funds.json'), 'utf8')) as Array<{ instrumentId: string; name: string; amc: string; isin: string; amfi: string }>;
  const seen = new Set<string>();
  const unique = cand.filter((c) => (seen.has(c.instrumentId) ? false : (seen.add(c.instrumentId), true)));
  const extra = unique.slice(0, Math.max(0, n - 4));
  const schemes: StatementSpec['schemes'] = [];
  let k = 0;
  for (const key of ['A', 'B', 'D', 'E']) schemes.push({ fund: key, folio: `NAV2RC-F${String(++k).padStart(2, '0')}`, txns: [{ date: '2024-04-10', type: 'purchase', amount: 25000 }] });
  extra.forEach((c, i) => {
    const key = `R${String(i + 1).padStart(2, '0')}`;
    (FUNDS as any)[key] = { key, instrumentId: c.instrumentId, amc: c.amc, name: c.name, isin: c.isin, amfi: c.amfi };
    schemes.push({ fund: key, folio: `NAV2RC-F${String(++k).padStart(2, '0')}`, txns: [{ date: '2024-04-10', type: 'purchase', amount: 25000 }] });
  });
  const spec: StatementSpec = { id: `nav2rc-big-${schemes.length}`, tag: 'NAV2RC', investor: 'NAV TWO RC BIGHOLDER', pan: 'PCQAL1201B', period: { from: '2024-01-01', to: '2026-10-13' }, schemes };
  const out = join(process.cwd(), 'test-artifacts', 'nav2_stage3', 'statements');
  const e = await buildStatement(db, spec, out);
  console.log(spec.id, `${e.schemes.length} funds`, e.schemes.slice(0, 3).map((x: any) => `${x.fund} ${x.closingUnits}`).join(' | '));
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
