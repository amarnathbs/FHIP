// G5B — drift-proofing between the TypeScript app-layer manifest
// (lib/services/appCapability.ts) and the database-side manifest
// (mcc_generic_write_capabilities, supabase/migrations/0129).
//
// Dispatch item 4: "Add a test that reads both manifests and asserts: every
// module whose CREATE policy would resolve to ENABLED for a GENERIC user has
// ALL of its declared tables at generic_write_allowed = true in the DB
// manifest, and — the other direction — every DB manifest row with
// generic_write_allowed = true is claimed by at least one app-layer module
// that actually permits GENERIC create. Neither manifest may say yes while
// the other says no."
//
// This file is the ONE place that comparison logic lives, so it can be
// exercised two ways:
//   1. NOW (Phase 1, no live DEV access): tests/unit/g5bWriteManifestDrift.test.ts
//      calls compareManifests() against EXPECTED_DB_MANIFEST below — a
//      hand-maintained TypeScript mirror of migration 0129's own seed rows.
//      This can only ever prove "the TS app-layer manifest and this file's
//      OWN idea of the DB manifest agree" — it CANNOT prove the migration
//      was actually applied correctly, or that nobody edited the live table
//      after applying it. See EXPECTED_DB_MANIFEST's own header for the
//      exact, disclosed limitation.
//   2. PHASE 2 (after Product Owner applies migration 0129 to DEV):
//      scripts/g5b_manifest_drift_live_dev.mjs (prepared, not yet runnable)
//      queries the REAL mcc_generic_write_capabilities table and calls the
//      exact same compareManifests() function — this is the version that
//      actually proves the two manifests agree in reality, not just in two
//      pieces of hand-maintained source both written by the same person.
import { APP_CAPABILITY_MANIFEST, MODULE_KEYS, resolveModuleCapability, type ModuleKey } from '@/lib/services/appCapability';
import type { ResolvedCountryContext } from '@/lib/services/jurisdiction';
import { isG5BGenericWriteEnabled } from '@/lib/services/g5bWriteFlag';

export type WriteOperation = 'CREATE' | 'UPDATE' | 'DELETE';

/** One row as read from (or intended to be seeded into)
 * mcc_generic_write_capabilities. `operation` uses the DB's own TG_OP
 * vocabulary (INSERT, not CREATE) — see {@link dbOperationForWriteOperation}
 * for the one place that mapping happens. */
export interface DbManifestRow {
  table_name: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  generic_write_allowed: boolean;
}

/** The app layer's CapabilityOperation vocabulary (CREATE/UPDATE/DELETE) maps
 * onto the DB trigger's TG_OP vocabulary (INSERT/UPDATE/DELETE) with exactly
 * one rename — CREATE -> INSERT — because "creating a row" IS a SQL INSERT,
 * just named differently by the app's HTTP-verb-oriented vocabulary
 * (POST -> CREATE, lib/services/appCapability.ts's defaultOperationForMethod). */
export function dbOperationForWriteOperation(op: WriteOperation): 'INSERT' | 'UPDATE' | 'DELETE' {
  return op === 'CREATE' ? 'INSERT' : op;
}

// ============================================================================
// EXPECTED_DB_MANIFEST — hand-maintained mirror of supabase/migrations/0129's
// seed rows. MUST be kept in lockstep with that file by whoever edits either
// one; there is no build-time generation link between raw SQL and this TS
// object (Postgres migrations cannot be authored in TypeScript in this
// repo's toolchain). This is the disclosed, accepted limitation of running
// this comparison before the migration is live: this file can drift from the
// ACTUAL migration file without any test catching it, and neither can catch
// a manual, undocumented edit made directly against the live DEV table after
// application. Phase 2's live-DEV script closes both gaps by reading the
// real table instead of this fixture.
// ============================================================================
export const EXPECTED_DB_MANIFEST: readonly DbManifestRow[] = [
  { table_name: 'income_sources', operation: 'INSERT', generic_write_allowed: true },
  { table_name: 'income_sources', operation: 'UPDATE', generic_write_allowed: true },
  { table_name: 'income_sources', operation: 'DELETE', generic_write_allowed: false },
  { table_name: 'expense_items', operation: 'INSERT', generic_write_allowed: true },
  { table_name: 'expense_items', operation: 'UPDATE', generic_write_allowed: true },
  { table_name: 'expense_items', operation: 'DELETE', generic_write_allowed: false },
  { table_name: 'insurance_policies', operation: 'INSERT', generic_write_allowed: true },
  { table_name: 'insurance_policies', operation: 'UPDATE', generic_write_allowed: true },
  { table_name: 'insurance_policies', operation: 'DELETE', generic_write_allowed: false },
] as const;

/** A synthetic, fully-confirmed GENERIC context — the same shape any GB/US/
 * SG/AE user resolves to once UNIVERSAL_MODULES is enabled for them, used
 * only to ask "what would resolveModuleCapability say for this module's
 * CREATE/UPDATE right now" without needing a real request/session. */
