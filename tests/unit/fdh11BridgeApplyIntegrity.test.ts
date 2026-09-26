/**
 * WP-12 -- the FDH-11 -> Investment Intelligence Apply bridge (INV-G3, INV-G5,
 * INV-G7, INV-G9, D-11).
 *
 * DELIBERATELY BASE-COMPATIBLE: it imports only the Apply functions and the
 * Apply route that already existed on the base branch, so running it against
 * the base code is a real negative control (the assertions fail there; the
 * imports do not).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { FakeDb, Row } from './helpers/fdh11FakeDb';
import { DOC, OTHER, USER, world } from './helpers/fdh11World';

const h = vi.hoisted(() => ({ db: null as unknown as { client: unknown } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/financial-data-hub/services/auditLog', () => ({ recordDocumentAuditEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@/lib/api')>();
  return { ...orig, requireCountryConfirmedUser: vi.fn().mockResolvedValue({ user: { id: 'user-au-1', email: 'au@fhip-test.invalid' } }) };
});

import { applyAuStatementActivity } from '@/lib/investment-import-bridge/applyAuStatementActivity';
import { applyAuStatementPosition } from '@/lib/investment-import-bridge/applyAuStatementPosition';
import { POST as applyRoute } from '@/app/api/financial-data-hub/investment-statement/[documentId]/apply/route';

const params = { params: Promise.resolve({ documentId: DOC }) };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => ({ status: r.status, ...(await r.json()) });

let db: FakeDb;
function seedApproved(statementId: string, activities: Row[] = [], positions: Row[] = []) {
  db.rows('fdh_investment_statements').push({ id: statementId, user_id: USER, statement_upload_id: DOC, approval_status: 'approved', canonical_account_id: 'acct-1' });
  db.rows('fdh_investment_statement_activities').push(...activities.map((r) => ({ user_id: USER, statement_id: statementId, currency_code: 'AUD', apply_status: 'pending', security_match_status: 'matched', matched_instrument_id: 'ins-1', ...r })));
  db.rows('fdh_investment_statement_positions').push(...positions.map((r) => ({ user_id: USER, statement_id: statementId, currency_code: 'AUD', apply_status: 'pending', security_match_status: 'matched', matched_instrument_id: 'ins-1', valuation_date: '2026-08-31', ...r })));
}

beforeEach(() => {
  db = world({ ii_accounts: [{ id: 'acct-1', user_id: USER, country_code: 'AU', currency_code: 'AUD', account_type: 'broker', institution_name: 'CommSec', status: 'active' }] });
  h.db = db;
});

describe("INV-G5: a forged statement cannot write into another user's account", () => {
  it('position Apply refuses a statement whose account belongs to someone else (FOREIGN_ACCOUNT) and writes no snapshot', async () => {
    db.rows('ii_accounts').push({ id: 'victim-acct', user_id: OTHER, country_code: 'AU', currency_code: 'AUD', account_type: 'broker', institution_name: 'Victim', status: 'active' });
    db.rows('fdh_investment_statements').push({ id: 'forged', user_id: USER, statement_upload_id: DOC, approval_status: 'approved', canonical_account_id: 'victim-acct' });
    db.rows('fdh_investment_statement_positions').push({ id: 'fp', user_id: USER, statement_id: 'forged', security_name_raw: 'BHP', quantity: 1, market_value: 50, currency_code: 'AUD', valuation_date: '2026-08-31', security_match_status: 'matched', matched_instrument_id: 'ins-1', apply_status: 'pending' });
    const r = await applyAuStatementPosition({ userId: USER, positionId: 'fp' });
    expect(r).toMatchObject({ ok: false, code: 'FOREIGN_ACCOUNT' });
    expect(db.rows('ii_holding_snapshots')).toHaveLength(0);
  });
});

describe('INV-G7 / INV-G9: position Apply', () => {
  it('a holding with no printed market value is SKIPPED with a visible reason -- never written as a $0 holding', async () => {
    seedApproved('s1', [], [{ id: 'p-null', security_name_raw: 'VAS', quantity: 50, market_value: null }]);
    const r = await applyAuStatementPosition({ userId: USER, positionId: 'p-null' });
    expect(r.ok).toBe(false);
    expect(db.rows('ii_holding_snapshots')).toHaveLength(0);
    const p = db.rows('fdh_investment_statement_positions')[0];
    expect(p.apply_status).toBe('skipped');
    expect(String(p.apply_rejected_reason)).toMatch(/never recorded as \$0/);
  });

  it("the statement's unit price is kept as the snapshot's source_nav (price_source 'statement_price')", async () => {
    seedApproved('s1', [], [{ id: 'p1', security_name_raw: 'BHP', quantity: 200, unit_price: 49.9, market_value: 9980 }]);
    expect((await applyAuStatementPosition({ userId: USER, positionId: 'p1' })).ok).toBe(true);
    expect(db.rows('ii_holding_snapshots')[0]).toMatchObject({ units: 200, value: 9980, source_nav: 49.9, price_source: 'statement_price' });
  });
});

describe('activity Apply: broker cash, fees/taxes/narrative, genuine duplicates vs overlapping statements', () => {
  it('broker-cash lines (no security) are SKIPPED with the D-11 reason instead of sticking at NOT_MATCHED forever', async () => {
    seedApproved('s1', [{ id: 'dep', activity_type: 'CASH_DEPOSIT', trade_date: '2026-08-03', amount: 10000, security_match_status: 'not_attempted', matched_instrument_id: null }]);
    const r = await applyAuStatementActivity({ userId: USER, activityId: 'dep' });
    expect(r.code).toBe('CANONICAL_TYPE_UNSUPPORTED');
    expect(r.error).toMatch(/Broker cash is not tracked yet/);
    expect(db.rows('fdh_investment_statement_activities')[0]).toMatchObject({ apply_status: 'skipped' });
    expect(db.rows('ii_transactions')).toHaveLength(0);
  });

  it('a fee line that names no security is skipped with a reason (it can never be matched)', async () => {
    seedApproved('s1', [{ id: 'fee', activity_type: 'FEE', trade_date: '2026-08-03', amount: 9.95, security_name_raw: null, ticker_raw: null, isin: null, security_match_status: 'not_attempted', matched_instrument_id: null }]);
    const r = await applyAuStatementActivity({ userId: USER, activityId: 'fee' });
    expect(r.ok).toBe(false);
    expect(db.rows('fdh_investment_statement_activities')[0]).toMatchObject({ apply_status: 'skipped' });
    expect(String(db.rows('fdh_investment_statement_activities')[0].apply_rejected_reason)).toMatch(/does not name a security/);
  });

  it('a BUY keeps its brokerage, withholding and narrative; a DISTRIBUTION keeps its identity', async () => {
    seedApproved('s1', [
      { id: 'buy', activity_type: 'BUY', trade_date: '2026-08-04', amount: 9980, quantity: 200, unit_price: 49.9, brokerage_raw: 19.95, description_raw: 'BUY', ticker_raw: 'BHP', security_name_raw: 'BHP Group Ltd' },
      { id: 'dst', activity_type: 'DISTRIBUTION', trade_date: '2026-08-28', amount: 55, withholding_tax_raw: '$5.50', description_raw: 'DISTRIBUTION', ticker_raw: 'VAS', security_name_raw: 'Vanguard' },
    ]);
    await applyAuStatementActivity({ userId: USER, activityId: 'buy' });
    await applyAuStatementActivity({ userId: USER, activityId: 'dst' });
    const [buy, dst] = db.rows('ii_transactions');
    expect(buy).toMatchObject({ transaction_type: 'purchase', fees: 19.95, source_description: 'BUY', parser_code: 'fdh11_au_statement' });
    expect(dst).toMatchObject({ transaction_type: 'dividend', taxes: 5.5, source_description: 'DISTRIBUTION' });
  });

  it('two genuine identical same-day trades on ONE statement are two rows; the same trade on an overlapping statement is still one', async () => {
    const trade = { activity_type: 'BUY', trade_date: '2026-08-04', amount: 499, quantity: 10, unit_price: 49.9, ticker_raw: 'BHP', security_name_raw: 'BHP' };
    seedApproved('s1', [{ id: 't1', source_row_number: 1, ...trade }, { id: 't2', source_row_number: 2, ...trade }]);
    seedApproved('s2', [{ id: 't1-again', source_row_number: 7, ...trade }]);
    for (const id of ['t1', 't2', 't1-again']) await applyAuStatementActivity({ userId: USER, activityId: id });
    expect(db.rows('ii_transactions')).toHaveLength(2);
    const acts = db.rows('fdh_investment_statement_activities');
    const canon = (id: string) => acts.find((a) => a.id === id)!.canonical_transaction_id;
    expect(canon('t1')).not.toBe(canon('t2'));
    expect(canon('t1-again')).toBe(canon('t1'));
  });

  it('the Apply route applies all 1,001 activities (no truncation) and reports every row with its outcome', async () => {
    const rows: Row[] = [];
    for (let i = 0; i < 1001; i += 1) rows.push({ id: `a-${String(i).padStart(4, '0')}`, activity_type: 'BUY', trade_date: '2026-08-04', amount: 10 + i, quantity: 1, unit_price: 10 + i, ticker_raw: 'BHP', security_name_raw: 'BHP', source_row_number: i + 1 });
    seedApproved('big', rows);
    const res = await json(await applyRoute(new Request('http://x', { method: 'POST' }), params));
    expect(res.data.activities).toHaveLength(1001);
    expect(res.data.applied_count).toBe(1001);
    expect(db.rows('ii_transactions')).toHaveLength(1001);
  }, 60_000);
});
