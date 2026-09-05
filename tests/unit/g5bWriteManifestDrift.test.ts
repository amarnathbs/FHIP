import { describe, it, expect, afterEach } from 'vitest';
import { compareManifests, claimedGenericWriteTables, EXPECTED_DB_MANIFEST } from '@/lib/services/g5bWriteManifest';
import { __setG5BGenericWriteFlagForTests } from '@/lib/services/g5bWriteFlag';

// G5B drift-proofing (dispatch item 4/7). See lib/services/g5bWriteManifest.ts's
// own header for the full explanation of what this test CAN and CANNOT prove
// before migration 0129 is actually applied to DEV:
//
//   CAN prove now: the TypeScript app-layer manifest (appCapability.ts's
//   writeTables + operationPolicy) agrees with THIS repo's own hand-written
//   idea of what migration 0129 seeds (EXPECTED_DB_MANIFEST) — i.e. the two
//   halves of this PR do not contradict each other on paper.
//
//   CANNOT prove until Phase 2 (live DEV, after Product Owner application):
//   that migration 0129 was actually applied as written, that nobody has
//   since hand-edited the live mcc_generic_write_capabilities table, or that
//   the live database genuinely enforces what it says it does. That is
//   scripts/g5b_manifest_drift_live_dev.mjs's job — it imports and calls the
//   exact same compareManifests() function against a REAL query result
//   instead of EXPECTED_DB_MANIFEST, so passing here does not retroactively
//   certify anything about live DEV.
describe('G5B TypeScript <-> DB manifest drift-proofing', () => {
  afterEach(() => {
    __setG5BGenericWriteFlagForTests(undefined);
  });

  it('EXPECTED_DB_MANIFEST has exactly the 9 seeded cells migration 0129 declares', () => {
    expect(EXPECTED_DB_MANIFEST).toHaveLength(9);
    const tables = new Set(EXPECTED_DB_MANIFEST.map((r) => r.table_name));
    expect(tables).toEqual(new Set(['income_sources', 'expense_items', 'insurance_policies']));
    for (const table of tables) {
      const rowsForTable = EXPECTED_DB_MANIFEST.filter((r) => r.table_name === table);
      expect(rowsForTable.map((r) => r.operation).sort()).toEqual(['DELETE', 'INSERT', 'UPDATE']);
      expect(rowsForTable.find((r) => r.operation === 'INSERT')?.generic_write_allowed).toBe(true);
      expect(rowsForTable.find((r) => r.operation === 'UPDATE')?.generic_write_allowed).toBe(true);
      expect(rowsForTable.find((r) => r.operation === 'DELETE')?.generic_write_allowed).toBe(false);
    }
  });

  it('with the G5B flag OFF, the app layer claims NOTHING as GENERIC-write-enabled — zero drift trivially, because there is nothing to compare', () => {
    __setG5BGenericWriteFlagForTests(false);
    const claimed = claimedGenericWriteTables(false);
    expect(claimed.size).toBe(0);

    // Comparing the flag-off (empty) app claim set against the fully-seeded
    // EXPECTED_DB_MANIFEST surfaces the exact, EXPECTED asymmetry while the
    // flag is off: the DB is (once applied) allowed to say yes on 6 cells
    // that the app does not yet expose. This is intentional and safe
    // (fail-closed app layer on top of an opened DB layer), not drift in the
    // dangerous direction — the dangerous direction (app claims something the
    // DB denies) is what must be zero, in every flag state.
    const result = compareManifests(EXPECTED_DB_MANIFEST, false);
    expect(result.appClaimsButDbDoesNotAllow).toEqual([]);
    expect(result.dbAllowsButNoAppModuleClaimsIt.length).toBe(6); // the 3 tables' INSERT+UPDATE=true rows
  });

  it('with the G5B flag ON, the app layer claims exactly the 6 true cells and nothing else — zero drift in both directions', () => {
    __setG5BGenericWriteFlagForTests(true);
    const claimed = claimedGenericWriteTables(true);
    expect(claimed).toEqual(
      new Set([
        'income_sources:INSERT',
        'income_sources:UPDATE',
        'expense_items:INSERT',
        'expense_items:UPDATE',
        'insurance_policies:INSERT',
        'insurance_policies:UPDATE',
      ])
    );

    const result = compareManifests(EXPECTED_DB_MANIFEST, true);
    expect(result.appClaimsButDbDoesNotAllow).toEqual([]);
    expect(result.dbAllowsButNoAppModuleClaimsIt).toEqual([]);
    expect(result.isDriftFree).toBe(true);
  });

  it('never claims a DELETE cell for any module (the app has no writeTables.DELETE entries — "delete" is an UPDATE/archive)', () => {
    __setG5BGenericWriteFlagForTests(true);
    const claimed = claimedGenericWriteTables(true);
    for (const key of claimed) {
      expect(key.endsWith(':DELETE')).toBe(false);
    }
  });

  it('DETECTS drift: if the DB manifest disagreed with the app (a hypothetical forged/edited row), the comparison fails, not silently passes', () => {
    __setG5BGenericWriteFlagForTests(true);
    const forgedDbManifest = EXPECTED_DB_MANIFEST.map((r) =>
      r.table_name === 'income_sources' && r.operation === 'INSERT' ? { ...r, generic_write_allowed: false } : r
    );
    const result = compareManifests(forgedDbManifest, true);
    expect(result.isDriftFree).toBe(false);
    expect(result.appClaimsButDbDoesNotAllow).toContain('income_sources:INSERT');
  });

  it('DETECTS the other direction of drift: a DB row saying true with no app-layer module claiming it', () => {
    __setG5BGenericWriteFlagForTests(true);
    const overPermissiveDbManifest = [...EXPECTED_DB_MANIFEST, { table_name: 'assets', operation: 'INSERT' as const, generic_write_allowed: true }];
    const result = compareManifests(overPermissiveDbManifest, true);
    expect(result.isDriftFree).toBe(false);
    expect(result.dbAllowsButNoAppModuleClaimsIt).toEqual([{ table_name: 'assets', operation: 'INSERT', generic_write_allowed: true }]);
  });
});
