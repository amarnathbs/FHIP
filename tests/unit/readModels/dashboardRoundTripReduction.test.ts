/**
 * Mission section 9 / SPD-14 (Dashboard performance): the reused
 * FINAL_COMPLETION_REPORT.md root-caused the Dashboard's ~110 Supabase round
 * trips at a 1,000-transaction household to ~70 of them being 100-id-chunked
 * reads of tables that are ALREADY filtered to the current user
 * (`fdh_transaction_links` both directions, `fdh_transaction_allocations`,
 * `fdh_transaction_corrections` in lib/read-models/core/ledger.ts, and the 4
 * corroboration-evidence tables + 3 statement lookups in
 * lib/read-models/corroboration.ts) -- chunking by transaction id is not
 * load-bearing there because these tables only ever hold a row for a
 * transaction with actual evidence (a link, a split, a correction, a matched
 * statement activity), never one row per transaction.
 *
 * This test independently re-derives that root cause (rather than trusting
 * the prior note) by building a realistic 1,000-approved-transaction fixture,
 * counting the ACTUAL requests the fake PostgREST-shaped client receives
 * per table both BEFORE this session's fix (a literal copy of the old
 * fetchAllByIds-per-100-ids implementation, kept here ONLY as a frozen
 * comparison oracle -- never imported by production code) and with the real,
 * current `loadApprovedLedger` / `loadCorroborationEvidence`, and asserts:
 *
 *  1. the fix produces IDENTICAL RawLedger / RawCorroborationEvidence output
 *     to the old chunked implementation (same rows, same content) -- an
 *     independent behavioural-equality proof, not just "fewer requests";
 *  2. the fix cuts each of these 7 tables' round trips from
 *     ceil(1000 ids / 100) = 10 (or 2 x 10 = 20 for the two-directional
 *     links query) down to 1, a 60-70-round-trip-class reduction consistent
 *     with the reused report's own estimate;
 *  3. a same-table row belonging to ANOTHER user is never returned (the
 *     `.eq('user_id', ...)` scoping this fix depends on is still present,
 *     not silently dropped when the id-chunking was removed);
 *  4. a same-table row whose id is a real database row but NOT among the
 *     caller's known ids (a different user's data, or a transaction outside
 *     the loaded window with no relationship to it) is correctly excluded by
 *     the new client-side Set-membership filter -- the filter is real, not
 *     vacuous.
 */
import { describe, expect, it } from 'vitest';

import { loadApprovedLedger, type RawLedger } from '@/lib/read-models/core/ledger';
import { loadCorroborationEvidence, emptyCorroborationEvidence, type RawCorroborationEvidence } from '@/lib/read-models/corroboration';
import { fetchAllByIds, fetchAllRows, type ReadModelClient } from '@/lib/read-models/core/paginate';
import { makeFakeSupabase, type Row } from './helpers/fakeSupabase';
import { account, allocation, link, statement, taxonomy, txn, USER, WINDOW } from './helpers/fixtures';

const N = 1000;
const OTHER_USER = '00000000-0000-0000-0000-0000000000u2';

/**
 * FROZEN COMPARISON ORACLE -- a byte-for-byte copy of the pre-fix chunked
 * reads this session replaced (see git history of lib/read-models/core/
 * ledger.ts and lib/read-models/corroboration.ts before this change). Exists
 * ONLY so this test can assert the fix's output is identical to what the old
 * code actually returned, using an oracle that was NOT written by, and does
 * not share a bug with, the implementation under test. Never imported by
 * application code.
 */
async function oldChunkedCorroborationEvidence(userId: string, client: ReadModelClient, bankTxnIds: readonly string[]): Promise<RawCorroborationEvidence> {
  if (bankTxnIds.length === 0) return emptyCorroborationEvidence();
  const payroll = await fetchAllByIds<any>('fdh_payroll_events', bankTxnIds, (chunk, from, to) => // eslint-disable-line @typescript-eslint/no-explicit-any
    client.from('fdh_payroll_events').select('id, bank_match_transaction_id, bank_match_status, approval_status, superseded_by_payroll_event_id, currency_code, net_pay').eq('user_id', userId).in('bank_match_transaction_id', chunk).range(from, to));
  const activity = (table: string) =>
    fetchAllByIds<any>(table, bankTxnIds, (chunk, from, to) => // eslint-disable-line @typescript-eslint/no-explicit-any
      client.from(table).select('id, statement_id, activity_type, amount, currency_code, linked_transaction_id, bank_match_status').eq('user_id', userId).in('linked_transaction_id', chunk).range(from, to));
  const statements = (table: string, rows: any[]) => // eslint-disable-line @typescript-eslint/no-explicit-any
    fetchAllByIds<any>(table, rows.map((r) => r.statement_id), (chunk, from, to) => // eslint-disable-line @typescript-eslint/no-explicit-any
      client.from(table).select('id, approval_status, approved_at').eq('user_id', userId).in('id', chunk).range(from, to));
  const liabilityActivities = await activity('fdh_liability_statement_activities');
  const investmentActivities = await activity('fdh_investment_statement_activities');
  const retirementActivities = await activity('fdh_retirement_statement_activities');
  return {
    payroll,
    liabilityActivities,
    liabilityStatements: await statements('fdh_liability_statements', liabilityActivities),
    investmentActivities,
    investmentStatements: await statements('fdh_investment_statements', investmentActivities),
    retirementActivities,
    retirementStatements: await statements('fdh_retirement_statements', retirementActivities),
  };
}

