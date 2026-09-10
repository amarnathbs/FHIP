// LR-2 certification (2026-09-10) — real, live-DEV finding: adding an
// Investment via the catalogue picker failed 100% of the time with
// Postgres 42P10 ("no unique or exclusion constraint matching the ON
// CONFLICT specification"). Root cause: migration 0042 replaced
// investments' plain unique(user_id, master_item_key) constraint with a
// PARTIAL unique index scoped to source_type='manual' (so a manual row and
// an Investment-Intelligence-published row can share a master_item_key
// without colliding) -- but PostgREST's upsert `on_conflict` parameter has
// no way to express that predicate, so a native upsert against this table
// always fails. Fixed in lib/services/registry.ts by explicitly mirroring
// the partial index's own scope (an existence check filtered to
// source_type='manual', then update-or-insert) for the one table affected.
// See docs/live-recovery/LR2_INVESTMENTS_UPSERT_PARTIAL_INDEX_FIX.md.
import { describe, it, expect, vi } from 'vitest';

type FakeRow = Record<string, unknown>;

// A minimal chainable fake mirroring exactly the calls registry.ts's
// save() makes: .select().eq().eq().eq().maybeSingle() for the existence
// check, .update().eq().eq().select().single() for the update branch,
// .insert().select().single() for the insert branch, and the legacy
// .upsert().select().single() path for tables NOT in the partial-index set.
function makeFakeSupabase(initialRows: FakeRow[]) {
  const rows = [...initialRows];
  let nextId = rows.length + 1;
  const client = {
    from() {
      let filtered = [...rows];
      let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
      let pendingWrite: FakeRow | null = null;
      let updateTargetId: string | null = null;
      const builder = {
        select() {
          return builder;
        },
        eq(col: string, val: unknown) {
          if (mode === 'update' && !updateTargetId && col === 'id') {
            updateTargetId = val as string;
            return builder;
          }
          filtered = filtered.filter((r) => r[col] === val);
          return builder;
        },
        insert(row: FakeRow) {
          mode = 'insert';
          pendingWrite = row;
          return builder;
        },
        update(patch: FakeRow) {
          mode = 'update';
          pendingWrite = patch;
          return builder;
        },
        upsert(row: FakeRow, opts: { onConflict: string }) {
          mode = 'upsert';
          pendingWrite = row;
          // Mirror real Postgres: this fake table has NO partial index, so
          // a plain upsert genuinely matches on the given columns (this is
          // what registry.ts's ORIGINAL code path still uses for every
          // table except investments -- confirmed still working here).
          const keys = opts.onConflict.split(',');
          const match = rows.find((r) => keys.every((k) => r[k] === row[k]));
          if (match) Object.assign(match, row);
          return builder;
        },
        maybeSingle() {
          return Promise.resolve({ data: filtered[0] ?? null, error: null });
        },
        single() {
          if (mode === 'insert') {
            const newRow: FakeRow = { id: `row-${nextId++}`, ...pendingWrite };
            rows.push(newRow);
            return Promise.resolve({ data: newRow, error: null });
          }
          if (mode === 'update') {
            const target = rows.find((r) => r.id === updateTargetId);
            if (!target) return Promise.resolve({ data: null, error: { code: 'not_found', message: 'no row' } });
            Object.assign(target, pendingWrite);
            return Promise.resolve({ data: target, error: null });
          }
          if (mode === 'upsert') {
            const keys = Object.keys(pendingWrite!).filter((k) => k === 'user_id' || k === 'master_item_key');
            const match = rows.find((r) => keys.every((k) => r[k] === (pendingWrite as FakeRow)[k]));
            if (match) return Promise.resolve({ data: match, error: null });
            const newRow: FakeRow = { id: `row-${nextId++}`, ...pendingWrite };
            rows.push(newRow);
            return Promise.resolve({ data: newRow, error: null });
          }
          return Promise.resolve({ data: filtered[0] ?? null, error: null });
        },
      };
      return builder;
    },
  };
  return { client, rows };
}

const USER_ID = 'registry-test-user';

describe('makeRegistry("investments").save() — partial-index fix', () => {
  it('creates a new manual row when none exists yet (INSERT path, source_type explicitly set)', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('investments');

    const { data, error } = await registry.save(USER_ID, { master_item_key: 'etfs', current_value: 3000, owner: 'child' });

    expect(error).toBeNull();
    expect(data).toMatchObject({ master_item_key: 'etfs', current_value: 3000, is_active: true, source_type: 'manual' });
    expect(rows).toHaveLength(1);
  });

  it('updates the existing MANUAL row for the same master_item_key on a second save (re-checking a catalogue item)', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([
      { id: 'existing-1', user_id: USER_ID, master_item_key: 'etfs', current_value: 3000, source_type: 'manual', is_active: true },
    ]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('investments');

    const { data, error } = await registry.save(USER_ID, { master_item_key: 'etfs', current_value: 3500, owner: 'child' });

    expect(error).toBeNull();
    expect(data).toMatchObject({ id: 'existing-1', current_value: 3500 });
    expect(rows).toHaveLength(1); // updated in place, not duplicated
  });

  it('does NOT match an Investment-Intelligence-published row sharing the same master_item_key — inserts a new manual row instead (the exact coexistence migration 0042 was designed to preserve)', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([
      { id: 'ii-published-1', user_id: USER_ID, master_item_key: 'etfs', current_value: 50000, source_type: 'investment_intelligence_published', is_active: true },
    ]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('investments');

    const { data, error } = await registry.save(USER_ID, { master_item_key: 'etfs', current_value: 3000, owner: 'self' });

    expect(error).toBeNull();
    expect(data).toMatchObject({ current_value: 3000, source_type: 'manual' });
    expect((data as FakeRow).id).not.toBe('ii-published-1');
    expect(rows).toHaveLength(2); // the II-published row survives, untouched
    const iiRow = rows.find((r) => r.id === 'ii-published-1');
    expect(iiRow?.current_value).toBe(50000);
  });

  it('a row scoped to a DIFFERENT user with the same master_item_key is never matched (cross-tenant safety of the existence check)', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([
      { id: 'other-user-1', user_id: 'someone-else', master_item_key: 'etfs', current_value: 999, source_type: 'manual', is_active: true },
    ]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('investments');

    const { data } = await registry.save(USER_ID, { master_item_key: 'etfs', current_value: 3000 });

    expect((data as FakeRow).id).not.toBe('other-user-1');
    expect(rows).toHaveLength(2);
  });
});

describe('makeRegistry(<other tables>).save() — unchanged, still uses the native upsert path', () => {
  it('assets still upserts natively (no partial-index quirk for this table)', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('assets');

    const { data, error } = await registry.save(USER_ID, { master_item_key: 'wallet_cash', current_value: 500, user_id: USER_ID });

    expect(error).toBeNull();
    expect(data).toMatchObject({ current_value: 500 });
    expect(rows).toHaveLength(1);
  });

  it('a custom item (no master_item_key) always inserts, on any table', async () => {
    vi.resetModules();
    const { client, rows } = makeFakeSupabase([]);
    vi.doMock('@/lib/supabase/server', () => ({ createClient: async () => client }));
    const { makeRegistry } = await import('@/lib/services/registry');
    const registry = makeRegistry('investments');

    const { error } = await registry.save(USER_ID, { current_value: 1000, owner: 'self' });

    expect(error).toBeNull();
    expect(rows).toHaveLength(1);
  });
});
