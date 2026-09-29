// Review Centre "more resolution actions" (2026-09-29) —
// POST /api/investment-intelligence/source-documents/[id]/discard.
//
// WHY THIS ROUTE EXISTS: a live, read-only production check (twwpnltizhtjxhamyoxt)
// found real open 'unsupported_document' cases with no way to actually be
// resolved from the Review tab — "Acknowledge"/"Dismiss" only touch
// ii_review_items bookkeeping, never ii_source_documents.status or the
// underlying ii_reconciliation_cases row (see reviewCentreData.ts). This
// route is the genuine fix, following the exact admin-client pattern
// accounts/[id]/owner/route.ts already established for owner_unmatched/
// owner_mismatch: verify ownership via the RLS-scoped client, then use the
// service-role admin client for the system-authoritative
// ii_reconciliation_cases write (migration 0087's trigger refuses that
// column to the authenticated role outright).
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockGetUser = vi.fn();
const mockUserFrom = vi.fn();
const mockAdminFrom = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, from: mockUserFrom }),
}));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockAdminFrom }),
}));

import { POST } from '@/app/api/investment-intelligence/source-documents/[id]/discard/route';
import { countryRegistryFrom } from './support/countryRegistryFake';

const USER_ID = 'user-1';
const DOC_ID = 'doc-1';

// Mirrors iiR12PositionsProductionCompat.test.ts's harness for the shared
// Mandatory Country Confirmation gate (requireCountryConfirmedUser), so this
// file's own assertions are about the discard route, not the gate.
function withCountryConfirmed(handleOtherTable: (table: string) => unknown) {
  return (table: string) => {
    const registry = countryRegistryFrom(table);
    if (registry) return registry;
    if (table === 'user_profiles') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: { country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true },
              error: null,
            }),
          }),
        }),
      };
    }
    return handleOtherTable(table);
  };
}

// A minimal thenable chain: every chain method returns the same object so any
// call order (.select().eq().eq()... or .update().eq().eq()) resolves the
// same way once awaited, matching how the real supabase-js query builder is
// thenable at any point in the chain.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function chain(result: unknown): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = {};
  obj.eq = vi.fn(() => obj);
  obj.in = vi.fn(() => obj);
  obj.maybeSingle = vi.fn(async () => result);
  obj.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return obj;
}

interface Harness {
  docStatus: string | null;
  docFound?: boolean;
  openCases?: Array<{ id: string; discrepancy_details: Record<string, unknown> | null }>;
  recordedUpdates: Array<{ table: string; payload: Record<string, unknown> }>;
  recordedAuditInserts: Array<Record<string, unknown>>;
  inArgs: unknown[];
}

function harness(opts: { docStatus: string | null; docFound?: boolean; openCases?: Array<{ id: string; discrepancy_details: Record<string, unknown> | null }> }): Harness {
  const h: Harness = { ...opts, recordedUpdates: [], recordedAuditInserts: [], inArgs: [] };

  mockUserFrom.mockImplementation(
    withCountryConfirmed((table: string) => {
      if (table === 'ii_source_documents') {
        return {
          select: () => chain({ data: h.docFound === false ? null : { id: DOC_ID, status: h.docStatus }, error: null }),
        };
      }
      throw new Error(`unexpected user-scoped table: ${table}`);
    })
  );

  mockAdminFrom.mockImplementation((table: string) => {
    if (table === 'ii_reconciliation_cases') {
      return {
        select: () => {
          const c = chain({ data: h.openCases ?? [], error: null });
          const originalIn = c.in;
          c.in = vi.fn((...args: unknown[]) => {
            h.inArgs.push(args[1]);
            return originalIn(...args);
          });
          return c;
        },
        update: (payload: Record<string, unknown>) => {
          h.recordedUpdates.push({ table: 'ii_reconciliation_cases', payload });
          return chain({ error: null });
        },
      };
    }
    if (table === 'ii_source_documents') {
      return {
        update: (payload: Record<string, unknown>) => {
          h.recordedUpdates.push({ table: 'ii_source_documents', payload });
          return chain({ error: null });
        },
      };
    }
    if (table === 'ii_audit_events') {
      return {
        insert: (payload: Record<string, unknown>) => {
          h.recordedAuditInserts.push(payload);
          return Promise.resolve({ error: null });
        },
      };
    }
    throw new Error(`unexpected admin-scoped table: ${table}`);
  });

  return h;
}