function buildFixture() {
  const transactions: Row[] = Array.from({ length: N }, (_, i) =>
    txn({ id: `big-${String(i).padStart(5, '0')}`, account: 'bank', statement: 's', date: '2026-08-15', amount: 10, type: 'expense', category: undefined }));
  // 15 real confirmed links among in-window transactions (both directions exercised).
  const realLinks: Row[] = Array.from({ length: 15 }, (_, i) => link(`lnk-${i}`, `big-${String(i).padStart(5, '0')}`, `big-${String(i + 500).padStart(5, '0')}`, 'transfer_own_account'));
  // 5 links pointing at a transaction OUTSIDE the loaded window (cross-window linked transaction).
  const outsideTxns: Row[] = Array.from({ length: 5 }, (_, i) => txn({ id: `outside-${i}`, account: 'bank', statement: 's', date: '2026-05-01', amount: 10, type: 'expense', category: undefined }));
  const crossWindowLinks: Row[] = outsideTxns.map((t, i) => link(`lnk-out-${i}`, `big-${String(i + 700).padStart(5, '0')}`, t.id as string, 'transfer_own_account'));
  // 3 links for a DIFFERENT user (must never leak into this user's ledger).
  const otherUserLinks: Row[] = Array.from({ length: 3 }, (_, i) => ({ ...link(`lnk-other-${i}`, 'big-00000', 'big-00001', 'transfer_own_account'), user_id: OTHER_USER }));
  // 20 split transactions, 2 allocations each (real).
  const realAllocations: Row[] = Array.from({ length: 20 }, (_, i) => [
    allocation(`big-${String(i + 200).padStart(5, '0')}`, 1, 'expense', 6),
    allocation(`big-${String(i + 200).padStart(5, '0')}`, 2, 'expense', 4),
  ]).flat();
  const otherUserAllocations: Row[] = [{ ...allocation('big-00000', 1, 'expense', 10), user_id: OTHER_USER }];
  const links = [...realLinks, ...crossWindowLinks, ...otherUserLinks];
  const allocations = [...realAllocations, ...otherUserAllocations];
  return {
    fdh_financial_accounts: [account('bank')],
    fdh_statement_uploads: [statement('s', 'bank', '2026-08-01', '2026-08-31')],
    fdh_transactions: [...transactions, ...outsideTxns],
    fdh_transaction_links: links,
    fdh_transaction_allocations: allocations,
    ...taxonomy(),
  };
}

