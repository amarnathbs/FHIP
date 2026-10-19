// Cross-tenant denial for the durable AI drafts (UNIT-TESTED against an in-memory table that honours every filter the code applies).
//
// A draft is claimed, loaded, discarded, released and counted ONLY for the owning user and document. Person B holding person A's document id
// (a guessed id, a forwarded link, a replayed request) gets "nothing pending" from every function and changes nothing. A control shows the
// same calls DO work for the owner, so the denial is the filter and not a broken fake. The database level (RLS, no write policy) is proven
// by the repository's FDH-1 isolation suites; the route level was DEV-verified on 19/10/2026 (another Premium account: 404 on process and
// confirm, a Free account: 403 on confirm).
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
const { store } = vi.hoisted(() => ({ store: { rows: [] as Row[] } }));

vi.mock('@/lib/supabase/admin', () => {
  function table() {
    let mode: 'select' | 'update' | 'insert' = 'select';
    let patch: Row = {};
    let inserted: Row | null = null;
    const filters: Array<(r: Row) => boolean> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      limit: () => builder,
      update: (p: Row) => { mode = 'update'; patch = p; return builder; },
      insert: (p: Row) => { mode = 'insert'; inserted = { id: `draft-${store.rows.length + 1}`, status: 'pending_review', ...p }; return builder; },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return builder; },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return builder; },
      single: async () => ({ data: inserted ? (store.rows.push(inserted), inserted) : null, error: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        const run = async () => {
          if (mode === 'insert') { store.rows.push(inserted as Row); return { data: inserted, error: null }; }
          const matched = store.rows.filter((r) => filters.every((f) => f(r)));
          if (mode === 'update') { matched.forEach((r) => Object.assign(r, patch)); return { data: matched.map((r) => ({ id: r.id, payload: r.payload })), error: null }; }
          return { data: matched.map((r) => ({ id: r.id, payload: r.payload, statement_upload_id: r.statement_upload_id })), error: null };
        };
        return run().then(resolve, reject);
      },
    };
    return builder;
  }
  return { createAdminClient: () => ({ from: () => table() }) };
});

import {
  claimPendingAiFallbackDraft,
  loadPendingAiFallbackDraft,
  discardPendingAiFallbackDraft,
  hasConfirmedAiFallbackDraft,
  releaseClaimedAiFallbackDraft,
  saveAiFallbackDraft,
} from '@/lib/financial-data-hub/services/aiFallbackDrafts';

const A = 'user-a';
const B = 'user-b';
const DOC_A = 'doc-of-a';

beforeEach(() => {
  store.rows = [{ id: 'draft-A', user_id: A, statement_upload_id: DOC_A, document_type: 'bank_statement', status: 'pending_review', payload: { rows: [1, 2, 3] } }];
});

describe('person B cannot read, claim, discard, release or confirm-check person A\'s draft', () => {
  it('load: nothing pending for B', async () => {
    expect(await loadPendingAiFallbackDraft(B, DOC_A)).toEqual({ found: false, reason: 'none_pending' });
  });
  it('claim (the accept step): nothing to claim for B, and A\'s draft is untouched', async () => {
    expect(await claimPendingAiFallbackDraft({ userId: B, documentId: DOC_A, confirmedPayload: { forged: true } })).toEqual({ claimed: false, reason: 'none_pending' });
    expect(store.rows[0].status).toBe('pending_review');
    expect(store.rows[0].confirmed_payload).toBeUndefined();
  });
  it('discard: B discards nothing', async () => {
    expect(await discardPendingAiFallbackDraft(B, DOC_A)).toEqual({ discarded: false });
    expect(store.rows[0].status).toBe('pending_review');
  });
  it('confirmed-check and release: B sees nothing confirmed and releases nothing', async () => {
    store.rows[0].status = 'confirmed';
    expect(await hasConfirmedAiFallbackDraft(B, DOC_A)).toBe(false);
    await releaseClaimedAiFallbackDraft(B, 'draft-A');
    expect(store.rows[0].status).toBe('confirmed');
  });
  it('saving a draft for B on A\'s document id supersedes nothing of A\'s', async () => {
    await saveAiFallbackDraft({ userId: B, documentId: DOC_A, documentType: 'bank_statement', schemaName: 's', schemaVersion: '1', payload: { x: 1 } });
    expect(store.rows.find((r) => r.id === 'draft-A')!.status).toBe('pending_review');
  });
  it('CONTROL: the owner can load, claim once, and the replay finds nothing (the filter is what denies B, not a broken fake)', async () => {
    expect((await loadPendingAiFallbackDraft(A, DOC_A)).found).toBe(true);
    expect((await claimPendingAiFallbackDraft({ userId: A, documentId: DOC_A, confirmedPayload: { ok: true } })).claimed).toBe(true);
    expect(await claimPendingAiFallbackDraft({ userId: A, documentId: DOC_A, confirmedPayload: { ok: true } })).toEqual({ claimed: false, reason: 'none_pending' });
    expect(await hasConfirmedAiFallbackDraft(A, DOC_A)).toBe(true);
    expect(await hasConfirmedAiFallbackDraft(B, DOC_A)).toBe(false);
  });
});
