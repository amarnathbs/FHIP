// Document2 (4) WP-B (F5/F6/F7/F8/F14) -- BEHAVIOURAL tests of the governed housekeeping service, the Review sync, the dismissed-item
// regeneration fix and the idempotent case opening, against an in-memory database that applies every filter for real.
//
// Negative controls throughout: an owner question for an account with NO explicit owner stays open (never guessed, never Self);
// a case that can still be resolved directly is never closed as stale; another user's case is never touched.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type Row } from './support/inMemorySupabase';

const h = vi.hoisted(() => ({ db: null as unknown as ReturnType<typeof import('./support/inMemorySupabase').createInMemoryDb> }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => h.db.client }));
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => h.db.client }));

import { closeStaleCases, loadOpenCasesWithLifecycle, tidyOwnerAndDuplicateCases } from '@/lib/services/investment-intelligence/staleCases';
import { openReconciliationCase } from '@/lib/services/investment-intelligence/reconciliationCases';
import { loadExplicitOwnerAccountIds } from '@/lib/services/investment-intelligence/accountOwnership';
import { syncReviewItemsWithCases, upsertReviewItems, attachLifecycleToReviewItems } from '@/lib/services/investment-intelligence/reviewCentreData';
import { detectOpenReconciliationCases } from '@/lib/engines/investment-intelligence/reviewCentre';
import type { IiReviewItem } from '@/lib/services/investment-intelligence/types';

const U = 'user-1';
const OTHER = 'user-2';

function caseRow(over: Row): Row {
  return {
    user_id: U,
    subject_type: 'account',
    severity: 'blocking',
    status: 'open',
    discrepancy_details: {},
    opened_at: '2026-10-01T00:00:00Z',
    source_document_id: null,
    ...over,
  };
}

function seed(extra: Record<string, Row[]> = {}) {
  h.db.reset({
    ii_reconciliation_cases: [],
    ii_source_documents: [],
    ii_holding_snapshots: [],
    ii_transactions: [],
    ii_accounts: [],
    ii_ownership_allocation: [],
    ii_audit_events: [],
    ii_review_items: [],
    ...extra,
  });
}

beforeEach(() => {
  h.db = createInMemoryDb();
  seed();
});

const cases = () => h.db.tables.ii_reconciliation_cases;
const byId = (id: string) => cases().find((c) => c.id === id) as Row;

