/**
 * Canonical-cert UI journey (live on DEV, 2026-09-27): Investments -> Import Australian Investment
 * Statement -> Apply -> "Imported, not yet in Net Worth" -> Add to Net Worth (PO D-05) FAILED for every
 * holding with
 *   "Publication failed and was safely rolled back: invalid input syntax for type uuid:
 *    "fdh11:<statement id>""
 * publishAuStatementPositions passed correlationId `fdh11:${statementId}` to Investment Intelligence's
 * publishPosition, which stores it in ii_fhip_publications.correlation_id -- a UUID column (migration
 * 0042). The insert failed, the publication was compensated, and nothing ever reached Net Worth.
 *
 * The [NC] test fails on the code before the fix with the rejected value named.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFakeDb, type FakeDb } from '../support/fdhFakeSupabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDb, publishOptions: [] as Array<Record<string, unknown>> }));

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.adminClient() }));
vi.mock('@/lib/investment-import-bridge/certifyAuPosition', () => ({ certifyAuPosition: vi.fn(async () => undefined) }));
vi.mock('@/lib/services/investment-intelligence/investmentPublicationService', () => ({
  buildPreview: vi.fn(async () => ({ preview: { alreadyPublished: null }, error: null })),
  refreshPosition: vi.fn(async () => ({ decision: 'REFRESH', error: null })),
  publishPosition: vi.fn(async (_userId: string, _positionId: string, options: Record<string, unknown>) => {
    h.publishOptions.push(options);
    return { publicationId: 'p', publishedRowId: 'r', action: 'ADD_NEW', errorCode: null, error: null };
  }),
}));

const U = 'a0000000-0000-4000-8000-00000000000a';
const ST = 'b0fe4203-1e47-4432-87f2-96ed073bfb8b';
const SNAP = 'c0000000-0000-4000-8000-0000000000c1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
  h.db = createFakeDb();
  h.publishOptions.length = 0;
  h.db.insert('fdh_investment_statements', { id: ST, user_id: U });
  h.db.insert('fdh_investment_statement_positions', { id: 'd0000000-0000-4000-8000-0000000000d1', user_id: U, statement_id: ST, apply_status: 'applied', canonical_holding_snapshot_id: SNAP });
  h.db.insert('ii_holding_snapshots', { id: SNAP, user_id: U, account_id: 'e0000000-0000-4000-8000-0000000000e1', instrument_id: 'f0000000-0000-4000-8000-0000000000f1', as_of_date: '2026-08-31', value: 10000, currency_code: 'AUD', created_at: '2026-09-27T00:00:00Z' });
});

describe('Add to Net Worth (D-05): the correlation id fits ii_fhip_publications.correlation_id (uuid)', () => {
  it('the column really is uuid (anti-vacuity for the assertion below)', () => {
    const sql = fs.readFileSync(path.join(process.cwd(), 'supabase', 'migrations', '0042_ii_r3_fhip_publishing_bridge.sql'), 'utf8');
    expect(sql).toMatch(/alter table ii_fhip_publications add column correlation_id uuid;/);
  });

  it('[NC] every publish call carries a UUID correlation id (before the fix: "fdh11:<statement id>")', async () => {
    const { publishAuStatementPositions } = await import('@/lib/investment-import-bridge/publishAuPositions');
    const out = await publishAuStatementPositions(U, ST, [{ snapshotId: SNAP }]);
    expect(out).toHaveLength(1);
    expect(out[0].ok).toBe(true);
    expect(h.publishOptions).toHaveLength(1);
    const cid = h.publishOptions[0].correlationId as string;
    expect(cid, `correlationId ${cid}`).toMatch(UUID_RE);
    // The run stays traceable to its statement: the statement id is the correlation id.
    expect(cid).toBe(ST);
  });
});
