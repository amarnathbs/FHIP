/* eslint-disable @typescript-eslint/no-explicit-any -- certification harness: untyped JSON route responses */
/**
 * Live re-check of the older-statement guard (after the fix): an OLDER loan statement than the one already
 * applied is proposed with its figures unticked and decision keep_existing; applying the panel's defaults
 * leaves the balance unchanged while the statement's activity is still recorded in the ledger.
 *
 *   npx tsx scripts/canonical_cert/econ/recheck_older_statement.ts --email E --liability-id L
 */
import { call, expect, results, saveEvidence } from './lib';
import { uploadLiabilityCsv, approveAndPropose, liabilityApplyRoute, rowsFor, userIdOf } from './flows';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const email = arg('--email')!;
const liabilityId = arg('--liability-id')!;
const salt = arg('--salt') ?? 'B';

async function main() {
  const userId = await userIdOf(email);
  const before = (await rowsFor('liabilities', userId, 'id,balance,due_date,updated_at', (q) => q.eq('id', liabilityId)))[0];
  const txBefore = await rowsFor('fdh_transactions', userId, 'id');
  const jun = await uploadLiabilityCsv(email, [
    'Payment Date,Description,Amount,Type,Principal,Interest,Fee',
    `15/06/2026,Monthly Repayment ${salt} JUN,2000.00,Repayment,1550.00,430.00,20.00`,
  ], {
    statement_type: 'loan', country_code: 'AU', currency_code: 'AUD', institution_name: 'FHIP Test Home Loan',
    masked_identifier: 'xxxx5602', statement_period_start: '2026-06-01', statement_period_end: '2026-06-30', statement_date: '2026-06-30',
    opening_balance: '396550.00', closing_balance: '395000.00', interest_rate: '6.14',
  }, `fhip-test-home-loan-jun-${salt}.csv`);
  const pp = await approveAndPropose(email, jun.documentId);
  const bal = pp.fields.find((f: any) => f.field_name === 'balance');
  const defaults = pp.fields.filter((f: any) => f.is_recommended && !f.requires_confirmation && f.proposed_value !== f.existing_value).map((f: any) => f.field_name);
  const mode = pp.proposal.json?.data?.proposal?.recommended_apply_mode;
  expect(pp.proposal.json?.data?.proposal?.target_entity_id === liabilityId, 'recheck: the June statement targets the same loan', pp.proposal.json?.data?.proposal?.target_entity_id);
  expect(bal && !bal.is_recommended && bal.requires_confirmation && bal.reason_code === 'statement_older_than_last_applied', 'recheck: OLDER statement balance offered but not recommended (confirmation required)', bal);
  expect(defaults.length === 0 && mode === 'keep_existing', 'recheck: panel pre-selects nothing and the recommended decision is keep_existing', { defaults, mode });
  const ap = await call(email, 'POST', liabilityApplyRoute(pp.proposalId!), { json: { decision: 'keep_existing', owner: 'self' } });
  const after = (await rowsFor('liabilities', userId, 'id,balance,due_date', (q) => q.eq('id', liabilityId)))[0];
  const txAfter = await rowsFor('fdh_transactions', userId, 'id');
  expect(ap.status === 200 && Number(after.balance) === Number(before.balance), `recheck: keep_existing Apply leaves the balance at ${before.balance}`, { status: ap.status, outcome: ap.json?.data?.outcome, before: before.balance, after: after.balance });
  expect(txAfter.length - txBefore.length === 1, 'recheck: the June repayment is still recorded in the ledger (1 facility row)', { newTx: txAfter.length - txBefore.length, ledger: ap.json?.data?.ledger });
  // auto-select path: update_existing with no fields must refuse rather than regress
  saveEvidence(`recheck_older_statement_${salt}`, { before, after, proposal: pp.proposal.json, apply: ap.json, results });
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
