import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createClient } from '@/lib/supabase/server';
import { republishPosition } from '@/lib/services/investment-intelligence/investmentPublicationService';

// Regression coverage for the republish provenance-restoration defect
// (spec section 37, R3 closure pass, live-DEV reproduced 2026-08-20):
// republishPosition() originally wrote back only 3 fields (source_type,
// current_value, cost_base, owner, ii_publication_id, is_active), leaving
// investment_name, institution, country_code, currency_code,
// master_item_key, risk_profile, annual_contribution,
// ii_canonical_account_id, ii_canonical_instrument_id and
// ii_source_quality_status stuck at whatever the row held pre-unpublish.
// Live-DEV proof at the time: after unpublish -> republish, current_value
// correctly read 520000 but investment_name stayed "Original Manual
// Investment" and ii_canonical_account_id stayed null even though
// source_type read 'investment_intelligence_published'.
//
// This test drives the REAL republishPosition() against an in-memory fake
// of the Supabase query-builder chain (this codebase has no existing
// mocked-Supabase unit-test precedent — its DB-touching orchestration layer
// is otherwise verified LIVE-DEV only, per R3_TESTING_AND_VERIFICATION.md —
// so the fake here is deliberately narrow: just enough chain surface for
// this one code path, not a general Supabase mock).

vi.mock('@/lib/services/investment-intelligence/audit', () => ({
  emitAuditEvent: vi.fn().mockResolvedValue({ error: null }),
}));

type Row = Record<string, any>;

function makeFakeSupabase(tables: Record<string, Row[]>) {
  function from(table: string) {
    const source = tables[table] ?? [];
    let rows = [...source];
    let pendingUpdate: Row | null = null;

    const builder: any = {
      select() {
        return builder;
      },
      eq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        rows = rows.filter((r) => r[col] !== val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        rows = rows.filter((r) => vals.includes(r[col]));
        return builder;
      },
      update(payload: Row) {
        pendingUpdate = payload;
        return builder;
      },
      maybeSingle() {
        return applyAndResolve(rows[0] ?? null);
      },
      single() {
        return applyAndResolve(rows[0] ?? null);
      },
      // Update chains in the real code are awaited directly without a
      // terminal .maybeSingle()/.single() call — making the builder itself
      // thenable covers `await supabase.from(x).update(y).eq(...).eq(...)`.
      then(onFulfilled: (v: { data: Row | null; error: null }) => unknown, onRejected?: (e: unknown) => unknown) {
        return applyAndResolve(null).then(onFulfilled, onRejected);
      },
    };

    function applyAndResolve(single: Row | null) {
      if (pendingUpdate) {
        rows.forEach((r) => Object.assign(r, pendingUpdate));
        pendingUpdate = null;
      }
      return Promise.resolve({ data: single, error: null });
    }

    return builder;
  }
  return { from };
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

describe('republishPosition() restores the full certified field set', () => {
  const userId = 'user-1';
  const publicationId = 'pub-1';
  const accountId = 'account-1';
  const instrumentId = 'instrument-1';
  const positionId = 'position-1';
  const publishedRowId = 'investment-1';

  let tables: Record<string, Row[]>;

  beforeEach(() => {
    // Reproduces the exact live-DEV scenario: the investments row was left
    // stale (as if from a much older manual entry) before republish runs.
    tables = {
      ii_fhip_publications: [
        {
          id: publicationId,
          user_id: userId,
          status: 'unpublished',
          account_id: accountId,
          instrument_id: instrumentId,
          canonical_position_id: positionId,
          published_row_id: publishedRowId,
          published_value: 520000,
          published_cost_base: 480000,
          published_owner: 'self',
          source_currency: 'INR',
          source_country: 'IN',
          target_master_item_key: 'managed_funds',
          risk_band: 'moderate',
          published_annual_contribution: 12000,
          last_republished_at: null,
        },
      ],
      ii_accounts: [{ id: accountId, user_id: userId, institution_name: 'HDFC Mutual Fund' }],
      ii_instruments: [{ id: instrumentId, instrument_class: 'mutual_fund', instrument_name: 'HDFC Flexicap Fund', amc_name: null }],
      ii_holding_snapshots: [{ id: positionId, user_id: userId, quality_status: 'reconciled' }],
      investments: [
        {
          id: publishedRowId,
          user_id: userId,
          source_type: 'manual',
          investment_name: 'Original Manual Investment',
          institution: 'Some Other Institution',
          country_code: 'AU',
          currency_code: 'AUD',
          master_item_key: null,
          risk_profile: null,
          annual_contribution: null,
          current_value: 0,
          cost_base: null,
          owner: 'self',
          ii_canonical_account_id: null,
          ii_canonical_instrument_id: null,
          ii_source_quality_status: null,
          ii_publication_id: null,
          is_active: false,
        },
      ],
    };
  });

  it('re-derives investment_name/institution/country/currency/master_item_key/risk/annual_contribution/canonical ids/quality status, not just value/cost_base/owner', async () => {
    (createClient as any).mockResolvedValue(makeFakeSupabase(tables));

    const result = await republishPosition(userId, publicationId);

    expect(result.error).toBeNull();
    expect(result.publicationId).toBe(publicationId);

    const row = tables.investments[0];
    // The 3 fields the original implementation already wrote correctly.
    expect(row.current_value).toBe(520000);
    expect(row.cost_base).toBe(480000);
    expect(row.owner).toBe('self');
    // The fields the defect left stale — this is the regression coverage.
    expect(row.investment_name).toBe('HDFC Flexicap Fund');
    expect(row.investment_type).toBe('managed_fund');
    expect(row.institution).toBe('HDFC Mutual Fund'); // amc_name null -> falls back to account.institution_name
    expect(row.country_code).toBe('IN');
    expect(row.currency_code).toBe('INR');
    expect(row.master_item_key).toBe('managed_funds');
    expect(row.risk_profile).toBe('moderate');
    expect(row.annual_contribution).toBe(12000);
    expect(row.ii_canonical_account_id).toBe(accountId);
    expect(row.ii_canonical_instrument_id).toBe(instrumentId);
    expect(row.ii_source_quality_status).toBe('reconciled');
    expect(row.ii_publication_id).toBe(publicationId);
    expect(row.source_type).toBe('investment_intelligence_published');
    expect(row.is_active).toBe(true);

    expect(tables.ii_fhip_publications[0].status).toBe('published');
  });

  it('prefers the certified instrument amc_name over account institution_name when both are present', async () => {
    tables.ii_instruments[0].amc_name = 'HDFC AMC Certified Name';
    (createClient as any).mockResolvedValue(makeFakeSupabase(tables));

    await republishPosition(userId, publicationId);

    expect(tables.investments[0].institution).toBe('HDFC AMC Certified Name');
  });
});