function post(docId: string, body: unknown = {}) {
  return POST(new Request('http://test/api/investment-intelligence/source-documents/x/discard', { method: 'POST', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: docId }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
});

describe('POST /api/investment-intelligence/source-documents/[id]/discard', () => {
  it('401s when unauthenticated', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    harness({ docStatus: 'unsupported' });
    const res = await post(DOC_ID);
    expect(res.status).toBe(401);
  });

  it('404s when the document does not belong to (or does not exist for) the caller', async () => {
    harness({ docStatus: null, docFound: false });
    const res = await post(DOC_ID);
    expect(res.status).toBe(404);
  });

  it('refuses (409) a document that already succeeded — never discards a genuinely processed statement', async () => {
    const h = harness({ docStatus: 'parsed' });
    const res = await post(DOC_ID);
    expect(res.status).toBe(409);
    expect(mockAdminFrom).not.toHaveBeenCalled();
    expect(h.recordedUpdates).toHaveLength(0);
  });

  it('refuses (409) a document that has already been discarded, with a distinct message', async () => {
    harness({ docStatus: 'archived' });
    const res = await post(DOC_ID);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already been discarded/i);
  });

  it('refuses (422) when there is no open discardable case for this document, and never archives it', async () => {
    const h = harness({ docStatus: 'unsupported', openCases: [] });
    const res = await post(DOC_ID);
    expect(res.status).toBe(422);
    expect(h.recordedUpdates.find((u) => u.table === 'ii_source_documents')).toBeUndefined();
  });

  it('queries only the three permanently-dead-end discrepancy types, never owner/ambiguous/cross-source cases', async () => {
    const h = harness({ docStatus: 'unsupported', openCases: [{ id: 'case-1', discrepancy_details: {} }] });
    await post(DOC_ID);
    expect(h.inArgs[0]).toEqual(['unsupported_document', 'document_corrupt', 'parse_incomplete']);
  });

  it('archives the document, resolves the open case with real provenance, and merges discrepancy_details rather than clobbering it', async () => {
    const h = harness({ docStatus: 'unsupported', openCases: [{ id: 'case-1', discrepancy_details: { sourceConfidence: 0, candidates: ['cams'] } }] });
    const res = await post(DOC_ID, { note: 'wrong file uploaded' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.resolvedCaseCount).toBe(1);

    const docUpdate = h.recordedUpdates.find((u) => u.table === 'ii_source_documents');
    expect(docUpdate?.payload).toEqual({ status: 'archived' });

    const caseUpdate = h.recordedUpdates.find((u) => u.table === 'ii_reconciliation_cases');
    expect(caseUpdate?.payload).toMatchObject({
      status: 'resolved',
      resolution_method: 'user_discarded_document',
      resolved_by: USER_ID,
      resolved_by_actor_type: 'user',
    });
    expect(caseUpdate?.payload.discrepancy_details).toMatchObject({
      sourceConfidence: 0,
      candidates: ['cams'],
      discardNote: 'wrong file uploaded',
    });
    expect(typeof (caseUpdate?.payload.discrepancy_details as Record<string, unknown>).discardedAt).toBe('string');
  });

  it('resolves every open discardable case tied to the document, not just the first', async () => {
    const h = harness({
      docStatus: 'reconciliation_required',
      openCases: [
        { id: 'case-1', discrepancy_details: null },
        { id: 'case-2', discrepancy_details: null },
      ],
    });
    const res = await post(DOC_ID);
    expect(res.status).toBe(200);
    expect((await res.json()).data.resolvedCaseCount).toBe(2);
    expect(h.recordedUpdates.filter((u) => u.table === 'ii_reconciliation_cases')).toHaveLength(2);
  });

  it('emits an "archive" audit event recording the previous status and resolved count, never document content', async () => {
    const h = harness({ docStatus: 'parse_failed', openCases: [{ id: 'case-1', discrepancy_details: {} }] });
    await post(DOC_ID, { note: 'bad scan' });
    expect(h.recordedAuditInserts).toHaveLength(1);
    const evt = h.recordedAuditInserts[0];
    expect(evt.event_type).toBe('archive');
    expect(evt.subject_type).toBe('ii_source_documents');
    expect(evt.subject_id).toBe(DOC_ID);
    expect(evt.actor_type).toBe('user');
    expect(evt.metadata).toMatchObject({ previousStatus: 'parse_failed', resolvedCaseCount: 1, note: 'bad scan' });
  });
});