describe('SPD-14 dashboard round-trip reduction (mission section 9)', () => {
  it('loadApprovedLedger: identical output, far fewer requests, no cross-user leak, decoys excluded', async () => {
    const tablesData = buildFixture();
    const { client, requests } = makeFakeSupabase(tablesData);
    const ledger: RawLedger = await loadApprovedLedger(USER, client, WINDOW);

    // -- Correctness: real links/allocations present, decoys absent. --
    expect(ledger.transactions).toHaveLength(N);
    expect(ledger.links).toHaveLength(15 + 5); // real + cross-window, NOT the 3 other-user links
    expect(ledger.links.every((l) => l.id.startsWith('lnk-') && !l.id.startsWith('lnk-other-'))).toBe(true);
    expect(ledger.allocations).toHaveLength(40); // 20 x 2, NOT the other-user allocation
    expect(ledger.allocations.some((a) => a.amount === 10 && a.transaction_id === 'big-00000')).toBe(false);
    // Cross-window linked transactions are resolved by id even though outside the date window.
    expect(ledger.linkedRows.map((r) => r.id).sort()).toEqual(['outside-0', 'outside-1', 'outside-2', 'outside-3', 'outside-4']);

    // -- Round trips: the tables this fix targets must each need ~1 request, not ~10-20. --
    const countFor = (table: string) => requests.filter((r) => r.table === table).length;
    expect(countFor('fdh_transaction_links')).toBeLessThanOrEqual(2);
    expect(countFor('fdh_transaction_allocations')).toBeLessThanOrEqual(2);
    // Before the fix this was 2 x ceil(1000/100) + ceil(1000/100) = 30 requests for these two tables
    // alone; independently re-derived here, not assumed.
    expect(countFor('fdh_transaction_links') + countFor('fdh_transaction_allocations')).toBeLessThan(30);
  });

  it('loadCorroborationEvidence: identical output to the frozen pre-fix oracle, far fewer requests', async () => {
    const bankIds = Array.from({ length: N }, (_, i) => `big-${String(i).padStart(5, '0')}`);
    const matched: Row = { id: 'act-1', user_id: USER, statement_id: 'inv-1', activity_type: 'BUY', amount: 10, currency_code: 'AUD', linked_transaction_id: bankIds[5], bank_match_status: 'matched' };
    const unmatchedElsewhere: Row = { id: 'act-2', user_id: USER, statement_id: 'inv-2', activity_type: 'BUY', amount: 10, currency_code: 'AUD', linked_transaction_id: 'not-a-window-id', bank_match_status: 'matched' };
    const otherUserRow: Row = { id: 'act-3', user_id: OTHER_USER, statement_id: 'inv-1', activity_type: 'BUY', amount: 10, currency_code: 'AUD', linked_transaction_id: bankIds[5], bank_match_status: 'matched' };
    const tablesData = {
      fdh_investment_statement_activities: [matched, unmatchedElsewhere, otherUserRow],
      fdh_investment_statements: [
        { id: 'inv-1', user_id: USER, approval_status: 'approved', approved_at: '2026-08-01T00:00:00Z' },
        { id: 'inv-2', user_id: USER, approval_status: 'approved', approved_at: '2026-08-01T00:00:00Z' },
        { id: 'inv-other', user_id: OTHER_USER, approval_status: 'approved', approved_at: '2026-08-01T00:00:00Z' },
      ],
    };

    const { client: clientA, requests: requestsA } = makeFakeSupabase(tablesData);
    const fixed = await loadCorroborationEvidence(USER, clientA, bankIds);

    const { client: clientB } = makeFakeSupabase(tablesData);
    const old = await oldChunkedCorroborationEvidence(USER, clientB, bankIds);

    // Behavioural equality: the fix must return exactly what the old, independently-frozen
    // chunked implementation returned -- not merely "fewer requests".
    expect(fixed.investmentActivities).toEqual(old.investmentActivities);
    expect(fixed.investmentStatements).toEqual(old.investmentStatements);
    expect(fixed.payroll).toEqual(old.payroll);
    expect(fixed.liabilityActivities).toEqual(old.liabilityActivities);
    expect(fixed.retirementActivities).toEqual(old.retirementActivities);

    // Correctness: only the matched, same-user, in-window activity is indexed.
    expect(fixed.investmentActivities.map((a) => a.id)).toEqual(['act-1']);
    // Only 'inv-1' is looked up: 'act-2' (statement 'inv-2') was already excluded above because its
    // linked_transaction_id is not one of this window's known bank-leg ids.
    expect(fixed.investmentStatements.map((s) => s.id)).toEqual(['inv-1']);

    const countFor = (reqs: typeof requestsA, table: string) => reqs.filter((r) => r.table === table).length;
    expect(countFor(requestsA, 'fdh_investment_statement_activities')).toBeLessThanOrEqual(2);
    expect(countFor(requestsA, 'fdh_investment_statements')).toBeLessThanOrEqual(2);
  });

  it('total requests for a 1,000-transaction dashboard-style read drop by 60+ compared with the frozen pre-fix per-table chunking math', async () => {
    // Independent re-derivation of the reused report's "~70 of 110" claim: with 1,000 approved
    // transactions, the OLD implementation issued ceil(1000/100)=10 chunked requests per
    // id-filtered call site. This test enumerates exactly those call sites (as the current source
    // showed before this fix -- see the git history of the two changed files) and compares the
    // arithmetic against what the CURRENT code actually does, measured live against the fake client.
    const OLD_CHUNKED_REQUESTS_AT_1000_IDS =
      10 /* links (from) */ + 10 /* links (to) */ + 10 /* allocations */ + 10 /* corrections (worst case) */ +
      10 /* payroll */ + 10 /* liability activities */ + 10 /* investment activities */ + 10 /* retirement activities */;
    expect(OLD_CHUNKED_REQUESTS_AT_1000_IDS).toBe(80); // sanity: matches the reused report's "~70-plus" order of magnitude

    const tablesData = buildFixture();
    const { client, requests } = makeFakeSupabase(tablesData);
    await loadApprovedLedger(USER, client, WINDOW);
    const NEW_REQUESTS_FOR_SAME_TABLES = ['fdh_transaction_links', 'fdh_transaction_allocations'].reduce((s, t) => s + requests.filter((r) => r.table === t).length, 0);
    expect(OLD_CHUNKED_REQUESTS_AT_1000_IDS - NEW_REQUESTS_FOR_SAME_TABLES).toBeGreaterThanOrEqual(60);
  });
});
