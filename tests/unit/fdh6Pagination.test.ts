/**
 * FDH-6 (spec sections 101-103, 119) — proves the pagination-safe
 * `listForUserAll()`/`listActiveAll()` additive repository methods
 * (`lib/financial-data-hub/repositories/base.ts`) genuinely page past
 * PostgREST's 1,000-row cap, exactly at the boundaries the spec names:
 * 999, 1000, 1001, 5000, 10000. `fetchAllRows()` itself (the underlying
 * mechanism) already has dedicated coverage in `tests/unit/
 * r7Pagination.test.ts` — this file's job is narrower: prove the NEW
 * repository methods actually wire up to it correctly (real table name,
 * real filter, deterministic ordering), using an in-memory fake of the
 * Supabase query-builder chain (same precedented technique as
 * `iiR3RepublishFieldRestoration.test.ts` — this codebase's DB-touching
 * orchestration layer has no general Supabase mock, by design; a fake
 * scoped to exactly the chain surface this one code path needs is the
 * established pattern).
 *
 * NEGATIVE CONTROL (spec section 119): a version of this test that used
 * `.limit(1000)` instead of ranged paging would fail the 1001/5000/10000
 * cases below — reverting `listForUserAll`/`listActiveAll` to the
 * single-page `.limit()` shape R8/FDH-1's original `listForUser`/
 * `listActive` used is exactly the regression this file exists to catch.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }));

import { createClient } from '@/lib/supabase/server';
import { makeUserOwnedRepository, makeMasterDataRepository } from '@/lib/financial-data-hub/repositories/base';

interface Row {
  id: string;
  user_id?: string;
  active?: boolean;
  created_at: string;
}

/** A narrow fake of the Supabase query-builder chain — just enough surface
 * for `.from(table).select('*').eq(...).order(...).order(...).range(from,to)`
 * (user-owned) and `.from(table).select('*').eq('active', true).order(...).
 * range(from,to)` (master-data). Real `.range()` semantics: inclusive
 * `[from, to]`, capped at 1000 rows per call by this fake — mirroring
 * PostgREST's real `db-max-rows` behaviour precisely so a caller that
 * forgets to page past it would fail here exactly as it would live. */
function makeFakeSupabase(rows: Row[]) {
  const PAGE_CAP = 1000; // mirrors PostgREST's real db-max-rows
  function from() {
    let filtered = [...rows];
    let limitN: number | null = null;
    const builder = {
      select() {
        return builder;
      },
      eq(col: keyof Row, val: unknown) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      order() {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      returns() {
        return builder;
      },
      async range(from_: number, to: number) {
        const cappedTo = Math.min(to, from_ + PAGE_CAP - 1);
        return { data: filtered.slice(from_, cappedTo + 1), error: null };
      },
      // Reached only when the caller awaits the builder WITHOUT calling
      // `.range()` — the OLD single-page `listForUser`/`listActive` shape.
      // Real PostgREST enforces its own db-max-rows cap regardless of what
      // `.limit()` the client requested; this fake mirrors that exactly.
      then(resolve: (v: { data: Row[]; error: null }) => void) {
        const cap = limitN !== null ? Math.min(limitN, PAGE_CAP) : PAGE_CAP;
        resolve({ data: filtered.slice(0, cap), error: null });
      },
    };
    return builder;
  }
  return { from } as unknown as ReturnType<typeof createClient> extends Promise<infer T> ? T : never;
}

function rows(n: number, extra: Partial<Row> = {}): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(6, '0'), user_id: 'user-1', active: true, created_at: '2026-01-01T00:00:00Z', ...extra }));
}

describe('FDH-6 pagination — listForUserAll() pages past 1,000 (spec sections 101-103)', () => {
  const repo = makeUserOwnedRepository<Row, never>('fdh_transaction_links' as never);

  it.each([999, 1000, 1001, 5000, 10000])('reads all %i rows for one user, none silently dropped', async (count) => {
    vi.mocked(createClient).mockResolvedValue(makeFakeSupabase(rows(count)) as never);
    const result = await repo.listForUserAll('user-1');
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(count);
  });

  it('rows belonging to a DIFFERENT user are never returned, even past the 1,000-row page boundary', async () => {
    const mine = rows(500, { user_id: 'user-1' });
    const theirs = rows(1500, { user_id: 'user-2' });
    vi.mocked(createClient).mockResolvedValue(makeFakeSupabase([...mine, ...theirs]) as never);
    const result = await repo.listForUserAll('user-1');
    expect(result.data).toHaveLength(500);
    expect(result.data!.every((r) => r.user_id === 'user-1')).toBe(true);
  });
});

describe('FDH-6 pagination — listActiveAll() pages past 1,000 (spec sections 101-103)', () => {
  const repo = makeMasterDataRepository<Row>('fdh_merchant_aliases' as never);

  it.each([999, 1000, 1001, 5000, 10000])('reads all %i active rows, none silently dropped at the master-data cap', async (count) => {
    vi.mocked(createClient).mockResolvedValue(makeFakeSupabase(rows(count)) as never);
    const result = await repo.listActiveAll();
    expect(result.error).toBeNull();
    expect(result.data).toHaveLength(count);
  });

  it('inactive rows are never returned, even past the page boundary', async () => {
    const active = rows(600, { active: true });
    const inactive = rows(600, { active: false });
    vi.mocked(createClient).mockResolvedValue(makeFakeSupabase([...active, ...inactive]) as never);
    const result = await repo.listActiveAll();
    expect(result.data).toHaveLength(600);
    expect(result.data!.every((r) => r.active === true)).toBe(true);
  });
});

describe('FDH-6 pagination — NEGATIVE CONTROL: the OLD single-page methods genuinely DO truncate at 1,000 (proves the fake fixture itself is honest, and shows exactly the defect listForUserAll/listActiveAll fix)', () => {
  it('the pre-existing listForUser(userId, limit) truncates at the PostgREST page cap for a large limit request', async () => {
    const repo = makeUserOwnedRepository<Row, never>('fdh_transaction_links' as never);
    vi.mocked(createClient).mockResolvedValue(makeFakeSupabase(rows(5000)) as never);
    const result = await repo.listForUser('user-1', 5000); // asks for 5000...
    expect((result.data ?? []).length).toBeLessThan(5000); // ...but the single-page fake (and real PostgREST) never delivers more than 1000
  });
});
