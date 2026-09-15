/**
 * AIE-1 closure mission — unit coverage for `lib/aie/services/purge.ts`,
 * the retention/purge job AIE never had before this mission. DEV/production
 * live verification is BLOCKED (migration 0149, which adds the
 * `purge_status`/`purge_due_at`/etc. columns this module reads and writes,
 * cannot be applied from this session — no DDL execution channel exists;
 * see the migration's own header). This suite proves the SAFETY LOGIC using
 * an in-memory fake Supabase client, matching this repo's own established
 * pattern (`tests/unit/accountDeletionStorage.test.ts`) for storage/DB code
 * that would otherwise need a real database to exercise.
 *
 * The properties that matter most (mission section 9): never mark a row
 * `purged` on a delete-call success alone; verify absence independently;
 * bounded retry with a sanitised error, never silently dropped; the hard
 * age-backstop schedules by age regardless of current status.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeIntakeRow {
  id: string;
  user_id: string;
  status: string;
  storage_key: string | null;
  purge_status: 'not_required' | 'pending' | 'in_progress' | 'purged' | 'failed';
  purge_attempt_count: number;
  purge_due_at: string | null;
  created_at: string;
}

let intakeRows: Record<string, FakeIntakeRow> = {};
let storageObjects: Set<string> = new Set();
let deleteShouldFail = false;
let verifyShouldLie = false; // simulate "delete succeeded but object still listed"
const auditEvents: Array<{ eventType: string }> = [];

function makeIntakeQuery() {
  const andFilters: Array<(r: FakeIntakeRow) => boolean> = [];
  const api = {
    select: () => api,
    in: (col: 'purge_status', vals: string[]) => {
      andFilters.push((r) => vals.includes((r as never as Record<string, string>)[col]));
      return api;
    },
    not: (col: string, _op: string, val: unknown) => {
      andFilters.push((r) => {
        const value = (r as unknown as Record<string, unknown>)[col];
        if (val === null) return value !== null;
        // `.not(col, 'in', '(a,b)')` shape used by the hard backstop query.
        if (typeof val === 'string' && val.startsWith('(')) {
          const excluded = val.slice(1, -1).split(',');
          return !excluded.includes(String(value));
        }
        return value !== val;
      });
      return api;
    },
    lte: (col: 'purge_due_at' | 'created_at', val: string) => {
      andFilters.push((r) => {
        const v = (r as never as Record<string, string | null>)[col];
        return v !== null && v <= val;
      });
      return api;
    },
    order: () => api,
    limit: (n: number) => {
      const rows = Object.values(intakeRows)
        .filter((r) => andFilters.every((f) => f(r)))
        .slice(0, n);
      return { returns: async () => ({ data: rows }) };
    },
    eq: (col: 'id' | 'status', val: string) => {
      andFilters.push((r) => (r as never as Record<string, string>)[col] === val);
      return api;
    },
    // Both `update(...).eq(a)` (one filter) and `update(...).eq(a).eq(b)`
    // (two filters, the CAS-style call in `finalizeDocumentBinaryAfterRun`)
    // are used by the real code. `.eq()` only ACCUMULATES filters and
    // returns a thenable/chainable builder; the patch is applied exactly
    // once, lazily, when the caller finally `await`s the chain (mirroring
    // how a real PostgREST query builder only executes on await) — applying
    // eagerly on each intermediate `.eq()` call would apply the patch
    // against a too-narrow filter set and corrupt CAS-style multi-`.eq()`
    // updates.
    update: (patch: Partial<FakeIntakeRow>) => {
      const updateFilters: Array<(r: FakeIntakeRow) => boolean> = [];
      const execute = (): { error: unknown } => {
        const target = Object.values(intakeRows).find((r) => updateFilters.every((f) => f(r)));
        return target ? (Object.assign(target, patch), { error: null }) : { error: { code: 'no_match' } };
      };
      const builder = {
        eq(col: 'id' | 'status', val: string) {
          updateFilters.push((r) => (r as never as Record<string, string>)[col] === val);
          return builder;
        },
        // M12C (M2-OPEN-2): `finalizeDocumentBinaryAfterRun`'s retry path now
        // guards its write with `.neq('purge_status', 'purged')` so it can
        // never resurrect an already-purged row. Same lazy semantics as
        // `.eq()` above — accumulate a filter, execute once on await.
        neq(col: 'id' | 'status' | 'purge_status', val: string) {
          updateFilters.push((r) => (r as never as Record<string, string>)[col] !== val);
          return builder;
        },
        then(resolve: (v: { error: unknown }) => void) {
          resolve(execute());
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
      if (table !== 'aie_document_intake') throw new Error(`unexpected table ${table}`);
      return makeIntakeQuery();
    },
    storage: {
      from: () => ({
        remove: async (keys: string[]) => {
          if (deleteShouldFail) return { error: { message: 'https://storage.example/secret-path failed' } };
          keys.forEach((k) => storageObjects.delete(k));
          return { error: null };
        },
        list: async (_dir: string, opts: { search: string }) => {
          if (verifyShouldLie) return { data: [{ name: opts.search }], error: null };
          const present = [...storageObjects].some((k) => k.endsWith(opts.search));
          return { data: present ? [{ name: opts.search }] : [], error: null };
        },
      }),
    },
  }),
}));

vi.mock('@/lib/aie/audit', () => ({
  recordAieAuditEvent: async (e: { eventType: string }) => {
    auditEvents.push({ eventType: e.eventType });
  },
}));

import { runPurgeAttempt, findDuePurges, enforceAieRawFileHardBackstop, finalizeDocumentBinaryAfterRun } from '@/lib/aie/services/purge';

beforeEach(() => {
  intakeRows = {};
  storageObjects = new Set();
  deleteShouldFail = false;
  verifyShouldLie = false;
  auditEvents.length = 0;
});

function row(overrides: Partial<FakeIntakeRow> = {}): FakeIntakeRow {
  return {
    id: 'intake-1',
    user_id: 'user-1',
    status: 'ready',
    storage_key: 'user-1/intake-1/intake-1.bin',
    purge_status: 'pending',
    purge_attempt_count: 0,
    purge_due_at: new Date(Date.now() - 1000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe('runPurgeAttempt', () => {
  it('purges: deletes, verifies absent, marks purged, deleted status, audits', async () => {
    const r = row();
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);

    const result = await runPurgeAttempt(r);

    expect(result.status).toBe('purged');
    expect(intakeRows[r.id].purge_status).toBe('purged');
    expect(intakeRows[r.id].status).toBe('deleted');
    expect(intakeRows[r.id].storage_key).toBeNull();
    expect(auditEvents.some((e) => e.eventType === 'document_purged')).toBe(true);
  });

  it('NEVER marks purged when the delete call fails', async () => {
    const r = row();
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);
    deleteShouldFail = true;

    const result = await runPurgeAttempt(r);

    expect(result.status).toBe('failed');
    expect(intakeRows[r.id].purge_status).not.toBe('purged');
    expect(intakeRows[r.id].purge_attempt_count).toBe(1);
    // Error message must be sanitised (URL redacted, capped) -- never the
    // raw storage-client message.
    if (result.status === 'failed') {
      expect(result.errorMessage).not.toContain('https://storage.example');
      expect(result.errorMessage).toContain('[redacted-url]');
    }
  });

  it('NEVER marks purged on a delete-call success alone -- independently re-verifies absence', async () => {
    const r = row();
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);
    verifyShouldLie = true; // object still listed even though .remove() "succeeded"

    const result = await runPurgeAttempt(r);

    expect(result.status).toBe('failed');
    expect(intakeRows[r.id].purge_status).not.toBe('purged');
  });

  it('is idempotent -- an already-purged row is a no-op', async () => {
    const r = row({ purge_status: 'purged' });
    intakeRows[r.id] = r;
    const result = await runPurgeAttempt(r);
    expect(result.status).toBe('already_purged');
  });

  it('handles a row with no storage object (nothing to delete) by marking purged directly', async () => {
    const r = row({ storage_key: null, status: 'rejected' });
    intakeRows[r.id] = r;
    const result = await runPurgeAttempt(r);
    expect(result.status).toBe('skipped_no_object');
    expect(intakeRows[r.id].purge_status).toBe('purged');
  });
});

describe('findDuePurges', () => {
  it('only returns pending/failed rows whose due date has passed', async () => {
    intakeRows['due'] = row({ id: 'due', purge_status: 'pending', purge_due_at: new Date(Date.now() - 1000).toISOString() });
    intakeRows['not-due'] = row({ id: 'not-due', purge_status: 'pending', purge_due_at: new Date(Date.now() + 60_000).toISOString() });
    intakeRows['not-required'] = row({ id: 'not-required', purge_status: 'not_required', purge_due_at: new Date(Date.now() - 1000).toISOString() });

    const due = await findDuePurges();
    expect(due.map((r) => r.id)).toEqual(['due']);
  });
});

describe('enforceAieRawFileHardBackstop', () => {
  it('force-schedules a purge for any intake past the max age, regardless of status', async () => {
    const old = row({ id: 'old', purge_status: 'not_required', created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    const fresh = row({ id: 'fresh', purge_status: 'not_required', created_at: new Date().toISOString() });
    intakeRows[old.id] = old;
    intakeRows[fresh.id] = fresh;

    const result = await enforceAieRawFileHardBackstop(24 * 60);

    expect(result.forcedPurgeCount).toBe(1);
    expect(intakeRows['old'].purge_status).toBe('pending');
    expect(intakeRows['fresh'].purge_status).toBe('not_required');
  });

  it('never touches a row with no live storage key', async () => {
    const noObject = row({ id: 'no-object', storage_key: null, created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    intakeRows[noObject.id] = noObject;
    const result = await enforceAieRawFileHardBackstop(24 * 60);
    expect(result.forcedPurgeCount).toBe(0);
  });
});

describe('finalizeDocumentBinaryAfterRun (primary immediate-deletion path)', () => {
  it('deletes immediately on success', async () => {
    const r = row();
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);

    const result = await finalizeDocumentBinaryAfterRun({ intakeId: r.id, userId: r.user_id, storageKey: r.storage_key! });

    expect(result.status).toBe('deleted');
    expect(intakeRows[r.id].status).toBe('deleted');
    expect(auditEvents.some((e) => e.eventType === 'document_deleted_immediate')).toBe(true);
  });

  it('schedules a retry rather than silently dropping the failure', async () => {
    const r = row();
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);
    deleteShouldFail = true;

    const result = await finalizeDocumentBinaryAfterRun({ intakeId: r.id, userId: r.user_id, storageKey: r.storage_key! });

    expect(result.status).toBe('scheduled_for_retry');
    expect(intakeRows[r.id].purge_status).toBe('pending');
    expect(auditEvents.some((e) => e.eventType === 'document_purge_scheduled')).toBe(true);
  });
});

// ============================================================================
// M12C — M2-OPEN-2: the purge-status transition validator, wired in.
// ============================================================================
describe('M2-OPEN-2 — purge_status transition validation is enforced at every write site', () => {
  it('finalizeDocumentBinaryAfterRun can NEVER resurrect an already-purged row (purged is terminal)', async () => {
    // Before this fix the retry path wrote `purge_status: 'pending'` filtered
    // on `id` alone — no CAS, no from-state check. A row already `purged`
    // (status `deleted`, storage_key null) therefore went back to `pending`,
    // was re-selected by `findDuePurges` on every sweep, and generated a
    // fresh `document_purge_scheduled` audit event each time, forever.
    const r = row({ purge_status: 'purged', status: 'deleted', storage_key: null });
    intakeRows[r.id] = r;
    deleteShouldFail = true;

    const result = await finalizeDocumentBinaryAfterRun({ intakeId: r.id, userId: r.user_id, storageKey: 'user-1/intake-1/intake-1.bin' });

    expect(intakeRows[r.id].purge_status).toBe('purged');
    // Honest reporting: nothing was scheduled because nothing needed to be.
    expect(result.status).toBe('already_deleted');
    expect(auditEvents.some((e) => e.eventType === 'document_purge_scheduled')).toBe(false);
  });

  it('runPurgeAttempt refuses a row whose purge_status is not a legal source for in_progress, and writes NOTHING', async () => {
    // `findDuePurges` only ever returns pending/failed rows, so reaching this
    // branch means a corrupt/hand-edited/legacy value. Fail CLOSED (no
    // write at all) and let the sweep's `failed` count surface it — never
    // guess, and never abort the rest of the sweep by throwing.
    const r = row({ purge_status: 'not_required' });
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);

    const result = await runPurgeAttempt(r);

    expect(result.status).toBe('failed');
    expect(intakeRows[r.id].purge_status).toBe('not_required');
    expect(storageObjects.has(r.storage_key!)).toBe(true); // bytes untouched
    expect(auditEvents.some((e) => e.eventType === 'document_purged')).toBe(false);
  });

  it('runPurgeAttempt refuses an unrecognised purge_status the same way (fail-closed on untyped DB text)', async () => {
    const r = row({ purge_status: 'legal_hold' as never });
    intakeRows[r.id] = r;
    const result = await runPurgeAttempt(r);
    expect(result.status).toBe('failed');
    expect(intakeRows[r.id].purge_status).toBe('legal_hold');
  });

  it('runPurgeAttempt still accepts both legal source states (pending and failed) — retry semantics unchanged', async () => {
    for (const from of ['pending', 'failed'] as const) {
      intakeRows = {};
      storageObjects = new Set();
      const r = row({ id: `intake-${from}`, purge_status: from });
      intakeRows[r.id] = r;
      storageObjects.add(r.storage_key!);
      const result = await runPurgeAttempt(r);
      expect(result.status, from).toBe('purged');
      expect(intakeRows[r.id].purge_status, from).toBe('purged');
    }
  });

  it('the bounded-backoff failure path is unchanged: in_progress -> failed, attempt count incremented, next attempt scheduled', async () => {
    const r = row({ purge_status: 'failed', purge_attempt_count: 2 });
    intakeRows[r.id] = r;
    storageObjects.add(r.storage_key!);
    deleteShouldFail = true;

    const result = await runPurgeAttempt(r);

    expect(result.status).toBe('failed');
    expect(intakeRows[r.id].purge_status).toBe('failed');
    expect(intakeRows[r.id].purge_attempt_count).toBe(3);
    expect(auditEvents.some((e) => e.eventType === 'document_purge_failed')).toBe(true);
  });

  it('the hard backstop skips a row whose current purge_status could not legally reach pending, without aborting the sweep', async () => {
    const old = (id: string, purge_status: FakeIntakeRow['purge_status']) => row({ id, purge_status, created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    intakeRows['ok'] = old('ok', 'not_required');
    // `purged` is excluded by the query's own `.not(...in (purged,in_progress))`
    // filter, so the illegal source that can still reach the loop is a
    // corrupt value — proven here with one.
    intakeRows['bad'] = old('bad', 'legal_hold' as never);

    const result = await enforceAieRawFileHardBackstop(24 * 60);

    expect(result.scanned).toBe(2);
    expect(result.forcedPurgeCount).toBe(1); // scanned > forced is the signal
    expect(intakeRows['ok'].purge_status).toBe('pending');
    expect(intakeRows['bad'].purge_status).toBe('legal_hold');
  });
});
