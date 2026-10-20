/**
 * Document2 (4) F25 / F25b / F27 -- the contribution service end to end against an in-memory double that emulates the one
 * database guarantee it relies on (the unique payslip index). Evidence label: UNIT-TESTED. The real policy/trigger/index are proven
 * in tests/unit/retirementContributionsMigration0304Pglite.test.ts (PGLITE-VERIFIED). Nothing here talks to DEV or production.
 */
import { describe, expect, it } from 'vitest';
import { contributionFakeDb } from '../support/contributionFakeDb';
import {
  chooseDestination,
  loadContributionHistory,
  recordManualContribution,
  recordPayslipContribution,
  removeContribution,
  supersedePayslipContribution,
} from '@/lib/retirement-contributions/service';

const U1 = 'user-1';
const U2 = 'user-2';
const PO_LINE = 'SGC Employer Cont. THE TRUSTEE FOR THE BEKAL SUPER FUND';
const FORT = (26 / 12) * 684.68;

function world(over: { events?: Array<Record<string, unknown>>; accounts?: Array<Record<string, unknown>>; funds?: Array<Record<string, unknown>> } = {}) {
  const acct = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, user_id: U1, account_name: name, account_type: 'super', current_balance: 250000, currency_code: 'AUD', owner: 'self', retirement_member_id: 'm-self',
    master_item_key: 'industry_super', employer_contribution: null, personal_contribution: null, contribution_frequency: null, is_active: true, ...extra,
  });
  const ev = (id: string, extra: Record<string, unknown> = {}) => ({
    id, user_id: U1, employer_name: 'AUSTRALIAN UNITY GROUP SERVICE P/L', employer_normalised: 'australian unity group service p l', payment_date: '2026-10-01', pay_period_end: '2026-09-30',
    pay_frequency: 'fortnightly', currency_code: 'AUD', employer_retirement_contribution: 684.68, income_owner: 'self', approval_status: 'approved', superseded_by_payroll_event_id: null, ...extra,
  });
  return contributionFakeDb({
    retirement_accounts: over.accounts ?? [acct('acc-smsf', 'SMSF Bekal', { master_item_key: 'smsf' }), acct('acc-rest', 'Rest Super'), acct('acc-other-user', 'Other', { user_id: U2 })],
    smsf_funds: over.funds ?? [{ id: 'fund-1', user_id: U1, fund_name: 'Bekal Super Fund', retirement_account_id: 'acc-smsf', is_active: true }],
    retirement_members: [{ id: 'm-self', user_id: U1, member_type: 'self', is_active: true }, { id: 'm-spouse', user_id: U1, member_type: 'spouse', is_active: true }],
    fdh_payroll_events: over.events ?? [ev('pe-1'), ev('pe-2', { payment_date: '2026-10-15' }), ev('pe-draft', { approval_status: 'pending' }), ev('pe-spouse', { income_owner: 'spouse' }), ev('pe-other', { user_id: U2 })],
    fdh_payroll_components: ['pe-1', 'pe-2', 'pe-draft', 'pe-spouse'].flatMap((id) => [
      { user_id: U1, payroll_event_id: id, label_raw: PO_LINE, component_type: 'employer_retirement', is_year_to_date: false },
      { user_id: U1, payroll_event_id: id, label_raw: 'Employer Contribution YTD', component_type: 'employer_retirement', is_year_to_date: true },
    ]),
    retirement_contributions: [],
  });
}