function genericProbeContext(): ResolvedCountryContext {
  const capabilities = Object.fromEntries(
    ['REGISTRATION', 'UNIVERSAL_MODULES', 'DOMESTIC_CALCULATIONS', 'DOMESTIC_RETIREMENT', 'DOMESTIC_TAX_OUTPUTS', 'CROSS_BORDER_RELATIONSHIPS', 'LOCALISED_RESOURCES', 'LOCALISED_REPORTS', 'APPROVED_BILLING', 'APPROVED_PRICING', 'FX_CONVERSION', 'REGULATORY_GUIDANCE', 'COUNTRY_SPECIFIC_CATALOGUE_ITEMS'].map((k) => [
      k,
      k === 'UNIVERSAL_MODULES',
    ])
  ) as ResolvedCountryContext['capabilities'];
  return {
    residenceCountry: 'GB',
    residenceConfirmed: true,
    primaryCountry: 'GB',
    primaryCountryProvenance: 'CONFIRMED_PROFILE',
    baseCurrency: 'GBP',
    locale: null,
    billingCountry: null,
    billingConfirmed: false,
    crossBorderCountries: [],
    experienceLevel: 'GENERIC',
    capabilities,
  };
}

/** Every (table, operation) the TS app-layer manifest currently claims as
 * GENERIC-write-ENABLED for CREATE/UPDATE, under the given flag state. DELETE
 * is deliberately excluded: no module's writeTables.DELETE is ever populated
 * (see appCapability.ts's OPERATIONS_G5B_WRITE_CERTIFIED comment — the
 * product's "delete" is an UPDATE/archive, already covered by the UPDATE
 * cell), so there is nothing to compare on that operation.
 *
 * `g5bFlagOn` is not passed down to resolveModuleCapability() (which reads
 * the live flag itself via isG5BGenericWriteEnabled()) — it exists so this
 * function can assert the caller's declared flag state actually matches the
 * live flag, catching a test/script that forgot to call
 * __setG5BGenericWriteFlagForTests() (or set the env var) before asking for
 * "the flag-on claim set" and silently getting the flag-off answer instead. */
export function claimedGenericWriteTables(g5bFlagOn: boolean): Set<string> {
  if (g5bFlagOn !== isG5BGenericWriteEnabled()) {
    throw new Error(
      `claimedGenericWriteTables(${g5bFlagOn}) called but the live G5B flag is currently ${isG5BGenericWriteEnabled()} — set it first (env var or __setG5BGenericWriteFlagForTests) so the requested and actual flag states agree.`
    );
  }
  const ctx = genericProbeContext();
  const claimed = new Set<string>();
  for (const key of MODULE_KEYS as readonly ModuleKey[]) {
    const rule = APP_CAPABILITY_MANIFEST[key];
    for (const operation of ['CREATE', 'UPDATE'] as const) {
      const decision = resolveModuleCapability(key, ctx, { operation }).decision;
      if (decision !== 'ENABLED') continue;
      for (const table of rule.writeTables[operation]) {
        claimed.add(`${table}:${dbOperationForWriteOperation(operation)}`);
      }
    }
  }
  return claimed;
}

export interface DriftResult {
  /** DB rows with generic_write_allowed=true that NO app-layer module
   * currently claims (the DB opens a door the app never shows). */
  dbAllowsButNoAppModuleClaimsIt: DbManifestRow[];
  /** App-layer (table, operation) claims with no corresponding
   * generic_write_allowed=true DB row (the app would show a live control the
   * DB still rejects with 42501). */
  appClaimsButDbDoesNotAllow: string[];
  isDriftFree: boolean;
}

/**
 * The one shared comparison, used both by the offline unit test (against
 * EXPECTED_DB_MANIFEST) and — unchanged — by the Phase 2 live-DEV script
 * (against the real table). Pass g5bFlagOn=true to compare against the
 * fully-activated intended end state (what Phase 2 must prove); g5bFlagOn is
 * NOT meaningful for the DB side (the DB has no flag concept — its rows are
 * either seeded true or not), only for which app-layer claims are "live".
 */
export function compareManifests(dbRows: readonly DbManifestRow[], g5bFlagOn: boolean): DriftResult {
  const claimed = claimedGenericWriteTables(g5bFlagOn);
  const dbAllowed = new Set(dbRows.filter((r) => r.generic_write_allowed).map((r) => `${r.table_name}:${r.operation}`));

  const dbAllowsButNoAppModuleClaimsIt = dbRows.filter((r) => r.generic_write_allowed && !claimed.has(`${r.table_name}:${r.operation}`));
  const appClaimsButDbDoesNotAllow = [...claimed].filter((key) => !dbAllowed.has(key));

  return {
    dbAllowsButNoAppModuleClaimsIt,
    appClaimsButDbDoesNotAllow,
    isDriftFree: dbAllowsButNoAppModuleClaimsIt.length === 0 && appClaimsButDbDoesNotAllow.length === 0,
  };
}
