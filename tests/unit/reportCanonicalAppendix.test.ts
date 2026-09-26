/**
 * WP-06 (DC-10 / EXP-G11 / GAP-02 / DC-08): the Premium report appendix, the
 * investment chapter and the Net Worth section are built from the canonical
 * read models.
 *
 * Two layers:
 *  1. buildCanonicalAppendix() on real snapshots of the golden pair (M/I).
 *  2. End to end through the report resolver: reportCanonicalSections.test.ts.
 *
 * buildCanonicalAppendix() is new in WP-06, so this file cannot run against
 * the base branch; the base-branch negative control for the same behaviour
 * (the stored appendix, investment chapter and Net Worth section) is
 * reportCanonicalSections.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { buildCanonicalFinancialSnapshot } from '@/lib/read-models/snapshot';
import { buildCanonicalAppendix, type CanonicalAppendix } from '@/lib/engines/reportCanonicalAppendix';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables } from './readModels/helpers/fixtures';
import { householdI, householdM, USER } from './helpers/canonicalGoldenHouseholds';

async function snapshotOf(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  const snap = await buildCanonicalFinancialSnapshot(USER, { client });
  if (snap.status !== 'ok') throw new Error('snapshot unavailable');
  return snap;
}

const tableOf = (a: CanonicalAppendix, key: string) => a.tables.find((t) => t.key === key);

describe('WP-06 buildCanonicalAppendix -- the appendix is the calculation', () => {
  it('appendix totals equal the calculation totals, and M equals I (combined expenses 3,300: rent 2,000 + food 800 + remittance 500)', async () => {
    for (const build of [householdM, householdI]) {
      const snap = await snapshotOf(build());
      if (snap.expenses.status !== 'ok' || snap.income.status !== 'ok') throw new Error('unavailable');
      const a = buildCanonicalAppendix(snap);
      expect(a.reconciliation.expenses?.combinedMonthly).toBe(snap.expenses.combined.monthly);
      expect(a.reconciliation.expenses?.combinedMonthly).toBe(3300);
      expect(a.reconciliation.expenses?.byGroup.reduce((s, g) => s + g.monthly, 0)).toBe(3300);
      expect(tableOf(a, 'expenses_planned')?.countedTotal).toBe(snap.expenses.planned.monthly);
      expect(tableOf(a, 'expenses_actual')?.countedTotal ?? 0).toBe(snap.expenses.actual.totalInWindow);
      expect(tableOf(a, 'income_planned')?.countedTotal).toBe(snap.income.planned.grossMonthly);
    }
  });

  it('I: every approved imported line in the window is listed with its provenance label (3 months x salary, rent, Woolworths)', async () => {
    const snap = await snapshotOf(householdI());
    const a = buildCanonicalAppendix(snap);
    const income = tableOf(a, 'income_actual')!;
    const spend = tableOf(a, 'expenses_actual')!;
    expect(income.rows.filter((r) => r.name === 'ACME PAYROLL')).toHaveLength(3);
    expect(spend.rows.filter((r) => r.name === 'WOOLWORTHS')).toHaveLength(3);
    expect(spend.rows.filter((r) => r.name === 'RENT PAYMENT')).toHaveLength(3);
    for (const r of [...income.rows, ...spend.rows]) expect(r.provenance).toBe('Imported from bank statement');
    // Nothing imported is silently absent: every counted ledger line in the window has a row.
    if (snap.ledger.status !== 'ok') throw new Error('ledger');
    const listed = a.tables.filter((t) => ['income_actual', 'expenses_actual', 'cost_of_debt', 'other_imported_activity'].includes(t.key)).reduce((s, t) => s + t.rows.length, 0);
    expect(listed).toBe(snap.ledger.value.lines.filter((l) => l.household).length + snap.ledger.value.nettedRefunds.length);
  });

  it('rows a calculation excludes are LISTED and marked not counted, with the reason; currency is on every row; retirement is included', async () => {
    const a = buildCanonicalAppendix(await snapshotOf(householdM()));
    const planned = tableOf(a, 'expenses_planned')!;
    const superseded = planned.rows.find((r) => r.name === 'Old groceries estimate')!;
    expect(superseded.counted).toBe(false);
    expect(superseded.note).toMatch(/replaced by imported bank data/);
    const smsf = planned.rows.find((r) => r.name === 'SMSF remittance')!;
    expect(smsf.counted).toBe(false);
    expect(smsf.note).toMatch(/SMSF-owned/);
    expect(planned.rows.find((r) => r.name === 'Mortgage')?.note).toMatch(/loan repayment/);
    const prop = tableOf(a, 'assets')!.rows.find((r) => r.name === 'Pune flat')!;
    expect(prop.currency).toBe('INR');
    expect(prop.amountNative).toBe(5600000);
    expect(prop.amountReporting).toBe(100000);
    expect(tableOf(a, 'retirement')?.rows.map((r) => r.name)).toEqual(['Super']);
  });

  it('I: the imported-but-unpublished broker holding is disclosed as not in Net Worth, never added to it', async () => {
    const snap = await snapshotOf(householdI());
    const a = buildCanonicalAppendix(snap);
    expect(a.notInCalculations).toContainEqual({ label: 'Imported, not yet in Net Worth', count: 1, total: 10000 });
    expect(a.reconciliation.netWorth?.investments).toBe(50000);
  });
});