describe('closeStaleCases: the governed "Close stale case"', () => {
  it('closes a password-required case whose file was deleted, keeps it as history, archives the empty statement and audits it', async () => {
    seed({
      ii_source_documents: [{ id: 'doc1', user_id: U, status: 'password_required', storage_path: 'u/a.pdf', storage_purged_at: '2026-10-02T00:00:00Z' }],
      ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'doc1', discrepancy_type: 'document_password_required', source_document_id: 'doc1' })],
    });
    const res = await closeStaleCases(h.db.client as never, U, { caseIds: ['c1'], note: 'no longer have it' });

    expect(res.closed).toEqual(['c1']);
    // history is kept: the row still exists, now resolved with an honest method and the evidence of why
    const row = byId('c1');
    expect(row.status).toBe('resolved');
    expect(row.resolution_method).toBe('user_closed_stale_case');
    expect(row.resolved_by).toBe(U);
    expect((row.discrepancy_details as Record<string, unknown>).closedStale).toMatchObject({ need: 'information_no_longer_exists', fileStored: false, note: 'no longer have it' });
    // the empty statement is archived (not deleted)
    expect(res.archivedDocumentIds).toEqual(['doc1']);
    expect(h.db.tables.ii_source_documents.find((d) => d.id === 'doc1')?.status).toBe('archived');
    // audit trail
    const events = h.db.tables.ii_audit_events.map((e) => e.event_type);
    expect(events).toContain('reconciliation_case_resolved');
    expect(events).toContain('archive');
    // nothing was deleted
    expect(h.db.writes.some((w) => w.kind === 'delete')).toBe(false);
  });

  it('NEGATIVE CONTROL: refuses a case that can still be resolved directly (an owner question), even when the file is gone', async () => {
    seed({
      ii_source_documents: [{ id: 'doc1', user_id: U, status: 'parsed', storage_path: 'u/a.pdf', storage_purged_at: '2026-10-02T00:00:00Z' }],
      ii_holding_snapshots: [{ id: 's1', user_id: U, source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' }],
      ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' })],
    });
    const res = await closeStaleCases(h.db.client as never, U, { caseIds: ['c1'] });
    expect(res.closed).toEqual([]);
    expect(res.refused[0].reason).toMatch(/can still be resolved directly/);
    expect(byId('c1').status).toBe('open');
  });

  it('NEGATIVE CONTROL: refuses while the file is still stored (the password flow works then)', async () => {
    seed({
      ii_source_documents: [{ id: 'doc1', user_id: U, status: 'password_required', storage_path: 'u/a.pdf', storage_purged_at: null }],
      ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'doc1', discrepancy_type: 'document_password_required', source_document_id: 'doc1' })],
    });
    const res = await closeStaleCases(h.db.client as never, U, { caseIds: ['c1'] });
    expect(res.closed).toEqual([]);
    expect(byId('c1').status).toBe('open');
  });

  it("never touches another user's case, and reports it as not open (non-enumerating)", async () => {
    seed({
      ii_source_documents: [{ id: 'doc9', user_id: OTHER, status: 'password_required', storage_path: 'x', storage_purged_at: '2026-10-02T00:00:00Z' }],
      ii_reconciliation_cases: [caseRow({ id: 'c9', user_id: OTHER, subject_id: 'doc9', discrepancy_type: 'document_password_required', source_document_id: 'doc9' })],
    });
    const res = await closeStaleCases(h.db.client as never, U, { caseIds: ['c9'] });
    expect(res.closed).toEqual([]);
    expect(res.refused[0].reason).toMatch(/not open|does not exist/);
    expect(byId('c9').status).toBe('open');
    expect(h.db.tables.ii_source_documents[0].status).toBe('password_required');
  });

  it('a statement that DID produce data stays as it is and its positions are re-evaluated from the retained data', async () => {
    seed({
      ii_source_documents: [{ id: 'doc1', user_id: U, status: 'parsed', storage_path: 'u/a.pdf', storage_purged_at: '2026-10-02T00:00:00Z' }],
      ii_holding_snapshots: [
        { id: 's1', user_id: U, source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' },
        { id: 's2', user_id: U, source_document_id: 'doc1', account_id: 'a1', instrument_id: 'i1' }, // same position, older snapshot
        { id: 's3', user_id: U, source_document_id: 'doc1', account_id: 'a2', instrument_id: 'i2' },
      ],
      ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'a1', discrepancy_type: 'value_mismatch', source_document_id: 'doc1' })],
    });
    const recertify = vi.fn(async () => ({ ok: true }));
    const res = await closeStaleCases(h.db.client as never, U, { caseIds: ['c1'], recertify });
    expect(res.closed).toEqual(['c1']);
    expect(res.archivedDocumentIds).toEqual([]);
    expect(h.db.tables.ii_source_documents[0].status).toBe('parsed');
    expect(recertify).toHaveBeenCalledTimes(2); // one per distinct position
    expect(res.recertified).toBe(2);
  });

  it('bulk mode (no ids) closes exactly the stale ones and leaves the resolvable ones open', async () => {
    seed({
      ii_source_documents: [
        { id: 'docA', user_id: U, status: 'password_required', storage_path: 'a', storage_purged_at: '2026-10-02T00:00:00Z' },
        { id: 'docB', user_id: U, status: 'parsed', storage_path: 'b', storage_purged_at: '2026-10-02T00:00:00Z' },
      ],
      ii_holding_snapshots: [{ id: 's1', user_id: U, source_document_id: 'docB', account_id: 'a1', instrument_id: 'i1' }],
      ii_reconciliation_cases: [
        caseRow({ id: 'stale1', subject_id: 'docA', discrepancy_type: 'document_password_required', source_document_id: 'docA' }),
        caseRow({ id: 'owner1', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'docB' }),
        caseRow({ id: 'class1', subject_id: 't1', subject_type: 'transaction', discrepancy_type: 'transaction_unclassified', source_document_id: 'docB' }),
      ],
    });
    const res = await closeStaleCases(h.db.client as never, U, {});
    expect(res.closed).toEqual(['stale1']);
    expect(byId('owner1').status).toBe('open');
    expect(byId('class1').status).toBe('open');
  });
});

