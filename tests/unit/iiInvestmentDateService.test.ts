// Document2 D-3 (PO decision 2026-10-03) -- the I/O half: the user's investment
// date for a holdings-only position, end to end against an in-memory database
// that APPLIES its filters (a query that forgets user_id returns the wrong rows
// here too).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const emitAuditEvent = vi.fn().mockResolvedValue({ error: null });
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: (...a: unknown[]) => emitAuditEvent(...a) }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => { throw new Error('the test must pass its own db'); } }));

import { applyPendingInvestmentDates, listInvestmentDateItems, submitInvestmentDate } from '@/lib/services/investment-intelligence/investmentDateService';

const USER = 'user-1';
const OTHER = 'user-2';
const TODAY = '2026-10-03';

function seed(overrides: Record<string, Row[]> = {}) {
  const db = createInMemoryDb();
  db.reset({
    ii_accounts: [
      { id: 'acc-1', user_id: USER, folio_number: '1234567890', institution_name: 'Test AMC', currency_code: 'INR' },
      { id: 'acc-2', user_id: OTHER, folio_number: '999', institution_name: 'Other AMC', currency_code: 'INR' },
    ],
    ii_instruments: [{ id: 'ins-1', instrument_name: 'Test Growth Fund', isin: 'INF000A00000', instrument_class: 'mutual_fund' }],
    ii_scheme_master: [],
    ii_holding_snapshots: [
      { id: 'snap-1', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', as_of_date: '2026-09-04', units: 100, value: 15000 },
      { id: 'snap-2', user_id: OTHER, account_id: 'acc-2', instrument_id: 'ins-1', as_of_date: '2026-09-04', units: 50, value: 7500 },
    ],
    ii_transactions: [],
    ii_investment_date_inputs: [],
    ii_nav_history_floors: [{ instrument_id: 'ins-1', floor_date: '2013-01-01' }],
    ii_prices_nav: [
      { instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' },
      { instrument_id: 'ins-1', price_date: '2024-03-13', price: 39, quality_status: 'superseded' },
    ],
    // Ownership tables exist so a stray write to them would be caught.
    ii_ownership_allocation: [],
    ...overrides,
  });
  return db;
}

const submit = (db: ReturnType<typeof seed>, date: string, userId = USER, accountId = 'acc-1') =>
  submitInvestmentDate({ userId, accountId, instrumentId: 'ins-1', dateText: date, todayIso: TODAY, db: db.client as never });

beforeEach(() => emitAuditEvent.mockClear());

describe('submitInvestmentDate', () => {
  it('records the answer with user_supplied provenance, derives ONE purchase at that day\'s NAV, links it, and audits it', async () => {
    const db = seed();
    const res = await submit(db, '14-03-2024');
    expect(res).toMatchObject({ ok: true, state: 'applied', investmentDate: '2024-03-14', unchanged: false });

    const input = db.tables.ii_investment_date_inputs[0];
    expect(input).toMatchObject({ user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', provenance: 'user_supplied', status: 'applied', investment_date: '2024-03-14', created_by: USER, nav_price: 40, nav_date: '2024-03-14' });

    expect(db.tables.ii_transactions).toHaveLength(1);
    const txn = db.tables.ii_transactions[0];
    expect(txn).toMatchObject({
      user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', transaction_type: 'purchase', transaction_date: '2024-03-14', status: 'parsed',
      units: 100, price_per_unit: 40, gross_amount: 4000, source_document_id: null, parser_code: 'user_supplied_investment_date',
    });
    expect(String(txn.source_reference)).toBe(`USER_INVESTMENT_DATE:${input.id}`);
    expect(input.derived_transaction_id).toBe(txn.id);

    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditEvent.mock.calls[0][0]).toMatchObject({ userId: USER, eventType: 'user_correction', subjectType: 'ii_investment_date_inputs', actorType: 'user', metadata: { kind: 'investment_date_supplied', provenance: 'user_supplied', investmentDate: '2024-03-14', state: 'applied' } });
  });

  it('does not touch ownership: no write to any ownership table, and the account row is not updated', async () => {
    const db = seed();
    await submit(db, '14-03-2024');
    const touched = new Set(db.writes.map((w) => w.table));
    expect([...touched].sort()).toEqual(['ii_investment_date_inputs', 'ii_transactions']);
  });

  it('with no NAV on file yet it keeps the date as awaiting_nav and writes no transaction; the next read completes it', async () => {
    const db = seed({ ii_prices_nav: [] });
    const res = await submit(db, '14-03-2024');
    expect(res).toMatchObject({ ok: true, state: 'awaiting_nav' });
    expect(db.tables.ii_transactions).toHaveLength(0);
    expect(db.tables.ii_investment_date_inputs[0].status).toBe('awaiting_nav');

    // The existing scheduled hydration supplies the history...
    db.tables.ii_prices_nav.push({ instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' });
    // ...and the next read applies the saved date.
    const items = await listInvestmentDateItems(USER, db.client as never);
    expect(db.tables.ii_transactions).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'applied', investmentDate: '2024-03-14', navPrice: 40 });
  });

  it('applying twice never double counts (a retry after a half-finished apply links the existing row)', async () => {
    const db = seed({ ii_prices_nav: [] });
    await submit(db, '14-03-2024');
    db.tables.ii_prices_nav.push({ instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' });
    // Simulate: the transaction was written but the link update never happened.
    const input = db.tables.ii_investment_date_inputs[0];
    db.tables.ii_transactions.push({ id: 'orphan', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', source_reference: `USER_INVESTMENT_DATE:${input.id}`, status: 'parsed', transaction_type: 'purchase' });
    await applyPendingInvestmentDates(USER, db.client as never);
    await applyPendingInvestmentDates(USER, db.client as never);
    expect(db.tables.ii_transactions).toHaveLength(1);
    expect(db.tables.ii_investment_date_inputs[0]).toMatchObject({ status: 'applied', derived_transaction_id: 'orphan' });
  });

  it('is idempotent for the same date', async () => {
    const db = seed();
    await submit(db, '14-03-2024');
    const again = await submit(db, '14/03/2024');
    expect(again).toMatchObject({ ok: true, state: 'applied', unchanged: true });
    expect(db.tables.ii_investment_date_inputs).toHaveLength(1);
    expect(db.tables.ii_transactions).toHaveLength(1);
    expect(emitAuditEvent).toHaveBeenCalledTimes(1);
  });

  it('editing supersedes the old answer, reverses (never deletes) the old purchase, and derives a new one', async () => {
    const db = seed({
      ii_prices_nav: [
        { instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' },
        { instrument_id: 'ins-1', price_date: '2025-01-10', price: 55, quality_status: 'accepted' },
      ],
    });
    await submit(db, '14-03-2024');
    const first = db.tables.ii_investment_date_inputs[0];
    const firstTxn = db.tables.ii_transactions[0];

    const res = await submit(db, '10-01-2025');
    expect(res).toMatchObject({ ok: true, state: 'applied', investmentDate: '2025-01-10', unchanged: false });

    expect(db.tables.ii_investment_date_inputs).toHaveLength(2);
    expect(first).toMatchObject({ status: 'superseded', supersede_reason: 'user_changed_date' });
    expect(firstTxn.status).toBe('reversed');
    expect(db.tables.ii_transactions).toHaveLength(2); // nothing deleted
    const live = db.tables.ii_transactions.filter((t) => t.status === 'parsed');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ transaction_date: '2025-01-10', price_per_unit: 55, gross_amount: 5500 });
    expect(emitAuditEvent.mock.calls[1][0].metadata).toMatchObject({ previousInvestmentDate: '2024-03-14', investmentDate: '2025-01-10' });
  });

  it('refuses an account that is not the caller\'s (404), writing nothing', async () => {
    const db = seed();
    const res = await submit(db, '14-03-2024', USER, 'acc-2');
    expect(res).toMatchObject({ ok: false, status: 404, code: 'account_not_found' });
    expect(db.writes).toHaveLength(0);
  });

  it('another user cannot reach the first user\'s position either', async () => {
    const db = seed();
    const res = await submit(db, '14-03-2024', OTHER, 'acc-1');
    expect(res).toMatchObject({ ok: false, status: 404 });
    expect(db.writes).toHaveLength(0);
  });

  it('refuses a position that already has statement transactions (409): it is not holdings-only', async () => {
    const db = seed({ ii_transactions: [{ id: 't', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', transaction_type: 'purchase', status: 'parsed', source_reference: 'CAMS-1' }] });
    const res = await submit(db, '14-03-2024');
    expect(res).toMatchObject({ ok: false, status: 409, code: 'not_holdings_only' });
    expect(db.writes).toHaveLength(0);
  });

  it.each([
    ['', 'required'],
    ['31-02-2024', 'not_a_date'],
    ['04-10-2026', 'in_future'],
    ['01-01-2010', 'before_inception'],
    ['20-09-2026', 'after_statement'],
  ])('refuses %j (%s) and writes nothing', async (text, code) => {
    const db = seed();
    const res = await submit(db, text);
    expect(res).toMatchObject({ ok: false, status: 422, code });
    expect(db.writes).toHaveLength(0);
  });

  it('refuses a date when there is no holding on record at all', async () => {
    const db = seed({ ii_holding_snapshots: [] });
    expect(await submit(db, '14-03-2024')).toMatchObject({ ok: false, status: 422, code: 'no_holding' });
  });
});

describe('listInvestmentDateItems', () => {
  it('lists a holdings-only position as needs_date with a masked folio and the statement value for orientation only', async () => {
    const db = seed();
    const items = await listInvestmentDateItems(USER, db.client as never);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ accountId: 'acc-1', schemeName: 'Test Growth Fund', state: 'needs_date', units: 100, statementValue: 15000, investmentDate: null, earliestKnownNavDate: '2013-01-01' });
    expect(items[0].maskedFolio).toBe('******7890');
    expect(JSON.stringify(items)).not.toContain('1234567890');
  });

  it('is scoped to the caller: the other user\'s holding never appears', async () => {
    const db = seed();
    const items = await listInvestmentDateItems(USER, db.client as never);
    expect(items.every((i) => i.accountId === 'acc-1')).toBe(true);
    expect(await listInvestmentDateItems('nobody', db.client as never)).toEqual([]);
  });

  it('keeps showing a position the user has answered (so the date can be changed later), and drops one that has real transactions', async () => {
    const db = seed();
    await submit(db, '14-03-2024');
    expect((await listInvestmentDateItems(USER, db.client as never))[0]).toMatchObject({ state: 'applied', investmentDate: '2024-03-14' });

    db.tables.ii_transactions.push({ id: 'real', user_id: USER, account_id: 'acc-1', instrument_id: 'ins-1', transaction_type: 'purchase', status: 'parsed', source_reference: 'CAMS-9' });
    expect(await listInvestmentDateItems(USER, db.client as never)).toEqual([]);
  });

  it('does not list non-mutual-fund holdings (the NAV cost basis is a mutual-fund concept)', async () => {
    const db = seed({ ii_instruments: [{ id: 'ins-1', instrument_name: 'Some Equity', isin: null, instrument_class: 'equity' }] });
    expect(await listInvestmentDateItems(USER, db.client as never)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PO 2026-10-03: saving a date fetches THAT ONE fund's missing history at once.
// NC-E1 fetch is only for the one fund and only when no NAV is on file
// NC-E2 a failed / empty / throwing fetch never loses the answer
// NC-E3 after rows arrive the answer is applied in the SAME request
// ---------------------------------------------------------------------------
describe('immediate NAV fetch on save', () => {
  const withFetch = (db: ReturnType<typeof seed>, fetchNav: (a: { userId: string; instrumentId: string }) => Promise<{ outcome: 'fetched' | 'no_data' | 'failed' | 'rate_limited' | 'disabled' | 'unresolvable' | 'nothing_to_fetch' }>, date = '14-03-2024') =>
    submitInvestmentDate({ userId: USER, accountId: 'acc-1', instrumentId: 'ins-1', dateText: date, todayIso: TODAY, db: db.client as never, fetchNav });

  it('NC-E3: no NAV on file -> fetch THIS fund -> rows arrive -> applied in the same request, with a plain status', async () => {
    const db = seed({ ii_prices_nav: [] });
    const fetchNav = vi.fn(async () => {
      db.tables.ii_prices_nav.push({ instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' });
      return { outcome: 'fetched' as const };
    });
    const res = await withFetch(db, fetchNav);
    expect(res).toMatchObject({ ok: true, state: 'applied', navStatus: 'applied', appliedNow: true });
    expect(res.ok && res.message).toContain('Done');
    expect(fetchNav).toHaveBeenCalledTimes(1);
    expect(fetchNav).toHaveBeenCalledWith({ userId: USER, instrumentId: 'ins-1' }); // one user, one fund: nothing wider can be asked
    expect(db.tables.ii_transactions).toHaveLength(1);
    expect(db.tables.ii_investment_date_inputs[0]).toMatchObject({ status: 'applied', nav_price: 40 });
    expect(emitAuditEvent.mock.calls[0][0].metadata).toMatchObject({ state: 'applied', navFetch: 'fetched' });
  });

  it('NC-E1: when the NAV is already on file nothing is fetched', async () => {
    const db = seed();
    const fetchNav = vi.fn(async () => ({ outcome: 'fetched' as const }));
    const res = await withFetch(db, fetchNav);
    expect(res).toMatchObject({ ok: true, state: 'applied', navStatus: 'applied' });
    expect(fetchNav).not.toHaveBeenCalled();
  });

  it.each([
    ['no_data', 'waiting_for_nav'],
    ['rate_limited', 'waiting_for_nav'],
    ['disabled', 'waiting_for_nav'],
    ['unresolvable', 'waiting_for_nav'],
    ['failed', 'failed'],
  ] as const)('NC-E2: a fetch that ends %s keeps the answer as awaiting_nav (%s), the save still succeeds, "we will keep trying"', async (outcome, navStatus) => {
    const db = seed({ ii_prices_nav: [] });
    const res = await withFetch(db, async () => ({ outcome }));
    expect(res).toMatchObject({ ok: true, state: 'awaiting_nav', navStatus, appliedNow: false });
    expect(res.ok && res.message).toContain('We will keep trying');
    expect(db.tables.ii_investment_date_inputs[0]).toMatchObject({ status: 'awaiting_nav', investment_date: '2024-03-14', provenance: 'user_supplied' });
    expect(db.tables.ii_transactions).toHaveLength(0);
  });

  it('NC-E2: a fetcher that THROWS never loses the answer either', async () => {
    const db = seed({ ii_prices_nav: [] });
    const res = await withFetch(db, async () => { throw new Error('source exploded'); });
    expect(res).toMatchObject({ ok: true, state: 'awaiting_nav', navStatus: 'failed' });
    expect(db.tables.ii_investment_date_inputs).toHaveLength(1);
  });

  it('retry: saving the SAME date again re-runs the fetch for an answer that was waiting, and applies it when the data arrives', async () => {
    const db = seed({ ii_prices_nav: [] });
    await withFetch(db, async () => ({ outcome: 'no_data' }));
    const retry = await withFetch(db, async () => {
      db.tables.ii_prices_nav.push({ instrument_id: 'ins-1', price_date: '2024-03-14', price: 40, quality_status: 'accepted' });
      return { outcome: 'fetched' };
    });
    expect(retry).toMatchObject({ ok: true, state: 'applied', unchanged: true, appliedNow: true });
    expect(db.tables.ii_investment_date_inputs).toHaveLength(1); // the same answer, not a second one
    expect(db.tables.ii_transactions).toHaveLength(1);
  });

  it('an already-applied answer repeated does not fetch or re-apply', async () => {
    const db = seed();
    await withFetch(db, async () => ({ outcome: 'fetched' }));
    const fetchNav = vi.fn(async () => ({ outcome: 'fetched' as const }));
    const again = await withFetch(db, fetchNav);
    expect(again).toMatchObject({ ok: true, unchanged: true, appliedNow: false });
    expect(fetchNav).not.toHaveBeenCalled();
  });

  it('without a fetcher (the previous behaviour) the answer simply waits for the scheduled job', async () => {
    const db = seed({ ii_prices_nav: [] });
    const res = await submit(db, '14-03-2024');
    expect(res).toMatchObject({ ok: true, state: 'awaiting_nav', navStatus: 'waiting_for_nav' });
  });

  it('a refused answer (validation) never triggers a fetch', async () => {
    const db = seed({ ii_prices_nav: [] });
    const fetchNav = vi.fn(async () => ({ outcome: 'fetched' as const }));
    const res = await withFetch(db, fetchNav, '04-10-2026');
    expect(res).toMatchObject({ ok: false, code: 'in_future' });
    expect(fetchNav).not.toHaveBeenCalled();
  });
});
