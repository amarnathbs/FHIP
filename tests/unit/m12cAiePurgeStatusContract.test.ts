/**
 * M12C — M2-OPEN-2 migration-contract test.
 *
 * ############################################################################
 * THIS IS NOT LIVE PROOF, AND IS NOT PRESENTED AS SUCH.
 *
 * No database proof of any kind was obtained for this item. This session has
 * no DEV or production database access and was explicitly forbidden from
 * seeking any, and migration `0149` (which adds the `purge_status` column
 * this machine governs) is itself still unapplied — see its own header,
 * "OPERATOR ACTION REQUIRED ... NOT applied anywhere by this closure
 * mission". So there is no live row, no live CHECK constraint and no live
 * transition to observe.
 *
 * What is provable WITHOUT a database, and is proven here, is the CONTRACT:
 * the SQL CHECK constraint's value list and the TypeScript vocabulary the
 * new purge state machine is built on are read from disk and asserted
 * identical. That is the strongest available substitute: it catches the one
 * failure mode a live check would catch that a pure unit test cannot — the
 * DB vocabulary and the TS vocabulary silently drifting apart — and it runs
 * in CI on every change rather than once, by hand, against one environment.
 *
 * The idiom is copied from `tests/unit/fdh1SchemaContract.test.ts:273`
 * (`fdh_statement_uploads.raw_document_purge_status` vs
 * `FDH_PURGE_STATUSES`), which exists for exactly the same reason and under
 * exactly the same "the tables do not exist in DEV yet, and a test that
 * silently passes when it cannot connect is worse than no test" constraint.
 * ############################################################################
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AIE_PURGE_STATUSES } from '@/lib/aie/types';
import { AIE_PURGE_STATUS_TRANSITIONS } from '@/lib/aie/stateMachine';

const MIGRATION_DIR = path.resolve(__dirname, '../../supabase/migrations');
const PURGE_MIGRATION = '0149_aie1_closure_document_lifecycle_purge.sql';
const GATEWAY_MIGRATION = '0140_aie1_1_shared_document_gateway.sql';

function readMigration(name: string): string {
  const file = path.join(MIGRATION_DIR, name);
  // A missing/renamed migration must FAIL this test, never silently skip it.
  expect(fs.existsSync(file), `${name} not found on disk`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

const PURGE_SQL = readMigration(PURGE_MIGRATION);

describe('M2-OPEN-2 — migration 0149 CHECK vs the TypeScript purge vocabulary', () => {
  it('the purge_status CHECK constraint lists exactly AIE_PURGE_STATUSES', () => {
    const match = PURGE_SQL.match(/purge_status\s+text\s+not null\s+default\s+'not_required'\s*\n?\s*check\s*\(purge_status in \(([^)]*)\)\)/);
    expect(match, 'purge_status CHECK constraint not found in 0149').not.toBeNull();
    const sqlValues = [...match![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect(sqlValues.sort()).toEqual([...AIE_PURGE_STATUSES].sort());
  });

  it('every status the TypeScript machine can move FROM or TO exists in the SQL vocabulary', () => {
    const declared = new Set<string>(AIE_PURGE_STATUSES);
    for (const [from, tos] of Object.entries(AIE_PURGE_STATUS_TRANSITIONS)) {
      expect(declared, `from-state ${from}`).toContain(from);
      for (const to of tos) expect(declared, `${from} -> ${to}`).toContain(to);
    }
  });

  it('the partial purge-sweep index still covers exactly the statuses findDuePurges selects on', () => {
    // `findDuePurges` queries `.in('purge_status', ['pending','failed'])`; the
    // index's WHERE clause must not drift away from that, or the sweep
    // silently stops using it.
    expect(PURGE_SQL).toContain("where purge_status in ('pending', 'failed')");
  });

  it('the purged-status integrity CHECK the purge service depends on is still declared', () => {
    // `runPurgeAttempt`'s `terminalStatusAfterPurge()` exists because of this
    // constraint; a change to it would silently re-open the M2 (H.1) defect.
    expect(PURGE_SQL).toContain("check (purge_status <> 'purged' or status = 'deleted')");
    expect(PURGE_SQL).toContain("check (purged_at is null or purge_status = 'purged')");
  });
});

describe('M2-OPEN-1 — aie_processing_transition needs NO migration for the new audit rows', () => {
  const GATEWAY_SQL = readMigration(GATEWAY_MIGRATION);

  it('from_state/to_state are unconstrained text — no CHECK to widen, so no migration is owed', () => {
    const start = GATEWAY_SQL.indexOf('create table aie_processing_transition');
    expect(start).toBeGreaterThan(-1);
    const body = GATEWAY_SQL.slice(start, GATEWAY_SQL.indexOf(');', start));
    expect(body).toContain('from_state text not null');
    expect(body).toContain('to_state text not null');
    // The ONLY CHECK on this table is on actor_type.
    const checks = [...body.matchAll(/check \(([^)]*\))?[^)]*\)/g)].map((m) => m[0]);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toContain('actor_type');
  });

  it('actor_type permits both of the values accept.ts and reject.ts now write', () => {
    expect(GATEWAY_SQL).toContain("actor_type text not null check (actor_type in ('system', 'worker', 'user', 'admin'))");
  });

  it('reason is a plain nullable text column — the per-edge reason strings need no schema change', () => {
    const start = GATEWAY_SQL.indexOf('create table aie_processing_transition');
    const body = GATEWAY_SQL.slice(start, GATEWAY_SQL.indexOf(');', start));
    expect(body).toMatch(/^\s*reason text,?\s*$/m);
  });
});