describe('F25: payslip employer super -> the right destination, after Approve, exactly once', () => {
  it('the SMSF whose name matches receives it; the account rate is written from the ledger; the balance is untouched', async () => {
    const db = world();
    const out = await recordPayslipContribution(U1, 'pe-1', db.client);
    expect(out).toMatchObject({ status: 'recorded', ledgerStatus: 'active', destinationKind: 'smsf', destinationName: 'Bekal Super Fund', alreadyRecorded: false, amount: 684.68 });
    const smsf = db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!;
    expect(smsf.employer_contribution).toBeCloseTo(FORT, 1);
    expect(smsf.contribution_frequency).toBe('monthly');
    expect(smsf.current_balance).toBe(250000);
    const row = db.tables.retirement_contributions[0];
    expect(row).toMatchObject({ source_type: 'payslip', contribution_type: 'employer', retirement_account_id: 'acc-smsf', destination_kind: 'smsf', frequency: 'fortnightly', matched_by: 'fund_name' });
    // the year-to-date line was not used as evidence
    expect(String(row.source_label)).not.toContain('YTD');
  });

  it('[NC] NOTHING is recorded for a payslip that is not approved (never before Accept)', async () => {
    const db = world();
    expect(await recordPayslipContribution(U1, 'pe-draft', db.client)).toEqual({ status: 'none' });
    expect(db.tables.retirement_contributions).toHaveLength(0);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!.employer_contribution).toBeNull();
  });

  it('the same payslip approved or uploaded twice does not duplicate: one row, one rate', async () => {
    const db = world();
    await recordPayslipContribution(U1, 'pe-1', db.client);
    const again = await recordPayslipContribution(U1, 'pe-1', db.client);
    expect(again.alreadyRecorded).toBe(true);
    expect(db.tables.retirement_contributions).toHaveLength(1);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!.employer_contribution).toBeCloseTo(FORT, 1);
  });

  it('[NC] a concurrent second insert hits the unique payslip index and still ends with ONE row', async () => {
    const db = world();
    await recordPayslipContribution(U1, 'pe-1', db.client);
    // simulate the race: the service did not see the row on its pre-check, then insert collided
    const racing = { ...db.client, from: (t: string) => db.client.from(t) } as never;
    const before = db.tables.retirement_contributions.length;
    const dup = await (db.client as unknown as { from: (t: string) => { insert: (r: unknown) => PromiseLike<{ error: { code: string } | null }> } }).from('retirement_contributions').insert({ user_id: U1, source_payroll_event_id: 'pe-1', contribution_type: 'employer' });
    expect(dup.error?.code).toBe('23505');
    expect(db.tables.retirement_contributions).toHaveLength(before);
    void racing;
  });

  it('two consecutive payslips are ONE contribution flow: the rate is one fortnightly amount, not two', async () => {
    const db = world();
    await recordPayslipContribution(U1, 'pe-1', db.client);
    await recordPayslipContribution(U1, 'pe-2', db.client);
    expect(db.tables.retirement_contributions).toHaveLength(2);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!.employer_contribution).toBeCloseTo(FORT, 1);
  });

  it('a payslip that names no account of yours waits for the person (never guessed), and counts nothing until chosen', async () => {
    const db = world({ funds: [{ id: 'fund-1', user_id: U1, fund_name: 'Some Other Super Fund', retirement_account_id: 'acc-smsf', is_active: true }] });
    const out = await recordPayslipContribution(U1, 'pe-1', db.client);
    expect(out).toMatchObject({ ledgerStatus: 'needs_destination', routing: 'ask' });
    expect(db.tables.retirement_contributions[0].retirement_account_id).toBeNull();
    for (const a of db.tables.retirement_accounts) expect(a.employer_contribution).toBeNull();
    // the person chooses
    const chosen = await chooseDestination(U1, db.tables.retirement_contributions[0].id as string, 'acc-rest', db.client);
    expect(chosen).toEqual({ ok: true });
    expect(db.tables.retirement_contributions[0]).toMatchObject({ status: 'active', retirement_account_id: 'acc-rest', matched_by: 'user_choice', destination_kind: 'retirement_account' });
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-rest')!.employer_contribution).toBeCloseTo(FORT, 1);
  });

  it('a Spouse\'s payslip does not go to the Self\'s SMSF: it asks', async () => {
    const db = world();
    const out = await recordPayslipContribution(U1, 'pe-spouse', db.client);
    expect(out.ledgerStatus).toBe('needs_destination');
    expect(db.tables.retirement_contributions[0].retirement_member_id).toBe('m-spouse');
  });

  it('a payslip in another currency never lands on an account of a different currency', async () => {
    const db = world({ events: [{ id: 'pe-1', user_id: U1, employer_name: 'X', employer_normalised: 'x', payment_date: '2026-10-01', pay_frequency: 'monthly', currency_code: 'INR', employer_retirement_contribution: 10000, income_owner: 'self', approval_status: 'approved', superseded_by_payroll_event_id: null }] });
    const out = await recordPayslipContribution(U1, 'pe-1', db.client);
    expect(out.ledgerStatus).toBe('needs_destination');
    const row = db.tables.retirement_contributions[0];
    const mismatch = await chooseDestination(U1, row.id as string, 'acc-rest', db.client);
    expect(mismatch).toMatchObject({ ok: false, code: 'CURRENCY_MISMATCH' });
  });

  it('another person\'s payslip, row or account is invisible (non-enumerating)', async () => {
    const db = world();
    expect(await recordPayslipContribution(U1, 'pe-other', db.client)).toEqual({ status: 'none' });
    await recordPayslipContribution(U1, 'pe-1', db.client);
    const id = db.tables.retirement_contributions[0].id as string;
    expect(await chooseDestination(U2, id, 'acc-other-user', db.client)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(await chooseDestination(U1, id, 'acc-other-user', db.client)).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
    expect(await removeContribution(U2, id, db.client)).toEqual({ ok: false });
  });

  it('a revised payslip: the earlier one is superseded and is not added on top', async () => {
    const db = world();
    await recordPayslipContribution(U1, 'pe-1', db.client);
    await recordPayslipContribution(U1, 'pe-2', db.client);
    await supersedePayslipContribution(U1, 'pe-1', db.client);
    expect(db.tables.retirement_contributions.map((r) => r.status)).toEqual(['superseded', 'active']);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!.employer_contribution).toBeCloseTo(FORT, 1);
  });

  it('a payslip with no employer super records nothing', async () => {
    const db = world({ events: [{ id: 'pe-1', user_id: U1, approval_status: 'approved', employer_retirement_contribution: null, currency_code: 'AUD', pay_frequency: 'monthly', income_owner: 'self', superseded_by_payroll_event_id: null }] });
    expect(await recordPayslipContribution(U1, 'pe-1', db.client)).toEqual({ status: 'none' });
  });
});

