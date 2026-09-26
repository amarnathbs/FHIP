/**
 * The `fdh_document_audit_events_event_type_check` ledger, as a chain.
 *
 * WHY THIS MODULE EXISTS. Every phase that widens this one CHECK constraint
 * DROPs it and recreates it with the full cumulative value list. Six schema
 * contract tests (FDH-7/9/10/11/12 and the AIE payslip one) each used to
 * prove "my migration's list == the TypeScript vocabulary MINUS everything
 * every LATER phase added", enumerating those later phases by named `_ADDED`
 * constant. That subtrahend list grows without bound: between 2026-09-22 and
 * 2026-09-24 alone it rose by exactly +2 in all six files (migrations 0180 and
 * 0186), so N widenings cost 6N edits in the same six places. That is the
 * structural reason these six files were the repeated epicentre of merge
 * conflicts, and it is not bad luck.
 *
 * THE REPLACEMENT CLAIM. Instead of "migration N == enum minus all later
 * phases" (a list that grows forever), each link asserts "the values migration
 * N adds to its PREDECESSOR == exactly the phase constants belonging to N".
 * One lookup per migration, referenced once. A new widening costs one entry in
 * `AUDIT_EVENT_PHASE_CONSTANTS` and zero edits to any existing assertion.
 *
 * WHAT WAS DELIBERATELY *NOT* DONE. The six assertions were not simply
 * deleted in favour of the whole-chain claims. The chain asserts that each
 * link is a superset of its predecessor, that lengths strictly increase, and
 * that the latest link equals the enum. Those catch a bogus early value (it
 * propagates to the latest link, where `latest == enum` fails) and any
 * revocation. They do NOT catch a value MISSING from migration N that should
 * have been granted at phase N: migration 0091 omitting one of its own six
 * values is still a superset of 0076, still strictly larger, and the latest
 * link still matches the enum. The per-link delta claim below is what covers
 * that, and it is the part of the old subtraction form worth keeping.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  FDH_DOCUMENT_AUDIT_EVENT_TYPES,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_R8_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH5_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH7_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH11_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_BANK_STATEMENT_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_RETIREMENT_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_LIABILITY_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_INVESTMENT_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED,
  FDH_DOCUMENT_AUDIT_EVENT_TYPES_CANONICAL_UPLOAD_ADDED,
} from '@/lib/financial-data-hub/constants/enums';

const ROOT = path.resolve(__dirname, '../../..');
const MIGRATION_DIR = path.join(ROOT, 'supabase/migrations');

/** The four-digit version prefix of a migration filename. */
export const migrationNumberOf = (filename: string): string => filename.slice(0, 4);

/**
 * Which phase constant(s) each link of the chain is responsible for adding.
 *
 * THE ONE PLACE A NEW WIDENING TOUCHES. Add the migration's number and the
 * `_ADDED` constant it introduces; every assertion built on this map then
 * covers it without being edited.
 *
 * TYPED AS A SET OF CONSTANTS, NOT ONE. Migration 0180 is currently the only
 * multi-constant link — its +28 is FOUR constants (bank statement, retirement,
 * liability, investment; seven events each: one migration, four document
 * types). Those four are NOT merged here into the flattened
 * `..._AIE_UNIFIED_FALLBACK_ADDED` view, even though it exists and would make
 * this map single-valued: `enums.ts` carries an explicit comment on why the
 * four are separate and not generated, and collapsing them here would throw
 * away the per-document-type provenance that makes the SQL diffable by eye.
 * The set-valued type is kept for every entry so the next multi-constant
 * migration needs no change of shape.
 */
export const AUDIT_EVENT_PHASE_CONSTANTS: ReadonlyMap<string, readonly (readonly string[])[]> =
  new Map<string, readonly (readonly string[])[]>([
    // Link 0 — the base. See `auditEventBaseMigration` for why it is 0058 and
    // not 0064.
    ['0058', [FDH_DOCUMENT_AUDIT_EVENT_TYPES]],
    ['0064', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_R7_ADDED]],
    ['0068', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_R8_ADDED]],
    ['0071', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH5_ADDED]],
    ['0076', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH7_ADDED]],
    ['0091', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH9_ADDED]],
    ['0096', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH10_ADDED]],
    ['0106', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH11_ADDED]],
    ['0112', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_FDH12_ADDED]],
    ['0173', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_PAYSLIP_ADDED]],
    ['0180', [
      FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_BANK_STATEMENT_ADDED,
      FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_RETIREMENT_ADDED,
      FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_LIABILITY_ADDED,
      FDH_DOCUMENT_AUDIT_EVENT_TYPES_AIE_INVESTMENT_ADDED,
    ]],
    ['0185', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_PAYSLIP_CORRECTION_ADDED]],
    ['0186', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_LIABILITY_CORRECTION_ADDED]],
    // Approved Upload -> Canonical User Data programme (WP-01). The only
    // widening that programme is allowed; every later package reuses it.
    ['0207', [FDH_DOCUMENT_AUDIT_EVENT_TYPES_CANONICAL_UPLOAD_ADDED]],
  ]);

