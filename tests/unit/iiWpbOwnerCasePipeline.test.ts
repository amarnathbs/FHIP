// Document2 (4) WP-B (F8) -- the REAL processSourceDocument pipeline, run on a parsable CAMS fixture against an in-memory database,
// proving the "about 50 owner unmatched" mechanism and its fix end to end:
//   * a statement uploaded with no owner raises ONE owner_unmatched case per folio, and reprocessing it does not raise another;
//   * once a person has chosen the account owner, a reprocess raises none and does not re-block certification;
//   * NEGATIVE CONTROL: an account nobody has assigned is still asked about, and no owner is ever written by the pipeline (never Self).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';
import { buildAieIiCasFixtureText } from '../support/buildAieIiCasFixtureText';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb>, text: '' }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));
vi.mock('@/lib/services/investment-intelligence/storage', async (orig) => ({
  ...(await orig<typeof import('@/lib/services/investment-intelligence/storage')>()),
  downloadSourceDocumentObject: async () => ({ bytes: Buffer.from('pdf'), error: null }),
  deleteSourceDocumentObject: async () => ({ error: null }),
  verifySourceDocumentObjectAbsent: async () => true,
}));
vi.mock('@/lib/services/investment-intelligence/pdfExtraction', () => ({ extractPdfText: async () => ({ ok: true as const, text: h.text }) }));

import { processSourceDocument } from '@/lib/services/investment-intelligence/documentProcessing';

const U = 'user-1';

function seed(accountOwner: string | null) {
  h.text = buildAieIiCasFixtureText();
  h.db = createInMemoryDb({ upsertMerges: true });
  h.db.reset({
    ii_source_documents: [{ id: 'doc1', user_id: U, status: 'uploaded', storage_path: 'u/a.pdf', storage_purged_at: null, mime_type: 'application/pdf', country_code: 'IN', owner_member_id: null, checksum: 'c' }],
    ii_document_parse_runs: [],
    ii_accounts: accountOwner === undefined ? [] : [],
    ii_instruments: [],
    ii_transactions: [],
    ii_holding_snapshots: [],
    ii_reconciliation_cases: [],
    ii_portfolio_truth_status: [],
    ii_ownership_allocation: [],
    ii_audit_events: [],
    household_members: [],
    ii_reconciliation_config: [],
    ii_instrument_aliases: [],
    ii_scheme_aliases: [],
  });
  void accountOwner;
}

const latestTruth = () => [...h.db.tables.ii_portfolio_truth_status].sort((a: Row, b: Row) => String(b.last_evaluated_at).localeCompare(String(a.last_evaluated_at)))[0];
const cases = (type: string) => h.db.tables.ii_reconciliation_cases.filter((c: Row) => c.discrepancy_type === type);

beforeEach(() => seed(null));

describe('owner_unmatched is raised once per folio, never again on reprocess', () => {
  it('REGRESSION: process, then reprocess twice -> still exactly one owner_unmatched case for the folio', async () => {
    const first = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1' });
    expect(first.ok).toBe(true);
    expect(cases('owner_unmatched')).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      h.db.tables.ii_source_documents[0].storage_path = `u/again${i}.pdf`; // a replacement copy makes the file readable again
      h.db.tables.ii_source_documents[0].storage_purged_at = null;
      const again = await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', forceReparse: true });
      expect(again.ok).toBe(true);
    }
    expect(cases('owner_unmatched')).toHaveLength(1); // the old code opened a new one per run
    // HONEST LIMIT: this in-memory database cannot match an existing instrument by name, so each run mints a new provisional one and
    // transaction / holding de-duplication cannot be asserted here. That part is the pre-existing, live-DEV-proven fingerprint
    // path (tests/live-dev/iiPc1LiveDev.test.ts); this suite proves the case and certification behaviour only.
  });

  it('once the person has chosen the account owner, a reprocess raises nothing and the position is not re-blocked as owner-unresolved', async () => {
    await processSourceDocument({ userId: U, sourceDocumentId: 'doc1' });
    const account = h.db.tables.ii_accounts[0];
    // what PATCH .../accounts/[id]/owner does
    account.owner_member_id = 'member-1';
    for (const c of cases('owner_unmatched')) c.status = 'resolved';
    h.db.tables.ii_source_documents[0].storage_purged_at = null;
    await processSourceDocument({ userId: U, sourceDocumentId: 'doc1', forceReparse: true });
    expect(cases('owner_unmatched').filter((c) => c.status === 'open')).toHaveLength(0);
    expect(cases('owner_unmatched')).toHaveLength(1);
    const truth = latestTruth();
    expect((truth.blocking_reasons as { code: string }[]).map((b) => b.code)).not.toContain('unresolved_owner');
  });

  it('NEGATIVE CONTROL: an account nobody assigned is still blocked as owner-unresolved and no owner is ever written by the pipeline', async () => {
    await processSourceDocument({ userId: U, sourceDocumentId: 'doc1' });
    const truth = latestTruth();
    expect((truth.blocking_reasons as { code: string }[]).map((b) => b.code)).toContain('unresolved_owner');
    // the pipeline never assigns an owner to an account: not Self, not anyone
    expect(h.db.tables.ii_accounts.length).toBeGreaterThan(0);
    expect(h.db.tables.ii_accounts.every((a) => a.owner_member_id === null || a.owner_member_id === undefined)).toBe(true);
    expect(h.db.writes.filter((w) => w.table === 'ii_accounts' && w.kind === 'update')).toEqual([]);
  });
});
