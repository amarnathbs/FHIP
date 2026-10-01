// Publish -> Investments -> Net Worth EXACTLY ONCE, with the current-NAV re-mark
// (PO decision 2026-10-01). Drives the REAL InvestmentPublicationService
// (publishPosition / refreshPosition / unpublishPosition / republishPosition)
// and the REAL re-mark against a filtering in-memory database that ENFORCES
// migration 0042's unique active-position index
// (uidx_ii_fhip_publications_one_active_position).
//
// What is proven:
//   * publishing creates exactly ONE register row and ONE active publication; the
//     row is then valued at units x latest eligible NAV (100 x 112 = 11,200) while
//     the publication keeps the certified statement value 10,000 as evidence;
//   * publishing again (double click / retry) changes nothing: same publication,
//     same row, one 'published' publication;
//   * a refresh (a newer certified statement with different units) UPDATES the same
//     row (never inserts), supersedes the old publication, and values the NEW
//     certified units: 120 x 112 = 13,440;
//   * unpublish removes the row from Net Worth (0); republish re-activates the SAME
//     row and publication and re-marks it, never duplicating;
//   * the re-mark itself never inserts into `investments`.
//
// NEGATIVE CONTROLS: a re-mark that ADDS a second register row (the modelled
// double-count) and an unprotected publication table (no unique index) are each
// caught by the same assertions with their named messages.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeDb, type FakeDb, type Row } from './support/remarkFakeDb';

const hoisted = vi.hoisted(() => ({ client: null as unknown, adminInserts: [] as Array<{ table: string; row: Record<string, unknown> }> }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => hoisted.client }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      insert: async (row: Record<string, unknown>) => {
        hoisted.adminInserts.push({ table, row });
        return { error: null };
      },
    }),
  }),
}));
vi.mock('@/lib/services/investment-intelligence/audit', () => ({ emitAuditEvent: vi.fn().mockResolvedValue({ error: null }) }));