/**
 * The phase constants for one link, flattened. Throws if unregistered — which
 * is the one-line failure a new widening is meant to produce, and the whole
 * cost of adding one.
 */
export function auditEventPhaseConstantsFor(migrationNumber: string): string[] {
  const constants = AUDIT_EVENT_PHASE_CONSTANTS.get(migrationNumber);
  if (!constants) {
    throw new Error(
      `migration ${migrationNumber} widens fdh_document_audit_events_event_type_check but is not `
      + 'registered in AUDIT_EVENT_PHASE_CONSTANTS — add its own _ADDED constant there',
    );
  }
  return constants.flatMap((c) => [...c]);
}

// ---------------------------------------------------------------------------
// Memoisation
// ---------------------------------------------------------------------------
//
// WHY THIS IS NOT PREMATURE. The ledger is ~180 files and several of them are
// large. Without caching, every `auditEventDeltaFor` call re-walks and re-reads
// the whole directory, so the 13-link sweep in `fdhAuditEventChain.test.ts`
// performed ~2,400 full file reads and blew vitest's 5s default timeout — it
// passed on a warm cache and failed consistently on a cold one, which is worse
// than failing outright. The ledger cannot change during a test process, so
// reading each file once is both faster and more honest about what is being
// asserted. Raising the timeout instead would have left the quadratic read in
// place for every consumer of this module.
let filenameCache: string[] | undefined;
const migrationCache = new Map<string, string>();
let chainCache: { name: string; values: string[] }[] | undefined;

/** Every migration filename in the ledger, oldest first. */
export function migrationFilenames(): string[] {
  if (!filenameCache) {
    filenameCache = readdirSync(MIGRATION_DIR)
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort();
  }
  return filenameCache;
}

function readMigration(name: string): string {
  let sql = migrationCache.get(name);
  if (sql === undefined) {
    sql = readFileSync(path.join(MIGRATION_DIR, name), 'utf8');
    migrationCache.set(name, sql);
  }
  return sql;
}

/**
 * Every value inside a NAMED `... event_type_check check (event_type in (...))`
 * block.
 *
 * ANCHORED ON THE CONSTRAINT NAME, DELIBERATELY. The loose form —
 * `check (event_type in (` alone — matches 22 migrations, because other tables
 * have their own `event_type` constraints: it picks up 0010, 0036, 0039, 0042,
 * 0067, 0083, 0115, 0125 and 0153 as false positives and produces a nonsense
 * chain whose counts go DOWN, with at least one zero-value link. Anchored on
 * the name, the named set is exactly the 12 files that really redefine this
 * constraint.
 */
