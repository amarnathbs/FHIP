/**
 * M3 (Phase 4) — the Product Owner's mask-token retention decision,
 * 2026-09-15: "FIXED SHORT TTL (24-48 hours), independent of document
 * lifecycle state", implemented at 48 hours.
 *
 * WHAT M2 FOUND, AND WHAT THIS REPLACES. M2's H.10 verdict was FAIL, with
 * the finding stated as: "Mask token maps — which hold reversible PII under
 * a single global key — are never destroyed. There is no TTL, no purge, no
 * retention policy, and no code path that can delete them." The only
 * theoretical destruction route was `on delete cascade` from
 * `aie_extraction_run`, and nothing ever deletes an extraction run.
 *
 * The most load-bearing assertion below is the LIFECYCLE-INDEPENDENCE one.
 * The Product Owner explicitly accepted that a document still under review
 * past the TTL loses this data, and explicitly instructed that a
 * lifecycle-aware retention rule must NOT be built instead. A future change
 * that "helpfully" started skipping rows whose document is mid-review would
 * be substituting a different policy for the decided one, so it is asserted
 * as a property rather than left to a code comment.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeTokenRow {
  id: string;
  run_id: string;
  token: string;
  created_at: string;
}

let tokenRows: FakeTokenRow[] = [];
let deleteError: { message: string } | null = null;
/** Every filter the code applied, recorded so the test can assert what the
 * query did NOT filter on as well as what it did. */
let observedFilters: Array<{ op: string; col: string; val: unknown }> = [];
const auditEvents: Array<{ eventType: string; metadata?: Record<string, unknown>; intakeId: unknown; userId: unknown }> = [];

function makeMaskTokenQuery() {
  const api = {
    delete: () => {
      const predicates: Array<(r: FakeTokenRow) => boolean> = [];
      const builder = {
        lt(col: 'created_at', val: string) {
          observedFilters.push({ op: 'lt', col, val });
          predicates.push((r) => r.created_at < val);
          return builder;
        },
        eq(col: string, val: unknown) {
          observedFilters.push({ op: 'eq', col, val });
          return builder;
        },
        in(col: string, val: unknown) {
          observedFilters.push({ op: 'in', col, val });
          return builder;
        },
        select() {
          if (deleteError) return Promise.resolve({ data: null, error: deleteError });
          const removed = tokenRows.filter((r) => predicates.every((p) => p(r)));
          tokenRows = tokenRows.filter((r) => !removed.includes(r));
          return Promise.resolve({ data: removed.map((r) => ({ id: r.id })), error: null });
        },
      };
      return builder;
    },
  };
  return api;
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table !== 'aie_mask_token_map') throw new Error(`unexpected table ${table}`);
      return makeMaskTokenQuery();
    },
  }),
}));

vi.mock('@/lib/aie/audit', () => ({
  recordAieAuditEvent: async (e: { eventType: string; metadata?: Record<string, unknown>; intakeId: unknown; userId: unknown }) => {
    auditEvents.push(e);
  },
}));

import { purgeExpiredMaskTokenMaps, AIE_MASK_TOKEN_MAP_TTL_HOURS } from '@/lib/aie/services/purge';

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600_000).toISOString();
}

beforeEach(() => {
  tokenRows = [];
  deleteError = null;
  observedFilters = [];
  auditEvents.length = 0;
});

