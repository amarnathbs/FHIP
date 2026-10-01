// BENCH-1 Phase 2 - the central entitlement evaluator (pure).
//
// Mirrors, line for line, the SQL functions benchmark_entitlement_grants() and
// benchmark_right_allowed() of migration 0239 (a PGlite cross-check in
// scripts/bench1_phase2_0239_pglite_verification.mjs and the unit tests keep
// the two in agreement). The TypeScript copy exists because the CSV pipeline
// preview, the recurring-ingestion orchestrator and the calculation / display /
// export consumers must all ask THE SAME question the database answers at
// publication time.
//
// NO new ii_benchmarks.licence_status value is invented here or anywhere:
// licence_status (public_open / licence_required / licensed_held / unknown)
// remains a coarse summary and is NEVER consulted by this module. The
// authoritative inputs are the per-right entitlement records:
//
//   * a public_open string alone does not establish ANY right;
//   * a licensed_held string alone does not establish ANY right;
//   * absence of an approved, in-term, in-scope record for the EXACT benchmark,
//     variant and currency means NO right (fail closed).
//
// Rights are evaluated SEPARATELY - ingest (manual), automation, storage,
// calculation, customer display, report export - plus the historical date
// range, the exact variant/currency, expiry and post-expiry retention.

export type BenchmarkRight = 'ingest_manual' | 'automation' | 'storage' | 'calculation' | 'customer_display' | 'report_export';

export const BENCHMARK_RIGHTS: readonly BenchmarkRight[] = ['ingest_manual', 'automation', 'storage', 'calculation', 'customer_display', 'report_export'];

export type EntitlementKind = 'public_use_permission' | 'commercial_licence';
export type EntitlementStatus = 'draft' | 'approved' | 'revoked';
export type ReturnVariantId = 'price' | 'total_return' | 'net_total_return';

export interface EntitlementRecord {
  id: string;
  benchmarkId: string;
  kind: EntitlementKind;
  status: EntitlementStatus;
  returnVariant: ReturnVariantId;
  currencyCode: string;
  allowManualIngest: boolean;
  allowAutomation: boolean;
  allowStorage: boolean;
  allowCalculation: boolean;
  allowCustomerDisplay: boolean;
  allowReportExport: boolean;
  /** Inclusive data-date scope; null = unbounded on that side. */
  dataFrom: string | null;
  dataTo: string | null;
  /** Inclusive term. */
  validFrom: string;
  validTo: string | null;
  postExpiryStorage: 'retain' | 'delete' | 'unknown';
  postExpiryCalculation: boolean;
  postExpiryDisplay: boolean;
}

export interface BenchmarkIdentity {
  benchmarkId: string;
  returnVariant: ReturnVariantId | null;
  currencyCode: string | null;
}

/** What each real-world ACTION needs. A customer-visible comparison needs calculation AND display; a report/export additionally needs export. */
export const ACTION_REQUIRED_RIGHTS = {
  publish_manual: ['ingest_manual', 'storage'],
  publish_automated: ['automation', 'storage'],
  calculate: ['calculation'],
  display_comparison: ['calculation', 'customer_display'],
  export_report: ['calculation', 'customer_display', 'report_export'],
} as const satisfies Record<string, readonly BenchmarkRight[]>;

export type BenchmarkAction = keyof typeof ACTION_REQUIRED_RIGHTS;

/** One record grants one right on one date (same logic as SQL benchmark_entitlement_grants). */
export function entitlementGrants(e: EntitlementRecord, right: BenchmarkRight, on: string): boolean {
  if (e.status !== 'approved') return false;
  const inTerm = on >= e.validFrom && (e.validTo === null || on <= e.validTo);
  const retained = e.postExpiryStorage === 'retain';
  switch (right) {
    case 'ingest_manual':
      return e.allowManualIngest && inTerm;
    case 'automation':
      return e.allowAutomation && inTerm;
    case 'storage':
      return e.allowStorage && (inTerm || retained);
    case 'calculation':
      return e.allowCalculation && (inTerm || (retained && e.postExpiryCalculation));
    case 'customer_display':
      return e.allowCustomerDisplay && (inTerm || (retained && e.postExpiryDisplay));
    case 'report_export':
      return e.allowReportExport && (inTerm || (retained && e.postExpiryDisplay));
    default:
      // An unknown right is a programming error, never a silent false.
      throw new Error(`entitlementGrants: unknown right '${String(right)}'`);
  }
}

export interface RightQuery {
  right: BenchmarkRight;
  /** The date the right is exercised (default: today). */
  on: string;
  /** Data-date range the right is being exercised for (inclusive); omit for "any". */
  dataFrom?: string | null;
  dataTo?: string | null;
}

/**
 * The central predicate: may `right` be exercised on this benchmark?
 * Requires an approved record for the EXACT benchmark whose variant and
 * currency equal the catalogue row's (a price entitlement is not a TRI
 * entitlement; a benchmark without a declared variant has no rights).
 */
export function rightAllowed(identity: BenchmarkIdentity, records: readonly EntitlementRecord[], q: RightQuery): boolean {
  if (!BENCHMARK_RIGHTS.includes(q.right)) throw new Error(`rightAllowed: unknown right '${String(q.right)}'`);
  if (identity.returnVariant === null || identity.currencyCode === null) return false;
  return records.some(
    (e) =>
      e.benchmarkId === identity.benchmarkId &&
      e.status === 'approved' &&
      e.returnVariant === identity.returnVariant &&
      e.currencyCode === identity.currencyCode &&
      (q.dataFrom == null || e.dataFrom === null || q.dataFrom >= e.dataFrom) &&
      (q.dataTo == null || e.dataTo === null || q.dataTo <= e.dataTo) &&
      entitlementGrants(e, q.right, q.on)
  );
}

export interface ActionDecision {
  allowed: boolean;
  /** Rights that are missing, for an honest, specific message. */
  missing: BenchmarkRight[];
}

/** Evaluate every right an action needs; ALL must hold (fail closed). */
export function actionAllowed(identity: BenchmarkIdentity, records: readonly EntitlementRecord[], action: BenchmarkAction, on: string, range?: { dataFrom?: string | null; dataTo?: string | null }): ActionDecision {
  const needed = ACTION_REQUIRED_RIGHTS[action];
  if (!needed) throw new Error(`actionAllowed: unknown action '${String(action)}'`);
  const missing = needed.filter((right) => !rightAllowed(identity, records, { right, on, dataFrom: range?.dataFrom, dataTo: range?.dataTo }));
  return { allowed: missing.length === 0, missing: [...missing] };
}

/** Human-readable blocked reason used by the consumer screens (never a bare 0%). */
export function describeMissingRights(missing: readonly BenchmarkRight[]): string {
  if (missing.length === 0) return '';
  const label: Record<BenchmarkRight, string> = {
    ingest_manual: 'manual ingestion',
    automation: 'automated ingestion',
    storage: 'storage',
    calculation: 'calculation',
    customer_display: 'customer display',
    report_export: 'report/export use',
  };
  return `No approved entitlement permits ${missing.map((m) => label[m]).join(' and ')} for this benchmark.`;
}