export function auditEventTypesIn(sql: string): string[] {
  const block = /fdh_document_audit_events_event_type_check\s*\n?\s*check \(event_type in \(([\s\S]*?)\)\);/.exec(sql);
  if (!block) throw new Error('no event_type check constraint found');
  return [...block[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
}

/**
 * Link 0 of the chain: the migration that FIRST constrains `event_type`.
 *
 * WHY THIS NEEDS ITS OWN LOOKUP. 0058 creates the table with an UNNAMED,
 * column-level `event_type text not null check (event_type in (...))`. Postgres
 * auto-names a column check `<table>_<column>_check`, which is literally
 * `fdh_document_audit_events_event_type_check` — the same constraint object
 * every later migration DROPs and recreates by that name. So 0058 is genuinely
 * the first link, but it can never be found by searching for the name, because
 * it never writes it.
 *
 * The proof that the implicit name really does match is NOT that 0064's
 * `drop constraint if exists` succeeds — `if exists` passes silently whether or
 * not it matched anything, so DDL exit status cannot establish constraint
 * identity. The proof is runtime: two CHECKs on the same column are ANDed, so
 * had that drop missed, the effective vocabulary would be the INTERSECTION of
 * 0058's 9 values and 0064's 19 — i.e. still 9 — and every one of R7's ten new
 * event types would be rejected in production. They are not.
 *
 * Starting the chain at 0064 instead (an earlier version of this code did)
 * makes 0064 look like a 19-value base that needs TWO named constants to
 * explain, when it is really a +10 delta that is exactly `R7_ADDED`.
 */
export function auditEventBaseMigration(): { name: string; values: string[] } {
  const name = migrationFilenames().find((n) => n.startsWith('0058_'));
  if (!name) throw new Error('the base migration 0058 is missing from the ledger');
  const sql = readMigration(name);
  const table = sql.slice(sql.indexOf('create table fdh_document_audit_events ('));
  const inline = /event_type text not null check \(event_type in \(([\s\S]*?)\)\),/.exec(table);
  if (!inline) throw new Error(`${name} no longer constrains event_type inline`);
  return { name, values: [...inline[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]) };
}

/**
 * Every migration that RE-DEFINES the constraint BY NAME, oldest first,
 * identified by PARSING each one's value list. Excludes the base, which has no
 * name to match — see `auditEventBaseMigration`.
 */
export function namedAuditEventMigrations(): { name: string; sql: string }[] {
  return migrationFilenames()
    .map((name) => ({ name, sql: readMigration(name) }))
    .filter((m) => {
      try {
        return auditEventTypesIn(m.sql).length > 0;
      } catch {
        return false;
      }
    });
}

/**
 * The same set, found a DIFFERENT way: a plain substring search for the
 * `add constraint` statement, with no parsing at all.
 *
 * Deliberately independent of `namedAuditEventMigrations`. The chain claims
 * compare a parsed list against the TypeScript enum; if the traversal itself
 * were wrong — a truncated list, or the wrong last element — a `toEqual`
 * against one end of it could still pass. Two derivations that share no code
 * cannot both be wrong in the same direction by accident.
 */
export function auditEventMigrationNamesBySubstring(): string[] {
  return migrationFilenames().filter((name) =>
    readMigration(name).includes('add constraint fdh_document_audit_events_event_type_check'));
}

/** The WHOLE chain, base first: what the constraint has held over time. */
export function auditEventChainValues(): { name: string; values: string[] }[] {
  if (!chainCache) {
    const base = auditEventBaseMigration();
    chainCache = [
      base,
      ...namedAuditEventMigrations().map((m) => ({ name: m.name, values: auditEventTypesIn(m.sql) })),
    ];
  }
  // A fresh copy per call: the chain is shared, but callers sort and filter the
  // value arrays, and a cached structure that callers can mutate in place would
  // make one test's `.sort()` visible to the next.
  return chainCache.map((link) => ({ name: link.name, values: [...link.values] }));
}

/**
 * The migration whose constraint the given one actually replaces.
 *
 * Derived, never hardcoded. Migration 0186 was first drafted against a copy of
 * 0185 that predated 0180 (the unified AI-fallback widening, which landed on
 * `main` in between and added 28 values). Because this constraint is DROPped
 * and recreated, a stale hardcoded predecessor would have let 0186 silently
 * REVOKE all 28 with every test still green. That draft really was written;
 * resolving the predecessor from the ledger is what makes the next such
 * collision fail loudly instead of shipping.
 */
export function predecessorAuditEventMigration(selfNumber: number): { name: string; sql: string } {
  const chain = namedAuditEventMigrations()
    .filter((m) => Number(migrationNumberOf(m.name)) < selfNumber);
  const previous = chain[chain.length - 1];
  if (!previous) throw new Error('no prior migration defines fdh_document_audit_events_event_type_check');
  return previous;
}

/**
 * One link's delta against its predecessor: what it grants, and what — if the
 * ledger has gone wrong — it revokes.
 *
 * This is the whole point of the module. A phase's contract test asserts that
 * `added` equals its own `_ADDED` constant and that `revoked` is empty, and
 * never mentions any other phase.
 */
export function auditEventDeltaFor(migrationNumber: string): {
  name: string;
  predecessorName: string;
  values: string[];
  added: string[];
  revoked: string[];
} {
  const chain = auditEventChainValues();
  const index = chain.findIndex((link) => migrationNumberOf(link.name) === migrationNumber);
  if (index === -1) {
    throw new Error(`migration ${migrationNumber} does not define fdh_document_audit_events_event_type_check`);
  }
  const link = chain[index];
  // The base has no predecessor: its delta is its whole list, against nothing.
  const previous = index === 0 ? { name: '(none)', values: [] as string[] } : chain[index - 1];
  return {
    name: link.name,
    predecessorName: previous.name,
    values: link.values,
    added: link.values.filter((v) => !previous.values.includes(v)),
    revoked: previous.values.filter((v) => !link.values.includes(v)),
  };
}