describe('M3 — mask-token-map fixed TTL (PO decision 2026-09-15)', () => {
  it('the decided TTL is inside the 24-48 hour band the Product Owner specified', () => {
    expect(AIE_MASK_TOKEN_MAP_TTL_HOURS).toBeGreaterThanOrEqual(24);
    expect(AIE_MASK_TOKEN_MAP_TTL_HOURS).toBeLessThanOrEqual(48);
  });

  it('deletes rows older than the TTL and keeps rows inside it', () => {
    tokenRows = [
      { id: 'old-1', run_id: 'run-a', token: '[MASKED:tax_id:hmac:aaaa]', created_at: hoursAgo(72) },
      { id: 'old-2', run_id: 'run-b', token: '[MASKED:folio_number:hmac:bbbb]', created_at: hoursAgo(49) },
      { id: 'fresh-1', run_id: 'run-c', token: '[MASKED:email:hmac:cccc]', created_at: hoursAgo(1) },
    ];
    return purgeExpiredMaskTokenMaps().then((result) => {
      expect(result.deleted).toBe(2);
      expect(result.ttlHours).toBe(AIE_MASK_TOKEN_MAP_TTL_HOURS);
      expect(tokenRows.map((r) => r.id)).toEqual(['fresh-1']);
    });
  });

  it('IS LIFECYCLE-INDEPENDENT — it filters on age ALONE, never on document or run state', async () => {
    // This is the decision, expressed as a property. The query must not
    // consult intake status, purge status, run status, or an "is this
    // document still under review" signal of any kind.
    tokenRows = [{ id: 'old-1', run_id: 'run-a', token: '[MASKED:tax_id:hmac:aaaa]', created_at: hoursAgo(100) }];
    await purgeExpiredMaskTokenMaps();

    expect(observedFilters).toHaveLength(1);
    expect(observedFilters[0]).toMatchObject({ op: 'lt', col: 'created_at' });
    const filteredColumns = observedFilters.map((f) => f.col);
    for (const lifecycleColumn of ['status', 'purge_status', 'run_id', 'intake_id', 'purged_at']) {
      expect(filteredColumns).not.toContain(lifecycleColumn);
    }
  });

  it('deletes an expired row belonging to a run that is still mid-review — the accepted consequence, asserted', async () => {
    // The Product Owner was explicit that this is the intended trade-off.
    // The sweep has no way to know the run is mid-review and must not gain one.
    tokenRows = [{ id: 'under-review', run_id: 'run-still-awaiting-acceptance', token: '[MASKED:folio_number:hmac:zzzz]', created_at: hoursAgo(60) }];
    const result = await purgeExpiredMaskTokenMaps();
    expect(result.deleted).toBe(1);
    expect(tokenRows).toHaveLength(0);
  });

  it('accepts an explicit shorter TTL, so the decided band can be tightened without a code change to the sweep', async () => {
    tokenRows = [
      { id: 'a', run_id: 'r', token: 't', created_at: hoursAgo(30) },
      { id: 'b', run_id: 'r', token: 't', created_at: hoursAgo(10) },
    ];
    const result = await purgeExpiredMaskTokenMaps(24);
    expect(result.deleted).toBe(1);
    expect(result.ttlHours).toBe(24);
  });

  it('audits a real deletion with the COUNT and the policy, and no subject', async () => {
    tokenRows = [{ id: 'old-1', run_id: 'run-a', token: '[MASKED:tax_id:hmac:aaaa]', created_at: hoursAgo(72) }];
    await purgeExpiredMaskTokenMaps();

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].eventType).toBe('mask_token_map_ttl_purged');
    expect(auditEvents[0].metadata?.deleted_rows).toBe(1);
    expect(auditEvents[0].metadata?.ttl_hours).toBe(AIE_MASK_TOKEN_MAP_TTL_HOURS);
    // A time-driven retention event has no subject — recording one would
    // re-identify whose data the sweep just destroyed, in the audit log, which
    // defeats the point of destroying it.
    expect(auditEvents[0].intakeId).toBeNull();
    expect(auditEvents[0].userId).toBeNull();
  });

  it('writes NO audit row when nothing expired — the sweep runs every cycle and must not spam the log', async () => {
    tokenRows = [{ id: 'fresh', run_id: 'r', token: 't', created_at: hoursAgo(1) }];
    const result = await purgeExpiredMaskTokenMaps();
    expect(result.deleted).toBe(0);
    expect(auditEvents).toHaveLength(0);
  });

  it('a delete failure reports zero deleted rather than claiming a purge that did not happen', async () => {
    tokenRows = [{ id: 'old-1', run_id: 'run-a', token: 't', created_at: hoursAgo(72) }];
    deleteError = { message: 'connection reset' };
    const result = await purgeExpiredMaskTokenMaps();
    expect(result.deleted).toBe(0);
    expect(auditEvents).toHaveLength(0);
    // The row survives to be retried on the next sweep, rather than being
    // recorded as destroyed while still present — the same "a delete call
    // returning success is not proof" discipline the binary purge follows.
    expect(tokenRows).toHaveLength(1);
  });
});
