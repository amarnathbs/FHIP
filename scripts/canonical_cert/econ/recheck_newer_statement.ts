/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * Negative control for the older-statement guard, live: a NEWER loan statement still updates the existing
 * liability's balance by default (recommended, pre-ticked, decision update_existing).
 *
 *   npx tsx scripts/canonical_cert/econ/recheck_newer_statement.ts --email E --liability-id L
 */
import { call, expect, results, saveEvidence } from './lib';
import { uploadLiabilityCsv, approveAndPropose, liabilityApplyRoute, rowsFor, userIdOf } from './flows';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const liabilityId = arg('--liability-id')!;

async function main() {
  const userId = await userIdOf(email);
  const before = (await rowsFor('liabilities', userId, 'id,balance', (q) => q.eq('id', liabilityId)))[0];
  const sep = await uploadLiabilityCsv(email, [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    '15/09/2026,Monthly Repayment B SEP,2000.00,Repayment,1550.00,430.00,20.00',
  ], {
    statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan',
    masked_identifier: 'xxxx5602', statement_period_start: '2026-09-01', statement_period_end: '2026-09-20', statement_date: '2026-09-20',
    opening_balance: '398450.00', closing_balance: '396900.00', interest_rate: '6.14',
  }, 'fhip-test-home-loan-sep-B.csv');
  const pp = await approveAndPropose(email, sep.documentId);
  const bal = pp.fields.find((f: any) => f.field_name === 'balance');
  const defaults = pp.fields.filter((f: any) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f: any) => f.field_name);
  const mode = pp.proposal.json?.data?.proposal?.recommended_apply_mode;
  expect(bal?.is_recommended === true && !bal?.requires_confirmation && defaults.includes('balance') && mode === 'update_existing', 'newer: a NEWER statement\'s balance is recommended and pre-ticked (update_existing)', { bal, defaults, mode });
  const ap = await call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'update_existing', owner: 'self' } });
  const after = (await rowsFor('liabilities', userId, 'id,balance', (q) => q.eq('id', liabilityId)))[0];
  expect(ap.status === 200 && Number(after.balance) === 396900, 'newer: the existing liability balance is UPDATED to the newer closing 396,900', { status: ap.status, before: before.balance, after: after.balance, applied: ap.json?.data?.applied_fields });
  saveEvidence('recheck_newer_statement_B', { before, after, proposal: pp.proposal.json, apply: ap.json, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
