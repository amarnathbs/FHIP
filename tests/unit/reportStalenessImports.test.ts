/**
 * WP-06 (DC-09): approving / applying imported data after a report was
 * generated makes the stored report stale, and imported income / expenses are
 * reflected in the Data Quality "last updated" column.
 *
 * reportsData.generateReport() regenerates a stored report when
 * `loadReportInputsLastChangedAt(...) > report.generated_at` -- this suite
 * drives that exact function (and loadDataFreshness) against the
 * PostgREST-shaped fake.
 *
 * NEGATIVE CONTROL (base branch feature/canonical-upload-foundation f79374f):
 * only the manual registers' updated_at were read, so every `it` marked [NC]
 * fails there -- the pre-Apply report kept being served.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));

import { loadDataFreshness, loadReportInputsLastChangedAt } from '@/lib/services/reportSnapshotResolver';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, txn, USER } from './readModels/helpers/fixtures';

const REPORT_GENERATED_AT = '2026-09-10T00:00:00.000Z';

/** A household whose manual registers were last edited BEFORE the report. */
function registers(): Record<string, Row[]> {
  const row = (table: string): Row => ({ id: `${table}-1`, user_id: USER, is_active: true, updated_at: '2026-09-01T00:00:00.000Z' });
  return {
    income_sources: [row('income_sources')],
    expense_items: [row('expense_items')],
    assets: [row('assets')],
  };
}

async function changedAt(t: Record<string, Row[]>) {
  const { client } = makeFakeSupabase(t);
  return loadReportInputsLastChangedAt(USER, client as never);
}

const isStale = (inputsChangedAt: string | null) => Boolean(inputsChangedAt && inputsChangedAt > REPORT_GENERATED_AT);

describe('WP-06 report staleness includes imported data', () => {
  it('baseline: with only register edits before the report, the report is current', async () => {
    expect(isStale(await changedAt(registers()))).toBe(false);
  });

  it('[NC] approving a bank statement after the report makes it stale (fdh_transactions.approved_at)', async () => {
    const approved = { ...txn({ account: 'bank', date: '2026-08-15', amount: 200, type: 'expense' }), approved_at: '2026-09-12T08:00:00.000Z' };
    const at = await changedAt(tables(registers(), { fdh_transactions: [approved] }));
    expect(at).toBe('2026-09-12T08:00:00.000Z');
    expect(isStale(at)).toBe(true);
  });

  it('a PENDING (unapproved) imported row never makes a report stale', async () => {
    const pending = { ...txn({ account: 'bank', date: '2026-08-15', amount: 200, type: 'expense', approval: 'pending' }), approved_at: '2026-09-12T08:00:00.000Z' };
    expect(isStale(await changedAt(tables(registers(), { fdh_transactions: [pending] })))).toBe(false);
  });

  it('[NC] a split (allocation) or confirmed link changed after the report makes it stale', async () => {
    expect(isStale(await changedAt(tables(registers(), { fdh_transaction_allocations: [{ user_id: USER, transaction_id: 't', updated_at: '2026-09-11T00:00:00.000Z' }] })))).toBe(true);
    expect(isStale(await changedAt(tables(registers(), { fdh_transaction_links: [{ user_id: USER, id: 'lk', updated_at: '2026-09-11T00:00:00.000Z' }] })))).toBe(true);
  });

  it('[NC] an AU broker statement imported into Investment Intelligence, or published to Net Worth, after the report makes it stale', async () => {
    expect(isStale(await changedAt(tables(registers(), { ii_holding_snapshots: [{ user_id: USER, id: 'hs', created_at: '2026-09-11T00:00:00.000Z' }] })))).toBe(true);
    expect(isStale(await changedAt(tables(registers(), { ii_fhip_publications: [{ user_id: USER, published_at: '2026-09-11T00:00:00.000Z', last_republished_at: null }] })))).toBe(true);
    expect(isStale(await changedAt(tables(registers(), { ii_fhip_publications: [{ user_id: USER, published_at: '2026-08-01T00:00:00.000Z', last_republished_at: '2026-09-11T00:00:00.000Z' }] })))).toBe(true);
  });

  it('[NC] an Applied payslip / statement proposal after the report makes it stale (fhip_import_applications.applied_at)', async () => {
    expect(isStale(await changedAt(tables(registers(), { fhip_import_applications: [{ user_id: USER, applied_at: '2026-09-11T00:00:00.000Z' }] })))).toBe(true);
  });

  it('an unreadable imported table contributes nothing -- never artificially fresh or stale', async () => {
    const { client } = makeFakeSupabase(registers(), { failOn: new Set(['fdh_transactions', 'ii_holding_snapshots']) });
    expect(await loadReportInputsLastChangedAt(USER, client as never)).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('WP-06 Data Quality freshness includes approved imported lines', () => {
  it('[NC] an imports-only household is not "Missing" for income / expenses the report counts', async () => {
    const { client } = makeFakeSupabase({
      fdh_transactions: [
        { ...txn({ account: 'bank', date: '2026-08-01', amount: 6000, type: 'income' }), approved_at: '2026-09-05T00:00:00.000Z' },
        { ...txn({ account: 'bank', date: '2026-08-02', amount: 800, type: 'expense' }), approved_at: '2026-09-06T00:00:00.000Z' },
        // A transfer is neither income nor spending: it must not mark either.
        { ...txn({ account: 'bank', date: '2026-08-03', amount: 50, type: 'transfer' }), approved_at: '2026-09-20T00:00:00.000Z' },
      ],
    });
    const f = await loadDataFreshness(USER, client as never);
    expect(f.income).toBe('2026-09-05T00:00:00.000Z');
    expect(f.expenses).toBe('2026-09-06T00:00:00.000Z');
    expect(f.assets).toBeNull();
  });
});
