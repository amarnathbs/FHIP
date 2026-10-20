/**
 * Document2 (4) F25 / F25b / F27 -- the contribution ledger rate rules: a contribution is a flow, counted EXACTLY ONCE.
 * Evidence label: UNIT-TESTED (pure). Every rule has a case that fails when the rule is broken (negative controls marked [NC]).
 */
import { describe, expect, it } from 'vitest';
import { governedBuckets, resolveAccountRates } from '@/lib/retirement-contributions/runRate';
import type { LedgerRow } from '@/lib/retirement-contributions/types';

let n = 0;
function row(over: Partial<LedgerRow> = {}): LedgerRow {
  n += 1;
  return {
    id: `r${String(n).padStart(3, '0')}`,
    retirementAccountId: 'acc-1',
    destinationKind: 'retirement_account',
    memberId: 'm-self',
    type: 'employer',
    amount: 684.68,
    currency: 'AUD',
    frequency: 'fortnightly',
    contributionDate: '2026-10-01',
    sourceType: 'payslip',
    payrollEventId: `pe-${n}`,
    employerNormalised: 'australian unity group service p l',
    status: 'active',
    createdAt: `2026-10-0${(n % 9) + 1}T00:00:00Z`,
    ...over,
  };
}
const rate = (rows: LedgerRow[], acc = 'acc-1') => resolveAccountRates(rows).get(acc)!;

describe('ledger rate rules', () => {
  it('a payslip every fortnight is ONE contribution: only the latest counts, not 26 of them', () => {
    const rows = [row({ contributionDate: '2026-09-03' }), row({ contributionDate: '2026-09-17' }), row({ contributionDate: '2026-10-01' })];
    const r = rate(rows);
    expect(r.series).toHaveLength(1);
    expect(r.employerMonthly).toBeCloseTo((684.68 * 26) / 12, 2);
    expect(r.excluded.filter((e) => e.reason === 'older_in_series')).toHaveLength(2);
  });

  it('[NC] summing every row (the broken rule) would give three times the rate', () => {
    const rows = [row({ contributionDate: '2026-09-03' }), row({ contributionDate: '2026-09-17' }), row({ contributionDate: '2026-10-01' })];
    const naive = rows.reduce((s, x) => s + (x.amount * 26) / 12, 0);
    expect(naive).toBeGreaterThan(rate(rows).employerMonthly * 2.9);
  });

  it('a manual employer record that names no employer is the SAME flow as the one payslip series: counted once, the older one reported', () => {
    const payslip = row({ contributionDate: '2026-10-01' });
    const manual = row({ sourceType: 'manual', payrollEventId: null, employerNormalised: null, amount: 684.68, frequency: 'fortnightly', contributionDate: '2026-09-20' });
    const r = rate([payslip, manual]);
    expect(r.series).toHaveLength(1);
    expect(r.employerMonthly).toBeCloseTo((684.68 * 26) / 12, 2);
    expect(r.excluded.map((e) => e.reason)).toEqual(['same_flow_as_payslip']);
  });

  it('[NC] two payslip series (two employers) are two flows and BOTH count; the employer-less manual record then stays its own series', () => {
    const a = row({ employerNormalised: 'employer a' });
    const b = row({ employerNormalised: 'employer b', amount: 100, frequency: 'monthly' });
    const manual = row({ sourceType: 'manual', payrollEventId: null, employerNormalised: null, amount: 50, frequency: 'monthly' });
    const r = rate([a, b, manual]);
    expect(r.series).toHaveLength(3);
    expect(r.employerMonthly).toBeCloseTo((684.68 * 26) / 12 + 100 + 50, 2);
  });

  it('a one-off dated payment is history: it is NOT projected as a monthly rate', () => {
    const r = rate([row({ type: 'personal', sourceType: 'manual', payrollEventId: null, employerNormalised: null, frequency: 'one_off', amount: 5000 })]);
    expect(r.personalMonthly).toBe(0);
    expect(r.excluded[0].reason).toBe('one_off_history');
  });

  it('a row with no frequency is UNKNOWN and left out, never assumed monthly', () => {
    const r = rate([row({ frequency: null })]);
    expect(r.employerMonthly).toBe(0);
    expect(r.excluded[0].reason).toBe('unknown_frequency');
  });

  it('waiting, superseded and removed rows never count', () => {
    for (const status of ['needs_destination', 'superseded', 'removed'] as const) {
      const r = resolveAccountRates([row({ status, retirementAccountId: status === 'needs_destination' ? null : 'acc-1' })]).get('acc-1');
      expect(r?.employerMonthly ?? 0).toBe(0);
    }
  });

  it('a revised payslip replacing an earlier one is not added on top: the superseded row is excluded', () => {
    const earlier = row({ status: 'superseded', amount: 600 });
    const revised = row({ amount: 684.68 });
    expect(rate([earlier, revised]).employerMonthly).toBeCloseTo((684.68 * 26) / 12, 2);
  });

  it('employer and personal go to their own buckets; salary sacrifice is employer-side; spouse and government are personal-side', () => {
    const r = rate([
      row({ type: 'employer', amount: 1000, frequency: 'monthly' }),
      row({ type: 'salary_sacrifice', amount: 200, frequency: 'monthly', employerNormalised: 'ss' }),
      row({ type: 'personal', amount: 300, frequency: 'monthly', sourceType: 'manual', payrollEventId: null, employerNormalised: null }),
      row({ type: 'spouse', amount: 100, frequency: 'monthly', sourceType: 'manual', payrollEventId: null, employerNormalised: null }),
      row({ type: 'government', amount: 500, frequency: 'annually', sourceType: 'manual', payrollEventId: null, employerNormalised: null }),
    ]);
    expect(r.employerMonthly).toBe(1200);
    expect(r.personalMonthly).toBeCloseTo(300 + 100 + 500 / 12, 2);
  });

  it('a figure the account held before is a placeholder: any real record for the same flow replaces it', () => {
    const legacy = row({ sourceType: 'manual', payrollEventId: null, employerNormalised: null, isAdoptedLegacy: true, contributionDate: null, frequency: 'monthly', amount: 500, createdAt: '2026-10-20T00:00:00Z' });
    const payslip = row({ amount: 684.68, contributionDate: '2026-10-01' });
    const r = rate([legacy, payslip]);
    expect(r.employerMonthly).toBeCloseTo((684.68 * 26) / 12, 2);
    expect(r.excluded.map((e) => e.row.id)).toEqual([legacy.id]);
    // alone, the legacy figure still counts once (nothing is lost)
    expect(rate([legacy]).employerMonthly).toBe(500);
  });

  it('each destination account is separate: SMSF and a retirement fund both get their own rate', () => {
    const rows = [row({ retirementAccountId: 'acc-smsf', destinationKind: 'smsf', amount: 684.68 }), row({ retirementAccountId: 'acc-2', amount: 100, frequency: 'monthly', employerNormalised: 'x' })];
    const out = resolveAccountRates(rows);
    expect(out.get('acc-smsf')!.employerMonthly).toBeCloseTo((684.68 * 26) / 12, 2);
    expect(out.get('acc-2')!.employerMonthly).toBe(100);
  });

  it('governance: an account is ledger-governed once an active row exists for it', () => {
    expect(governedBuckets([row({ type: 'employer' })], 'acc-1').has('employer')).toBe(true);
    expect(governedBuckets([row({ type: 'employer' })], 'acc-1').has('personal')).toBe(false);
    expect(governedBuckets([row({ type: 'employer', status: 'removed' })], 'acc-1').size).toBe(0);
  });
});
