// "A declared record exists but the data we hold cannot be compared with it": the PURE half (no I/O, client-safe).
//
// WHY THIS EXISTS. Since the PO decision of 2026-10-03 a held scheme with no declared (admin or factsheet-approved)
// mapping is compared, at read time, with the usual benchmark for its CATEGORY (categoryReference.ts). That is
// correct for a scheme about which nothing is declared. It is WRONG for a scheme whose own documents declare a
// benchmark the catalogue cannot represent (a composite, a gold or silver price, an index we do not hold): falling
// back to the category index would compare the fund against an index its own documents say it does not follow.
//
// RULE (named negative controls in tests/unit/factsheetDeclaredUnsupported.test.ts):
//   * A scheme with a declared record the catalogue cannot represent NEVER gets a category benchmark. Every surface
//     shows "Declared benchmark: <name as stated> (cannot be compared with the data we hold)" and no number.
//   * A scheme with NO declared record at all still falls back to the category reference, exactly as before.
//   * A declared mapping (approved or auto-published, single series) still always wins, and the row's label switches
//     from "Category benchmark" to "Fund's declared benchmark" on the next load, with nothing to do by hand.
//
// The declared records live in ii_scheme_declared_benchmark_versions (migration 0252). End users cannot read that
// table (it is admin-only by row-level security), so readers use the narrow SECURITY DEFINER function
// declared_benchmark_records_for() which returns public fund facts only: no user, holding or amount.

/** Which catalogue states leave a scheme "declared but not comparable". Mirrors the SQL function in 0252 (a test compares the two). */
export const NOT_COMPARABLE_CATALOGUE_STATES = ['unsupported_composite', 'unsupported_commodity', 'no_catalogue_match'] as const;
/** A declared benchmark with a possible catalogue match that no human has confirmed yet: also never replaced by a category index. */
export const AWAITING_REVIEW_CATALOGUE_STATES = ['matched_other'] as const;

export type DeclaredRecordStatus = 'declared_unsupported' | 'declared_awaiting_review';

export interface DeclaredRecord {
  instrumentId: string;
  status: DeclaredRecordStatus;
  /** The benchmark name exactly as the fund's document states it. */
  declaredName: string;
  benchmarkKind: 'single_index' | 'composite' | 'commodity_price';
  catalogueState: string;
}

export function statusForCatalogueState(state: string): DeclaredRecordStatus | null {
  if ((NOT_COMPARABLE_CATALOGUE_STATES as readonly string[]).includes(state)) return 'declared_unsupported';
  if ((AWAITING_REVIEW_CATALOGUE_STATES as readonly string[]).includes(state)) return 'declared_awaiting_review';
  return null;
}

const NAME_MAX = 160;

/** The sentence every surface shows instead of a comparison number. */
export function declaredRecordMessage(r: Pick<DeclaredRecord, 'declaredName' | 'status'>): string {
  const name = r.declaredName.replace(/\s+/g, ' ').trim();
  const shown = name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name;
  return r.status === 'declared_unsupported'
    ? `Declared benchmark: ${shown} (cannot be compared with the data we hold)`
    : `Declared benchmark: ${shown} (awaiting review before it can be compared)`;
}

/** Coerce the RPC rows; anything unexpected is dropped (the caller then treats the scheme as having no declared record only when the call itself succeeded). */
export function declaredRecordsFromRpc(data: unknown): Map<string, DeclaredRecord> {
  const out = new Map<string, DeclaredRecord>();
  if (!Array.isArray(data)) return out;
  for (const r of data as Array<Record<string, unknown>>) {
    if (typeof r?.instrument_id !== 'string' || typeof r.declared_name !== 'string' || typeof r.catalogue_state !== 'string') continue;
    const status = statusForCatalogueState(r.catalogue_state);
    if (!status) continue;
    const kind = r.benchmark_kind === 'composite' || r.benchmark_kind === 'commodity_price' ? r.benchmark_kind : 'single_index';
    out.set(r.instrument_id, { instrumentId: r.instrument_id, status, declaredName: r.declared_name, benchmarkKind: kind, catalogueState: r.catalogue_state });
  }
  return out;
}

/** True when the RPC failed only because migration 0252 is not applied yet (then nothing is declared, and behaviour is exactly as before). */
export function isDeclaredRecordsUnavailable(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === 'PGRST202' || error.code === '42883' || error.code === '42P01' || /could not find the function|does not exist|schema cache/i.test(error.message ?? '')));
}
