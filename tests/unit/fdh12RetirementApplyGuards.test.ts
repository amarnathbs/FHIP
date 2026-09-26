/**
 * WP-13 -- Retirement Apply guards (migration 0211) and the economic oracles.
 *
 *   X-01 / GAP-RET-01  "Update existing" with contributions UNTICKED leaves
 *                      employer_contribution unchanged.
 *   GAP-RET-02 / D-12  An annual statement's $12,000 SG never becomes
 *                      $12,000/MONTH: proposed annualised, 'annually', paired.
 *   GAP-RET-06         An older statement's balance is not recommended.
 *   GAP-RET-09         A forged approved INSERT is refused.
 *   GAP-RET-07         The $500 personal contribution oracle: household
 *                      expense 0 once the user confirms the bank leg.
 *   neutrality         Rollover A -> B: income / expense / net worth deltas 0;
 *                      holdings never summed into Net Worth; SMSF refused.
 *   GAP-RET-11         MEMBER_MISMATCH is a 409 refusal, not WRITE_FAILED/400.
 *
 * The database claims are proven on REAL Postgres by
 * scripts/fdh12_0211_pglite_verification.mjs (the real migration chain, the
 * predecessor's defects demonstrated BEFORE 0211, then fixed AFTER, then a
 * no-op re-apply); this file runs it and feeds the resulting rows into the
 * canonical read models. Negative controls: see the WP-13 report -- every
 * describe below fails on feature/canonical-upload-foundation @ f79374f.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ rpc: async () => rpcMock.result }),
}));

import {
  annualisePeriodTotal,
  restateRate,
  retirementAdapter,
  statementPeriodMonths,
  type ExistingRetirementRow,
  type RetirementEvidence,
} from '@/lib/import-bridge/adapters/retirementAdapter';
import { applyRetirementProposalAtomic, RETIREMENT_APPLY_REFUSAL_CODES } from '@/lib/import-bridge/applyRetirementProposalAtomic';
import { loadDashboard } from '@/lib/services/dashboardData';
import { selectRetirement } from '@/lib/read-models/retirement';
import { selectExpenses } from '@/lib/read-models/expenses';
import { explicitWindow } from '@/lib/read-models/core/window';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { account, profile, statement, tables, taxonomy, txn, USER } from './readModels/helpers/fixtures';

const ROOT = path.resolve(__dirname, '..', '..');
const MIG = path.join(ROOT, 'supabase', 'migrations');
const FILES = fs.readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const read = (f: string) => fs.readFileSync(path.join(MIG, f), 'utf8');
const SQL_0211 = read('0211_fdh12_retirement_apply_guards.sql');
const noComments = (s: string) => s.replace(/--.*$/gm, '');
const squash = (s: string) => noComments(s).replace(/\s+/g, ' ').trim();

/** The body of the LAST `create or replace function <name>` in a migration. */
function fnBody(sql: string, name: string): string {
  const src = noComments(sql);
  const start = src.lastIndexOf(`create or replace function ${name}`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf('$$ language plpgsql', start);
  return src.slice(start, end);
}
const columnsCompared = (body: string) => [...body.matchAll(/new\.(\w+) is distinct from old\.\1/g)].map((m) => m[1]);

// ===========================================================================
describe('0211 is derived from the migration LEDGER, not assumed', () => {
  it('fdh12_apply_retirement_proposal is defined by exactly 0112 -> 0119 -> 0211, and 0211 is the latest', () => {
    const definers = FILES.filter((f) => /create or replace function fdh12_apply_retirement_proposal\(/.test(noComments(read(f))));
    expect(definers.map((f) => f.slice(0, 4))).toEqual(['0112', '0119', '0211']);
  });

  it('carries the predecessor (0119) verbatim where it must: SMSF refusal, MEMBER_MISMATCH, allow-list, staleness, CAS claim, provenance', () => {
    const prev = squash(fnBody(read('0119_fdh15_retirement_member_mismatch_guard.sql'), 'fdh12_apply_retirement_proposal'));
    const next = squash(fnBody(SQL_0211, 'fdh12_apply_retirement_proposal'));
    const verbatim = [
      /select \(v_account\.master_item_key = 'smsf'\).*?SMSF_ACCOUNT_NOT_IMPORTABLE.*?end if;/,
      /if v_member_id is not null and v_account\.retirement_member_id is not null.*?MEMBER_MISMATCH.*?end if;/,
      /v_allowed constant text\[\] := array\[.*?\];/,
      /if v_live_text is distinct from v_field\.existing_value then.*?STALE_PROPOSAL.*?end if;/,
      /update fhip_import_proposals set status = 'applied', applied_at = now\(\) where id = p_proposal_id and status = 'ready';/,
      /update retirement_accounts set source_type = 'retirement_statement_import',.*?where id = v_target_id and user_id = v_uid;/,
    ];
    for (const re of verbatim) {
      const a = prev.match(re)?.[0];
      expect(a, `${re} missing from 0119`).toBeTruthy();
      expect(next, `${re} not carried verbatim`).toContain(a!);
    }
  });

  it('X-01: the NULL-selection default is recommended AND confirmation-free, never "every field"', () => {
    const prev = squash(fnBody(read('0119_fdh15_retirement_member_mismatch_guard.sql'), 'fdh12_apply_retirement_proposal'));
    const next = squash(fnBody(SQL_0211, 'fdh12_apply_retirement_proposal'));
    expect(prev).toContain('select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;');
    expect(next).toContain('select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id and is_recommended and not requires_confirmation;');
    expect(next).not.toContain('select array_agg(field_name) into v_selected from fhip_import_proposal_fields where proposal_id = p_proposal_id;');
  });

  it('the UPDATE guards are strict supersets of their predecessors (0113 statements, 0112 activities)', () => {
    const stPrev = columnsCompared(fnBody(read('0113_fdh12_approve_rpc_authoritative_write_fix.sql'), 'fdh12_retirement_statements_assert_authoritative_write'));
    const stNext = columnsCompared(fnBody(SQL_0211, 'fdh12_retirement_statements_assert_authoritative_write'));
    expect(stPrev.length).toBe(38);
    expect(stPrev.every((c) => stNext.includes(c))).toBe(true);
    expect(stNext.filter((c) => !stPrev.includes(c))).toEqual(['extraction_warnings']);
    const acPrev = columnsCompared(fnBody(read('0112_fdh12_retirement_statement_intelligence.sql'), 'fdh12_retirement_activities_assert_authoritative_write'));
    const acNext = columnsCompared(fnBody(SQL_0211, 'fdh12_retirement_activities_assert_authoritative_write'));
    expect(acPrev.length).toBe(22);
    expect(acPrev.every((c) => acNext.includes(c))).toBe(true);
    expect(acNext.filter((c) => !acPrev.includes(c))).toEqual(['bank_leg_confirmed_at', 'bank_leg_confirmed_type']);
    // No later migration on this branch redefines either guard.
    for (const f of FILES.filter((x) => x.slice(0, 4) > '0211')) {
      expect(read(f)).not.toMatch(/create or replace function fdh12_retirement_(statements|activities)_assert_authoritative_write/);
    }
  });

  it('GAP-RET-09: a BEFORE INSERT guard on all three evidence tables; no shared CHECK is dropped', () => {
    for (const t of ['fdh_retirement_statements', 'fdh_retirement_statement_activities', 'fdh_retirement_statement_positions']) {
      expect(noComments(SQL_0211)).toMatch(new RegExp(`before insert on ${t}\\s+for each row execute function fdh12_retirement_evidence_assert_authoritative_insert\\(\\)`));
    }
    expect(noComments(SQL_0211)).not.toMatch(/drop constraint/i);
    expect(noComments(SQL_0211)).not.toMatch(/error_code_check|event_type_check/);
  });
});

// ===========================================================================
const existing = (over: Partial<ExistingRetirementRow> = {}): ExistingRetirementRow => ({
  id: 'acc-1', account_name: 'Hostplus', account_type: 'super', current_balance: '100000.00', currency_code: 'AUD', country_code: 'AU',
  owner: 'self', master_item_key: null, retirement_member_id: null, employer_contribution: null, personal_contribution: null,
  contribution_frequency: null, updated_at: '2026-07-01T00:00:00Z', ...over,
});
const evidence = (over: Partial<RetirementEvidence> = {}): RetirementEvidence => ({
  statementId: 'stmt-1', jurisdiction: 'AU', accountType: 'industry_super', fundName: 'Hostplus', currencyCode: 'AUD', countryCode: 'AU',
  closingBalance: '113500.00', employerContributions: '12000.00', memberType: 'self', reviewReasons: [],
  statementStartDate: '2025-07-01', statementEndDate: '2026-06-30', ...over,
});
const fields = (ev: RetirementEvidence, target: ExistingRetirementRow[] = [existing()]) => {
  const d = retirementAdapter.buildProposal(ev, target);
  return { d, f: Object.fromEntries(d.fields.map((x) => [x.fieldName, x])) };
};

describe('GAP-RET-02 / D-12: contribution totals are annualised and always paired with their frequency', () => {
  it('period arithmetic: annual 12, quarter 3, month 1; no period -> null', () => {
    expect(statementPeriodMonths('2025-07-01', '2026-06-30')).toBe(12);
    expect(statementPeriodMonths('2026-04-01', '2026-06-30')).toBe(3);
    expect(statementPeriodMonths('2026-08-01', '2026-08-31')).toBe(1);
    expect(statementPeriodMonths(undefined, '2026-06-30')).toBeNull();
    expect(statementPeriodMonths('2026-08-01', '2026-08-05')).toBeNull();
    expect(annualisePeriodTotal('12000.00', '2025-07-01', '2026-06-30')).toEqual({ annual: '12000.00', months: 12 });
    expect(annualisePeriodTotal('3000.00', '2026-04-01', '2026-06-30')).toEqual({ annual: '12000.00', months: 3 });
    expect(annualisePeriodTotal('1000.0000', '2026-08-01', '2026-08-31')).toEqual({ annual: '12000.00', months: 1 });
    expect(annualisePeriodTotal('100.01', '2026-04-01', '2026-06-30')).toEqual({ annual: '400.04', months: 3 });
    expect(restateRate('1000.00', 'monthly', 'annually')).toBe('12000.00');
    expect(restateRate(500, 'fortnightly', 'annually')).toBe('13000.00');
  });

  it('an ANNUAL statement with $12,000 SG proposes $12,000 with frequency "annually" -- both unticked, confirmation-gated', () => {
    const { f } = fields(evidence());
    expect(f.employer_contribution.proposedValue).toBe('12000.00');
    expect(f.contribution_frequency.proposedValue).toBe('annually');
    for (const n of ['employer_contribution', 'contribution_frequency']) {
      expect(f[n].isRecommended, n).toBe(false);
      expect(f[n].requiresConfirmation, n).toBe(true);
    }
  });

  it('a QUARTERLY statement with $3,000 SG proposes $12,000 a year', () => {
    const { f } = fields(evidence({ employerContributions: '3000.00', statementStartDate: '2026-04-01', statementEndDate: '2026-06-30' }));
    expect(f.employer_contribution.proposedValue).toBe('12000.00');
    expect(f.contribution_frequency.proposedValue).toBe('annually');
  });

  it('with no statement period, NO contribution amount is proposed (never a bare total), and the review says why', () => {
    const { d, f } = fields(evidence({ statementStartDate: undefined, statementEndDate: undefined }));
    expect(f.employer_contribution).toBeUndefined();
    expect(f.contribution_frequency).toBeUndefined();
    expect(d.summary.reviewReasons).toContain('statement_period_unknown_contribution_rate_not_proposed');
  });

  it('an existing manual $1,000/month employer contribution is RESTATED ($12,000 a year) when a statement proposes personal contributions annually', () => {
    const { f } = fields(evidence({ employerContributions: undefined, personalContributions: '2400.00' }), [existing({ employer_contribution: '1000.00', contribution_frequency: 'monthly' })]);
    expect(f.personal_contribution.proposedValue).toBe('2400.00');
    expect(f.employer_contribution.proposedValue).toBe('12000.00');
    expect(f.employer_contribution.existingValue).toBe('1000.00');
    expect(f.contribution_frequency).toMatchObject({ proposedValue: 'annually', existingValue: 'monthly' });
  });

  it('validateApply refuses a contribution amount without its frequency', () => {
    const { d } = fields(evidence());
    expect(retirementAdapter.validateApply('update_existing', d.fields, ['employer_contribution']).ok).toBe(false);
    expect(retirementAdapter.validateApply('update_existing', d.fields, ['employer_contribution', 'contribution_frequency']).ok).toBe(true);
  });

  it('the Dashboard contribution rate: the applied annual row is $1,000/month -- never $12,000/month', async () => {
    const { d } = fields(evidence());
    const applied = Object.fromEntries(d.fields.filter((x) => ['employer_contribution', 'contribution_frequency', 'current_balance'].includes(x.fieldName)).map((x) => [x.fieldName, x.proposedValue]));
    const row = (over: Row) => ({ user_id: USER, is_active: true, current_balance: 113500, personal_contribution: null, country_code: 'AU', currency_code: 'AUD', ...over });
    const dash = async (r: Row) => loadDashboard(USER, makeFakeSupabase(tables(profile(), { retirement_accounts: [r] })).client as never);
    const imported = await dash(row({ employer_contribution: Number(applied.employer_contribution), contribution_frequency: applied.contribution_frequency }));
    expect(imported.retirementEmployerMonthlyContribution).toBe(1000);
    // NEGATIVE CONTROL (the base branch's outcome): the same total, applied
    // WITHOUT a frequency, reads as $12,000 a MONTH.
    const base = await dash(row({ employer_contribution: 12000, contribution_frequency: null }));
    expect(base.retirementEmployerMonthlyContribution).toBe(12000);
  });
});

describe('GAP-RET-06: an older statement never silently regresses the balance', () => {
  it('older than the last applied statement -> balance proposed but NOT recommended, with a review reason', () => {
    const { d, f } = fields(evidence({ statementEndDate: '2025-06-30', statementStartDate: '2024-07-01', appliedAsOfByAccount: { 'acc-1': '2026-06-30' } }));
    expect(f.current_balance).toMatchObject({ proposedValue: '113500.00', isRecommended: false, requiresConfirmation: true });
    expect(d.summary.reviewReasons).toContain('statement_is_older_than_one_already_applied_balance_not_recommended');
  });
  it('same-or-newer -> recommended as before', () => {
    const { f } = fields(evidence({ appliedAsOfByAccount: { 'acc-1': '2026-06-30' } }));
    expect(f.current_balance).toMatchObject({ isRecommended: true, requiresConfirmation: false });
  });
  it('the proposal route passes the period and the applied as-of map, never an invented frequency', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app/api/financial-data-hub/retirement-statement/[documentId]/proposal/route.ts'), 'utf8');
    expect(src).toMatch(/statementStartDate: \(statement\.statement_start_date/);
    expect(src).toMatch(/statementEndDate: \(statement\.statement_end_date/);
    expect(src).toContain('appliedAsOfByAccount,');
    expect(src).not.toMatch(/contributionFrequency:/);
  });
});

// ===========================================================================
describe('X-01 in the panel, GAP-RET-11 in the apply bridge', () => {
  it('the panel sends the ticked list for update_existing (it used to send none = "everything")', () => {
    const panel = fs.readFileSync(path.join(ROOT, 'components/retirement/RetirementStatementImportPanel.tsx'), 'utf8');
    expect(panel).toContain("selected_fields: decision === 'keep_existing' ? undefined : [...selected]");
    expect(panel).not.toMatch(/decision === 'update_existing' \|\| decision === 'keep_existing'\s*\?\s*undefined/);
  });

  it('MEMBER_MISMATCH is a named retirement refusal (the apply route answers 409), not WRITE_FAILED', async () => {
    expect(RETIREMENT_APPLY_REFUSAL_CODES).toContain('MEMBER_MISMATCH');
    rpcMock.result = { data: { ok: false, code: 'MEMBER_MISMATCH', error: 'different member' }, error: null };
    const r = await applyRetirementProposalAtomic({ proposalId: 'p', decision: 'update_existing', selectedFields: ['current_balance'] });
    expect(r.ok).toBe(false);
    expect((r as { refusalCode?: string }).refusalCode).toBe('MEMBER_MISMATCH');
    const route = fs.readFileSync(path.join(ROOT, 'app/api/financial-data-hub/retirement-statement/[documentId]/apply/route.ts'), 'utf8');
    expect(route).toMatch(/result\.refusalCode !== undefined/);
  });
});

// ===========================================================================
// Real Postgres: the PGlite verification, then its rows through the read models.
// ===========================================================================
interface PgliteOut {
  pass: number; fail: number; total: number;
  annualAccount: Row;
  bankLegsBefore: Row[]; bankLegsAfter: Row[];
  rolloverAccounts: Row[];
  positionsMarketValue: number;
}

let pglite: { status: number | null; stdout: string; out: PgliteOut | null } | null = null;
function runPglite() {
  if (pglite) return pglite;
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'fdh12_0211_pglite_verification.mjs'), '--json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: ROOT });
  const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith('JSON:'));
  pglite = { status: r.status, stdout: r.stdout ?? '', out: line ? JSON.parse(line.slice(5)) as PgliteOut : null };
  return pglite;
}

describe('0211 on real Postgres (PGlite, full migration chain) + the brief\'s oracles', () => {
  it('the verification script passes every check, with the predecessor defects demonstrated first', () => {
    const r = runPglite();
    expect(r.status, r.stdout.split('\n').filter((l) => l.includes('FAIL')).join('\n')).toBe(0);
    expect(r.out).not.toBeNull();
    expect(r.out!.fail).toBe(0);
    expect(r.out!.total).toBeGreaterThanOrEqual(75);
    for (const control of [
      'anti-vacuity GAP-RET-01: 0119 update_existing with NO selection applies the UNTICKED',
      'anti-vacuity GAP-RET-09: an authenticated user CAN insert a forged APPROVED statement before 0211',
      '... and leaves the UNTICKED employer_contribution unchanged (null)',
      'a forged APPROVED statement INSERT by the authenticated role is refused',
      "confirming the $500 PERSONAL_CONTRIBUTION reclassifies the bank debit expense -> transfer",
      'rollover A -> B: household retirement total (Net Worth contribution) delta = 0',
      'SMSF boundary: an SMSF target is still refused SMSF_ACCOUNT_NOT_IMPORTABLE',
    ]) expect(r.stdout, control).toContain(`PASS  ${control}`);
  }, 240_000);

  it('the $500 personal contribution: household expense $500 before confirmation, $0 after (only the $200 groceries remain)', async () => {
    const out = runPglite().out!;
    const expenses = async (legs: Row[]) => {
      const keep = legs.filter((l) => ['a4000000-0000-0000-0000-000000000001', 'a4000000-0000-0000-0000-000000000005'].includes(l.id as string));
      const t = tables(profile(), taxonomy(), { fdh_financial_accounts: [account('bank')] }, { fdh_statement_uploads: [statement('s', 'bank', '2026-08-01', '2026-08-31')] }, {
        fdh_transactions: keep.map((l) => txn({ id: l.id as string, account: 'bank', statement: 's', date: '2026-08-10', amount: Number(l.amount_original), type: l.economic_transaction_type as string, cd: l.credit_debit as 'credit' | 'debit' })),
      });
      const res = await selectExpenses(USER, { client: makeFakeSupabase(t).client, window: explicitWindow('2026-08-01', '2026-08-31', '2026-09-26'), basis: 'actual' });
      if (res.status !== 'ok') throw new Error('unavailable');
      return res;
    };
    const before = await expenses(out.bankLegsBefore);
    const after = await expenses(out.bankLegsAfter);
    expect(before.actual.monthly).toBe(700);
    expect(after.actual.monthly).toBe(200);
    expect(after.actual.nonSpending.find((x) => x.bucket === 'transfer')?.monthly).toBe(500);
  }, 240_000);

  it('the applied annual row reads as $1,000 a month in the canonical Retirement read model', async () => {
    const out = runPglite().out!;
    const res = await selectRetirement(USER, { client: makeFakeSupabase(tables(profile(), { retirement_accounts: [{ ...out.annualAccount, user_id: USER, is_active: true }] })).client });
    if (res.status !== 'ok') throw new Error('unavailable');
    expect(res.householdEmployerContributionMonthly).toBe(1000);
    expect(res.unknownFrequencyCount).toBe(0);
  }, 240_000);

  it('rollover A -> B and holdings in super: Net Worth counts each fund\'s closing balance ONCE and never the holdings', async () => {
    const out = runPglite().out!;
    const rows = out.rolloverAccounts.map((r) => ({ ...r, user_id: USER, is_active: true }));
    const res = await selectRetirement(USER, { client: makeFakeSupabase(tables(profile(), { retirement_accounts: rows })).client });
    if (res.status !== 'ok') throw new Error('unavailable');
    const byName = Object.fromEntries(res.lines.map((l) => [l.name, l.balance.amountNative]));
    expect(byName['Old Fund']).toBe(0);
    expect(byName['New Fund']).toBe(50000);
    expect(byName['Aware Super']).toBe(200000);
    const sum = rows.reduce((s, r) => s + Number(r.current_balance), 0);
    expect(res.totalBalance).toBe(sum);
    // The $200,000 of holdings inside Aware Super are NOT added again.
    expect(out.positionsMarketValue).toBe(200000);
    expect(res.totalBalance).not.toBe(sum + out.positionsMarketValue);
  }, 240_000);
});