import { publishPosition, refreshPosition, republishPosition, unpublishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

const USER = 'user-1';

function baseTables(): Record<string, Row[]> {
  return {
    investments: [],
    ii_fhip_publications: [],
    ii_holding_snapshots: [
      { id: 'snap-1', user_id: USER, account_id: 'acc-1', instrument_id: 'inst-1', as_of_date: '2026-06-30', units: 100, value: 10000, currency_code: 'INR', quality_status: 'certified', created_at: '2026-07-01T00:00:00Z' },
    ],
    ii_accounts: [{ id: 'acc-1', user_id: USER, account_type: 'mf_folio', institution_name: 'Alpha AMC', country_code: 'IN', currency_code: 'INR', owner_member_id: 'member-1' }],
    ii_instruments: [{ id: 'inst-1', instrument_class: 'mutual_fund', instrument_name: 'Alpha Flexi Cap Fund', amc_name: 'Alpha Mutual Fund' }],
    ii_portfolio_truth_status: [{ id: 't1', user_id: USER, account_id: 'acc-1', instrument_id: 'inst-1', status: 'certified', history_completeness: 'complete_from_inception' }],
    household_members: [{ id: 'member-1', user_id: USER, relationship: 'self', full_name: 'Asha' }],
    ii_tax_lots: [],
    ii_reconciliation_cases: [],
    ii_ownership_allocation: [],
    ii_transactions: [],
    ii_prices_nav: [{ id: 'nav-1', instrument_id: 'inst-1', price_date: '2026-09-30', price: 112, currency_code: 'INR', quality_status: 'ok' }],
  };
}

const registerRows = (t: Record<string, Row[]>) => t.investments.filter((r) => r.is_active === true);
const activePubs = (t: Record<string, Row[]>) => t.ii_fhip_publications.filter((r) => r.status === 'published');

describe('publish -> Investments -> Net Worth: exactly once, valued at the latest eligible NAV', () => {
  let t: Record<string, Row[]>;
  let db: FakeDb;
  beforeEach(() => {
    hoisted.adminInserts.length = 0;
    t = baseTables();
    db = makeFakeDb(t, { uniqueActivePosition: true });
    hoisted.client = db.client;
  });

  it('publish creates ONE row and ONE publication; the row is valued 100 x 112 = 11,200; the publication keeps the certified 10,000', async () => {
    const res = await publishPosition(USER, 'snap-1');
    expect(res.error).toBeNull();
    expect(res.action).toBe('ADD_NEW');
    expect(registerRows(t)).toHaveLength(1);
    expect(activePubs(t)).toHaveLength(1);
    const row = registerRows(t)[0];
    expect(row).toMatchObject({ current_value: 11200, source_type: 'investment_intelligence_published', ii_valuation_basis: 'market_nav', ii_value_as_of: '2026-09-30', ii_valuation_nav: 112, ii_valuation_units: 100, owner: 'self' });
    expect(activePubs(t)[0]).toMatchObject({ published_value: 10000, published_row_id: row.id });
    expect(row.ii_publication_id).toBe(activePubs(t)[0].id);
    // The re-mark inserted nothing into the register: exactly the publish's own single insert exists.
    expect(db.inserts.filter((i) => i.table === 'investments')).toHaveLength(1);
    // One revision (baseline 10,000 -> 11,200), written by the service role.
    expect(hoisted.adminInserts.filter((i) => i.table === 'ii_investment_value_revisions').map((i) => [i.row.reason, i.row.remark_trigger, i.row.previous_value, i.row.new_value])).toEqual([['baseline', 'publish', 10000, 11200]]);
  });

  it('publishing the same position twice is idempotent: same publication, same row, still one of each, value unchanged', async () => {
    const first = await publishPosition(USER, 'snap-1');
    const second = await publishPosition(USER, 'snap-1');
    expect(second.error).toBeNull();
    expect(second.action).toBe('LEAVE_UNCHANGED');
    expect(second.publicationId).toBe(first.publicationId);
    expect(second.publishedRowId).toBe(first.publishedRowId);
    expect(registerRows(t)).toHaveLength(1);
    expect(activePubs(t)).toHaveLength(1);
    expect(registerRows(t)[0].current_value).toBe(11200);
  });

  it('refresh with a newer certified statement (120 units) UPDATES the same row to 120 x 112 = 13,440 and supersedes the old publication; never a second row or active publication', async () => {
    const first = await publishPosition(USER, 'snap-1');
    t.ii_holding_snapshots.push({ id: 'snap-2', user_id: USER, account_id: 'acc-1', instrument_id: 'inst-1', as_of_date: '2026-09-10', units: 120, value: 12600, currency_code: 'INR', quality_status: 'certified', created_at: '2026-09-11T00:00:00Z' });
    const refreshed = await refreshPosition(USER, 'snap-2');
    expect(refreshed.error).toBeNull();
    expect(registerRows(t)).toHaveLength(1);
    expect(registerRows(t)[0].id).toBe(first.publishedRowId);
    expect(registerRows(t)[0]).toMatchObject({ current_value: 13440, ii_valuation_units: 120, ii_valuation_nav: 112, ii_valuation_basis: 'market_nav' });
    expect(activePubs(t)).toHaveLength(1);
    expect(activePubs(t)[0]).toMatchObject({ canonical_position_id: 'snap-2', published_value: 12600 });
    expect(t.ii_fhip_publications.filter((p) => p.status === 'superseded')).toHaveLength(1);
    expect(db.inserts.filter((i) => i.table === 'investments')).toHaveLength(1);
  });

  it('unpublish takes the position out of Net Worth; republish re-activates the SAME row and publication and re-marks it (no duplicate)', async () => {
    const first = await publishPosition(USER, 'snap-1');
    expect((await unpublishPosition(USER, first.publicationId as string)).error).toBeNull();
    expect(registerRows(t)).toHaveLength(0);
    expect(activePubs(t)).toHaveLength(0);

    const re = await republishPosition(USER, first.publicationId as string);
    expect(re.error).toBeNull();
    expect(registerRows(t)).toHaveLength(1);
    expect(registerRows(t)[0].id).toBe(first.publishedRowId);
    expect(registerRows(t)[0].current_value).toBe(11200);
    expect(t.investments).toHaveLength(1);
    expect(t.ii_fhip_publications).toHaveLength(1);
    expect(activePubs(t)).toHaveLength(1);
  });

  it('a newer NAV after publication changes the single row on the next evaluation; the publication row is never rewritten', async () => {
    await publishPosition(USER, 'snap-1');
    t.ii_prices_nav.push({ id: 'nav-2', instrument_id: 'inst-1', price_date: '2026-10-01', price: 115, currency_code: 'INR', quality_status: 'ok' });
    const { remarkPublishedInvestments } = await import('@/lib/services/investment-intelligence/publishedValueRemark');
    const summary = await remarkPublishedInvestments(USER, { client: db.client, trigger: 'manual', asOfDate: '2026-10-01' });
    expect(summary.updated).toBe(1);
    expect(registerRows(t)).toHaveLength(1);
    expect(registerRows(t)[0].current_value).toBe(11500);
    expect(activePubs(t)[0].published_value).toBe(10000);
    expect(db.updates.some((u) => u.table === 'ii_fhip_publications' && 'published_value' in u.payload)).toBe(false);
  });
});

describe('NEGATIVE CONTROLS for exactly-once', () => {
  const check = (t: Record<string, Row[]>) => {
    const rows = t.investments.filter((r) => r.is_active === true && r.ii_canonical_instrument_id === 'inst-1');
    if (rows.length !== 1) throw new Error(`RULE EO-1: a published position must reach investments exactly once (found ${rows.length} active rows)`);
  };

  it('real flow passes the check', async () => {
    const t = baseTables();
    const db = makeFakeDb(t, { uniqueActivePosition: true });
    hoisted.client = db.client;
    await publishPosition(USER, 'snap-1');
    expect(() => check(t)).not.toThrow();
  });

  it('a re-mark that inserts a second register row for the same position is caught', async () => {
    const t = baseTables();
    const db = makeFakeDb(t, { uniqueActivePosition: true });
    hoisted.client = db.client;
    await publishPosition(USER, 'snap-1');
    // The modelled bug: the re-mark "creates" the NAV-valued row instead of updating the existing one.
    t.investments.push({ ...t.investments[0], id: 'inv-duplicate-from-remark', current_value: 11200 });
    expect(() => check(t)).toThrow(/RULE EO-1: a published position must reach investments exactly once \(found 2 active rows\)/);
  });

  it('without the unique active-position index a second active publication would be accepted; with it the database refuses', async () => {
    const insertSecond = async (uniqueActivePosition: boolean) => {
      const t = baseTables();
      const db = makeFakeDb(t, { uniqueActivePosition });
      hoisted.client = db.client;
      await publishPosition(USER, 'snap-1');
      const { error } = await (db.client.from('ii_fhip_publications') as unknown as { insert: (r: Row) => Promise<{ error: unknown }> }).insert({ user_id: USER, account_id: 'acc-1', instrument_id: 'inst-1', status: 'published' });
      return error;
    };
    expect(await insertSecond(false)).toBeNull();
    expect(await insertSecond(true)).toMatchObject({ code: '23505' });
  });
});