describe('F25b: manual contribution is its own action and never a balance', () => {
  it('records a contribution against an account without touching current_balance', async () => {
    const db = world();
    const r = await recordManualContribution(U1, { accountId: 'acc-rest', type: 'personal', amount: 500, frequency: 'monthly', contributionDate: null }, db.client);
    expect(r.ok).toBe(true);
    const acct = db.tables.retirement_accounts.find((a) => a.id === 'acc-rest')!;
    expect(acct.current_balance).toBe(250000);
    expect(acct.personal_contribution).toBe(500);
    expect(db.tables.retirement_contributions[0]).toMatchObject({ source_type: 'manual', contribution_type: 'personal', frequency: 'monthly', matched_by: 'manual' });
  });

  it('an account that already held a figure of its own keeps it as a placeholder, never doubled and never lost', async () => {
    const db = world({ accounts: [{ id: 'acc-rest', user_id: U1, account_name: 'Rest Super', current_balance: 1000, currency_code: 'AUD', owner: 'self', retirement_member_id: 'm-self', master_item_key: 'industry_super', employer_contribution: 500, personal_contribution: 0, contribution_frequency: 'monthly', is_active: true }] });
    const r = await recordManualContribution(U1, { accountId: 'acc-rest', type: 'employer', amount: 600, frequency: 'monthly', contributionDate: null }, db.client);
    expect(r.ok && r.adoptedLegacy).toBe(1);
    // the real record replaces the placeholder: 600, not 1100
    expect(db.tables.retirement_accounts[0].employer_contribution).toBe(600);
    const history = await loadContributionHistory(U1, db.client);
    const legacy = history.items.find((i) => i.notCountedBecause?.startsWith('Replaced by a newer'));
    expect(legacy?.amount).toBe(500);
  });

  it('a manual employer record and the SAME flow from a payslip are counted once', async () => {
    const db = world();
    await recordManualContribution(U1, { accountId: 'acc-smsf', type: 'employer', amount: 684.68, frequency: 'fortnightly', contributionDate: '2026-09-20' }, db.client);
    await recordPayslipContribution(U1, 'pe-1', db.client);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-smsf')!.employer_contribution).toBeCloseTo(FORT, 1);
    const history = await loadContributionHistory(U1, db.client);
    expect(history.items.filter((i) => i.monthlyEquivalent !== null)).toHaveLength(1);
    expect(history.items.find((i) => i.source === 'manual')?.notCountedBecause).toMatch(/already counted from a payslip|Replaced by a newer/);
  });

  it('manual and payslip contributions appear in the SAME history, with provenance', async () => {
    const db = world();
    await recordManualContribution(U1, { accountId: 'acc-rest', type: 'personal', amount: 200, frequency: 'monthly', contributionDate: null }, db.client);
    await recordPayslipContribution(U1, 'pe-1', db.client);
    const { items } = await loadContributionHistory(U1, db.client);
    expect(items.map((i) => i.source).sort()).toEqual(['manual', 'payslip']);
    expect(items.find((i) => i.source === 'payslip')).toMatchObject({ employerName: 'AUSTRALIAN UNITY GROUP SERVICE P/L', accountName: 'SMSF Bekal', destinationKind: 'smsf' });
  });

  it('a one-off dated contribution is history only: no monthly rate is invented', async () => {
    const db = world();
    await recordManualContribution(U1, { accountId: 'acc-rest', type: 'personal', amount: 5000, frequency: 'one_off', contributionDate: '2026-06-30' }, db.client);
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-rest')!.personal_contribution).toBe(0);
    const { items } = await loadContributionHistory(U1, db.client);
    expect(items[0].monthlyEquivalent).toBeNull();
    expect(items[0].notCountedBecause).toMatch(/one-off/);
  });

  it('removing a contribution keeps the history row and recomputes the rate', async () => {
    const db = world();
    await recordManualContribution(U1, { accountId: 'acc-rest', type: 'personal', amount: 500, frequency: 'monthly', contributionDate: null }, db.client);
    const id = db.tables.retirement_contributions[0].id as string;
    expect(await removeContribution(U1, id, db.client)).toEqual({ ok: true });
    expect(db.tables.retirement_contributions[0].status).toBe('removed');
    expect(db.tables.retirement_accounts.find((a) => a.id === 'acc-rest')!.personal_contribution).toBe(0);
  });

  it('an account of another person is refused', async () => {
    const db = world();
    expect(await recordManualContribution(U1, { accountId: 'acc-other-user', type: 'personal', amount: 1, frequency: 'monthly', contributionDate: null }, db.client)).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
  });

  it('an account the ledger has never touched keeps its own figures and shows them in the history as "Recorded on the account"', async () => {
    const db = world({ accounts: [{ id: 'acc-rest', user_id: U1, account_name: 'Rest Super', current_balance: 1000, currency_code: 'AUD', owner: 'self', retirement_member_id: 'm-self', master_item_key: 'industry_super', employer_contribution: 300, personal_contribution: 0, contribution_frequency: 'monthly', is_active: true }] });
    const { items } = await loadContributionHistory(U1, db.client);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'account_figure', source: 'account', amount: 300, monthlyEquivalent: 300 });
  });
});