describe('loadOpenCasesWithLifecycle', () => {
  it('a case pointing at a statement row that no longer exists is stale (nothing left to act on)', async () => {
    seed({ ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'gone', discrepancy_type: 'transaction_missing_from_restatement', source_document_id: 'gone' })] });
    const [item] = await loadOpenCasesWithLifecycle(h.db.client as never, U);
    expect(item.lifecycle.staleClosable).toBe(true);
  });
});

describe('F8: tidyOwnerAndDuplicateCases (about 50 owner_unmatched rows)', () => {
  it('closes owner questions for accounts whose owner a person already chose, leaves the rest open, and the open count falls correctly', async () => {
    seed({
      ii_accounts: [
        { id: 'a1', user_id: U, owner_member_id: 'member-self' }, // explicit earlier choice
        { id: 'a2', user_id: U, owner_member_id: null }, // never chosen
        { id: 'a3', user_id: U, owner_member_id: null }, // decided as a joint/entity allocation
      ],
      ii_ownership_allocation: [{ id: 'al1', user_id: U, ii_account_id: 'a3', ii_instrument_id: null, status: 'active', owner_member_id: null, owner_business_entity_id: 'ent1' }],
      ii_reconciliation_cases: [
        caseRow({ id: 'c1', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' }),
        caseRow({ id: 'c2', subject_id: 'a2', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' }),
        caseRow({ id: 'c3', subject_id: 'a3', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' }),
      ],
    });
    const openBefore = cases().filter((c) => c.status === 'open').length;
    const res = await tidyOwnerAndDuplicateCases(h.db.client as never, U);
    expect(openBefore).toBe(3);
    expect(res.closedExistingOwner.sort()).toEqual(['c1', 'c3']);
    expect(cases().filter((c) => c.status === 'open').map((c) => c.id)).toEqual(['c2']);
    expect(byId('c1').resolution_method).toBe('auto_resolved_existing_owner');
    expect(byId('c1').resolved_by_actor_type).toBe('system');
    // NEGATIVE CONTROL: never guessed. The account with no explicit owner is untouched and no owner was written anywhere.
    expect(h.db.tables.ii_accounts.find((a) => a.id === 'a2')?.owner_member_id).toBeNull();
    expect(h.db.writes.filter((w) => w.table === 'ii_accounts')).toEqual([]);
  });

  it('collapses exact duplicates opened by repeated reprocessing, keeping the oldest, so 5 copies for one account become 1', async () => {
    seed({
      ii_accounts: [{ id: 'a2', user_id: U, owner_member_id: null }],
      ii_reconciliation_cases: [1, 2, 3, 4, 5].map((n) => caseRow({ id: `c${n}`, subject_id: 'a2', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1', opened_at: `2026-10-0${n}T00:00:00Z` })),
    });
    const res = await tidyOwnerAndDuplicateCases(h.db.client as never, U);
    expect(res.closedDuplicates).toHaveLength(4);
    expect(cases().filter((c) => c.status === 'open').map((c) => c.id)).toEqual(['c1']);
    expect((byId('c3').discrepancy_details as Record<string, unknown>).duplicateOfCaseId).toBe('c1');
    // history kept: all five rows still exist
    expect(cases()).toHaveLength(5);
  });

  it('does not merge different accounts, different types or different statements', async () => {
    seed({
      ii_accounts: [
        { id: 'a1', user_id: U, owner_member_id: null },
        { id: 'a2', user_id: U, owner_member_id: null },
      ],
      ii_reconciliation_cases: [
        caseRow({ id: 'c1', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' }),
        caseRow({ id: 'c2', subject_id: 'a2', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' }),
        caseRow({ id: 'c3', subject_id: 'a1', discrepancy_type: 'owner_mismatch', source_document_id: 'doc1' }),
        caseRow({ id: 'c4', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc2' }),
      ],
    });
    const res = await tidyOwnerAndDuplicateCases(h.db.client as never, U);
    expect(res.closedDuplicates).toEqual([]);
    expect(cases().every((c) => c.status === 'open')).toBe(true);
  });

  it("is per user: another user's duplicates and explicit owners are never read or changed", async () => {
    seed({
      ii_accounts: [{ id: 'aX', user_id: OTHER, owner_member_id: 'm' }],
      ii_reconciliation_cases: [caseRow({ id: 'cX', user_id: OTHER, subject_id: 'aX', discrepancy_type: 'owner_unmatched', source_document_id: 'd' })],
    });
    const res = await tidyOwnerAndDuplicateCases(h.db.client as never, U);
    expect(res.closedExistingOwner).toEqual([]);
    expect(byId('cX').status).toBe('open');
  });
});

describe('F8: openReconciliationCase is idempotent on request (a reprocess no longer opens a second case)', () => {
  const input = { subjectType: 'account' as const, subjectId: 'a1', discrepancyType: 'owner_unmatched', severity: 'blocking' as const, sourceDocumentId: 'doc1', details: { reason: 'x' }, idempotent: {} };

  it('12 folios reprocessed 4 times produce 12 cases, not 48', async () => {
    for (let run = 0; run < 4; run++) {
      for (let f = 1; f <= 12; f++) await openReconciliationCase(U, { ...input, subjectId: `a${f}` });
    }
    expect(cases()).toHaveLength(12);
  });

  it('CONTROL: without the flag the old behaviour (a new row every call) is unchanged for callers that never asked for it', async () => {
    const { idempotent: _unused, ...legacy } = input;
    void _unused;
    await openReconciliationCase(U, legacy);
    await openReconciliationCase(U, legacy);
    expect(cases()).toHaveLength(2);
  });

  it('a resolved case does not block a genuinely new one (only OPEN cases are reused)', async () => {
    const first = await openReconciliationCase(U, input);
    byId(first as string).status = 'resolved';
    const second = await openReconciliationCase(U, input);
    expect(second).not.toBe(first);
    expect(cases()).toHaveLength(2);
  });

  it('the discriminator keeps independent cases of one subject apart (one per instrument)', async () => {
    const base = { ...input, discrepancyType: 'transaction_missing_from_restatement', severity: 'medium' as const, idempotent: { discriminator: 'instrumentId' } };
    await openReconciliationCase(U, { ...base, details: { instrumentId: 'i1' } });
    await openReconciliationCase(U, { ...base, details: { instrumentId: 'i2' } });
    await openReconciliationCase(U, { ...base, details: { instrumentId: 'i1' } });
    expect(cases()).toHaveLength(2);
  });
});

describe('loadExplicitOwnerAccountIds', () => {
  it('counts a sole-member pointer and an active whole-account allocation; nothing else', async () => {
    seed({
      ii_accounts: [
        { id: 'a1', user_id: U, owner_member_id: 'm1' },
        { id: 'a2', user_id: U, owner_member_id: null },
        { id: 'a3', user_id: U, owner_member_id: null },
        { id: 'a4', user_id: U, owner_member_id: null },
      ],
      ii_ownership_allocation: [
        { id: 'al1', user_id: U, ii_account_id: 'a3', ii_instrument_id: null, status: 'active' },
        { id: 'al2', user_id: U, ii_account_id: 'a4', ii_instrument_id: 'i1', status: 'active' }, // instrument-level only: not an account decision
      ],
    });
    const set = await loadExplicitOwnerAccountIds(h.db.client as never, U, ['a1', 'a2', 'a3', 'a4']);
    expect([...set].sort()).toEqual(['a1', 'a3']);
  });
});

describe('F7: a dismissed Review item must not come straight back on the next refresh', () => {
  const rule = { ruleKey: 'reconciliation_open', ruleVersion: 'r9-1.0.0', reviewType: 'data_quality', category: 'reconciliation_open', defaultSeverity: 'medium', complianceClassification: 'observation', thresholdConfig: {} } as never;
  const candidate = (details: Record<string, unknown> = {}) =>
    detectOpenReconciliationCases(U, [{ id: 'case-1', subjectType: 'account', subjectId: 'a1', discrepancyType: 'owner_mismatch', openedAt: '2026-10-01T00:00:00Z', sourceDocumentId: 'doc1', discrepancyDetails: details }], '2026-10-20', rule);

  it('REGRESSION: dismiss, refresh again with unchanged evidence -> still ONE row, still dismissed (the old code inserted a fresh open row)', async () => {
    await upsertReviewItems(h.db.client as never, U, candidate());
    expect(h.db.tables.ii_review_items).toHaveLength(1);
    h.db.tables.ii_review_items[0].status = 'dismissed'; // what dismissReviewItem does
    const res = await upsertReviewItems(h.db.client as never, U, candidate());
    expect(res.created).toBe(0);
    expect(h.db.tables.ii_review_items).toHaveLength(1);
    expect(h.db.tables.ii_review_items[0].status).toBe('dismissed');
  });

  it('CONTROL: when the underlying evidence really changes, the item is raised again (a dismissal is not forever blind)', async () => {
    await upsertReviewItems(h.db.client as never, U, candidate({ outcomeKind: 'mismatch' }));
    h.db.tables.ii_review_items[0].status = 'dismissed';
    const res = await upsertReviewItems(h.db.client as never, U, candidate({ outcomeKind: 'ambiguous' }));
    expect(res.created).toBe(1);
    expect(h.db.tables.ii_review_items.filter((r) => r.status === 'open')).toHaveLength(1);
  });

  it('CONTROL: an acknowledged item keeps its existing behaviour (stays acknowledged, no second row)', async () => {
    await upsertReviewItems(h.db.client as never, U, candidate());
    h.db.tables.ii_review_items[0].status = 'acknowledged';
    await upsertReviewItems(h.db.client as never, U, candidate());
    expect(h.db.tables.ii_review_items).toHaveLength(1);
    expect(h.db.tables.ii_review_items[0].status).toBe('acknowledged');
  });
});

describe('F6/F13: syncReviewItemsWithCases clears items whose case is no longer open', () => {
  const item = (id: string, caseId: string, status = 'open'): Row => ({ id, user_id: U, rule_key: 'reconciliation_open', status, evidence: { caseId } });

  it('resolves the item of a case closed elsewhere and leaves the item of a still-open case alone', async () => {
    seed({
      ii_reconciliation_cases: [
        caseRow({ id: 'closed', subject_id: 'a1', discrepancy_type: 'owner_unmatched', status: 'resolved' }),
        caseRow({ id: 'still-open', subject_id: 'a2', discrepancy_type: 'owner_unmatched' }),
      ],
      ii_accounts: [{ id: 'a2', user_id: U, owner_member_id: null }],
      ii_review_items: [item('r1', 'closed'), item('r2', 'still-open'), item('r3', 'closed', 'acknowledged')],
    });
    const res = await syncReviewItemsWithCases(U);
    expect(res.resolvedItems).toBe(2);
    const status = (id: string) => h.db.tables.ii_review_items.find((r) => r.id === id)?.status;
    expect(status('r1')).toBe('resolved');
    expect(status('r3')).toBe('resolved');
    expect(status('r2')).toBe('open');
  });

  it('also tidies the already-answered owner question first, so its Review item clears in the same call (the count falls)', async () => {
    seed({
      ii_accounts: [{ id: 'a1', user_id: U, owner_member_id: 'member-self' }],
      ii_reconciliation_cases: [caseRow({ id: 'cq', subject_id: 'a1', discrepancy_type: 'owner_unmatched', source_document_id: 'doc1' })],
      ii_review_items: [item('r1', 'cq')],
    });
    const res = await syncReviewItemsWithCases(U);
    expect(res.closedExistingOwner).toBe(1);
    expect(res.resolvedItems).toBe(1);
    expect(h.db.tables.ii_review_items[0].status).toBe('resolved');
  });

  it("does not touch another user's items", async () => {
    seed({ ii_review_items: [{ id: 'rX', user_id: OTHER, rule_key: 'reconciliation_open', status: 'open', evidence: { caseId: 'nope' } }] });
    await syncReviewItemsWithCases(U);
    expect(h.db.tables.ii_review_items[0].status).toBe('open');
  });
});

describe('F6: attachLifecycleToReviewItems gives every reconciliation item the live lifecycle', () => {
  it('a password-required item whose statement file was deleted carries a stale, replacement-first lifecycle', async () => {
    seed({
      ii_source_documents: [{ id: 'doc1', user_id: U, status: 'password_required', storage_path: 'a', storage_purged_at: '2026-10-02T00:00:00Z' }],
      ii_reconciliation_cases: [caseRow({ id: 'c1', subject_id: 'doc1', discrepancy_type: 'document_password_required', source_document_id: 'doc1' })],
    });
    const items = [{ id: 'r1', rule_key: 'reconciliation_open', evidence: { caseId: 'c1' } }, { id: 'r2', rule_key: 'goal_forecast_gap', evidence: {} }] as unknown as IiReviewItem[];
    const out = await attachLifecycleToReviewItems(U, items);
    expect(out[0].lifecycle?.primary).toBe('upload_replacement');
    expect(out[0].lifecycle?.staleClosable).toBe(true);
    // a non-reconciliation item carries none
    expect(out[1].lifecycle).toBeNull();
  });
});
