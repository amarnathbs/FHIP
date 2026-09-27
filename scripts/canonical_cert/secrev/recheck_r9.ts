/**
 * Re-measures the scenario_sell_override.ts household after the rule-9 residual fix (same DEV rows,
 * localhost app running this branch). Oracle: counted income moved by +400 (the dividend) only.
 *   CERT_PORT=3974 npx tsx scripts/canonical_cert/secrev/recheck_r9.ts --email E [--salt D]
 */
import fs from 'node:fs';
import path from 'node:path';
import { measure, delta, expect, results, OUT_DIR, saveEvidence } from './lib';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const salt = arg('--salt') ?? 'D';
async function main() {
  const prior = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `secrev_scenario_${salt}.json`), 'utf8'));
  const m0 = prior.evidence.m0;
  const m2 = await measure(email);
  const dIncome = delta(m0, m2, 'income.countedMonthly');
  const dGross = delta(m0, m2, 'dashboard.grossMonthlyIncome');
  expect(dIncome === 400, 'R9 after fix: SELL 15,000 (filed as Income before the broker statement was approved) -> income 0; only the 400 dividend counts', { dCountedMonthly: dIncome, dDashboardGross: dGross, before: prior.evidence.deltas });
  saveEvidence(`secrev_recheck_r9_${salt}`, { m2, dIncome, dGross, results });
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
