// "Held schemes" and which benchmark applies to each: the PURE half (no I/O, client-safe, no personal data).
//
// The held population comes from the aggregate-only RPC benchmark_held_schemes() (migration 0251): per
// instrument a holder COUNT and the earliest held date, never a user, account, unit or amount. This module
// cleans names for DISPLAY ONLY, works out plan type and a category label, and says which benchmark applies.
//
// WHY HELD-FIRST. The earlier "schemes with no mapping" panel counts the whole AMFI universe, so the handful
// of schemes users actually hold are one line among thousands. This list is driven by what is held.
//
// INFORMATIONAL VIEW. Since the PO decision of 2026-10-03 a held scheme with no declared (admin) mapping is
// compared with the usual benchmark for its category AT READ TIME (categoryReference.ts). Nothing here asks
// an admin to approve that. An admin may OPTIONALLY enter the fund's declared benchmark from its factsheet;
// a declared mapping then always wins.

import type { DeclaredBenchmarkEvidence } from './schemeMappingProposals';
import { categoryReferenceFor, CATEGORY_REFERENCE_KIND, DECLARED_BENCHMARK_LABEL, type FundCategorySource } from './categoryReference';

export type HeldStatus = 'mapped' | 'proposal_waiting' | 'not_mapped';

/** One row of the RPC result, camel-cased. */
export interface HeldSchemeRaw {
  instrumentId: string;
  instrumentName: string;
  amcName: string | null;
  amfiSchemeCode: string | null;
  subCategory: string | null;
  categoryHeaderRaw: string | null;
  holderCount: number;
  firstHeldDate: string | null; // ISO yyyy-mm-dd (data; formatted day-first at the screen)
  mapped: boolean;
  proposalWaiting: boolean;
}

export type PlanType = 'Direct' | 'Regular' | 'Not stated in the name';

/**
 * Which benchmark applies to a held scheme (INFORMATION ONLY):
 *   declared            an admin-entered, approved mapping exists (it always wins);
 *   category_reference  none declared, so the usual benchmark for the fund's category applies at read time
 *                       (an in-memory reference: never stored, never a proposal);
 *   none                no declared mapping and the category has no honest benchmark in the catalogue.
 * Whether a RETURN figure appears still depends on a verified catalogue entry, a total-return series and an
 * approved entitlement. This list says which benchmark NAME applies, nothing more.
 */
export type HeldBenchmarkState =
  | { kind: 'declared'; label: typeof DECLARED_BENCHMARK_LABEL }
  | {
      kind: typeof CATEGORY_REFERENCE_KIND;
      categoryLabel: string;
      categorySource: FundCategorySource;
      benchmarkKey: string;
      benchmarkLabel: string;
      /** "Compared with the usual benchmark for <category> funds (not this fund's own declared benchmark)". */
      basisLabel: string;
      unsure: boolean;
    }
  | { kind: 'none'; message: string };

export interface HeldSchemeRow {
  instrumentId: string;
  /** Cleaned for display only. */
  displayName: string;
  /** The name exactly as the statement printed it (tooltip / secondary text). */
  originalName: string;
  planType: PlanType;
  amcName: string | null;
  amfiSchemeCode: string | null;
  category: string;
  categorySource: 'scheme_master' | 'name_hint' | 'unknown';
  holderCount: number;
  firstHeldDate: string | null;
  status: HeldStatus;
  /** Which benchmark applies (informational; no admin step required). */
  benchmark: HeldBenchmarkState;
  /** A verified declared-benchmark source holds a benchmark for this scheme (always false today). */
  sourcePrefilled: boolean;
  /** Declared evidence from the verified source, ready to pre-fill an OPTIONAL declared-benchmark proposal. Empty today. */
  prefilledDeclared: DeclaredBenchmarkEvidence[];
}

export interface HeldSchemesResponse {
  rows: HeldSchemeRow[];
  /** Whether any verified declared-benchmark source is switched on (false today). */
  verifiedSourceAvailable: boolean;
  counts: { held: number; declared: number; categoryReference: number; noBenchmark: number; proposalWaiting: number };
}

// ---------------------------------------------------------------------------
// Display cleaning
// ---------------------------------------------------------------------------

/** AMC short names that must never be mistaken for a registrar scheme code. */
const AMC_ACRONYMS = new Set(['UTI', 'SBI', 'HDFC', 'ICICI', 'AXIS', 'KOTAK', 'LIC', 'DSP', 'IDFC', 'TATA', 'BNP', 'PGIM', 'HSBC', 'NIPPON', 'INVESCO', 'BANDHAN', 'BARODA', 'CANARA', 'MIRAE', 'QUANT', 'QUANTUM', 'PPFAS', 'MOTILAL', 'EDELWEISS', 'SUNDARAM', 'FRANKLIN']);

/**
 * Strip the registrar's internal scheme-code prefix ("108MFGPG-", "H44-", "FTI037-", "HGFG-") and the
 * "(Non-Demat)" noise. DISPLAY ONLY: the original name is kept alongside and is what the records hold.
 * A prefix is an all-uppercase alphanumeric code of 2-10 characters joined to the name by a hyphen with
 * NO space after it, that either contains a digit or is at least 4 characters, and is not an AMC name.
 */
export function cleanSchemeName(raw: string): string {
  let s = (raw ?? '').trim();
  const m = /^([A-Z0-9]{2,10})-(?=\S)/.exec(s);
  if (m) {
    const code = m[1];
    if (!AMC_ACRONYMS.has(code) && (/\d/.test(code) || code.length >= 4)) s = s.slice(m[0].length);
  }
  s = s.replace(/\(\s*(?:non[\s-]*demat|demat)\s*\)/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function planTypeFromName(name: string): PlanType {
  if (/\bdirect\b/i.test(name)) return 'Direct';
  if (/\bregular\b/i.test(name)) return 'Regular';
  return 'Not stated in the name';
}

/** Best-effort category label from the scheme's name, for DISPLAY and for finding the factsheet. Only a HINT: nothing here is evidence. */
export function categoryHintFromName(name: string): string | null {
  const s = name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ');
  const rules: Array<[RegExp, string]> = [
    [/multi asset/, 'Multi Asset Allocation'],
    [/balanced advantage|dynamic asset allocation/, 'Balanced Advantage / Dynamic Asset Allocation'],
    [/large and mid|large mid/, 'Large and Mid Cap'],
    [/large cap|bluechip|blue chip|top 100|frontline/, 'Large Cap'],
    [/mid cap|midcap/, 'Mid Cap'],
    [/small cap|smallcap/, 'Small Cap'],
    [/flexi cap|flexicap/, 'Flexi Cap'],
    [/multi cap|multicap/, 'Multi Cap'],
    [/\belss\b|tax saver|tax saving/, 'ELSS'],
    [/contra/, 'Contra'],
    [/dividend yield/, 'Dividend Yield'],
    [/focused/, 'Focused'],
    [/\bvalue\b/, 'Value'],
    [/gold|silver/, 'Gold / silver fund'],
    [/liquid/, 'Liquid'],
    [/overnight/, 'Overnight'],
    [/corporate bond/, 'Corporate Bond'],
    [/gilt/, 'Gilt'],
    [/index|etf|nifty|sensex/, 'Index fund / ETF'],
    [/infra|power|pharma|banking|technology|consumption|mnc|energy|manufacturing|psu/, 'Sectoral / Thematic'],
    [/hybrid/, 'Hybrid'],
  ];
  for (const [re, label] of rules) if (re.test(s)) return label;
  return null;
}

// ---------------------------------------------------------------------------
// Verified declared-benchmark source plumbing (nothing is invented)
// ---------------------------------------------------------------------------

/**
 * MASTER SWITCH for pre-filling an OPTIONAL declared-benchmark proposal from a verified source. Default: NONE.
 * AMFI's NAVAll scheme master carries no benchmark field (PO confirmed AMFI's page shows none either),
 * so today no source exists. Set to true only together with real, evidenced entries in VERIFIED_DECLARED_BENCHMARKS.
 */
export const VERIFIED_DECLARED_BENCHMARK_SOURCE_AVAILABLE = false;

export interface VerifiedDeclaredBenchmark {
  /** AMFI scheme code the declaration belongs to. */
  amfiSchemeCode: string;
  declared: DeclaredBenchmarkEvidence[];
}

/** Evidenced declarations. EMPTY: no verified source exists yet. */
export const VERIFIED_DECLARED_BENCHMARKS: readonly VerifiedDeclaredBenchmark[] = [];

/** Pure: the verified declared evidence for this scheme, or [] (always [] while the switch is off). */
export function declaredBenchmarksFor(
  amfiSchemeCode: string | null,
  enabled: boolean = VERIFIED_DECLARED_BENCHMARK_SOURCE_AVAILABLE,
  sources: readonly VerifiedDeclaredBenchmark[] = VERIFIED_DECLARED_BENCHMARKS
): DeclaredBenchmarkEvidence[] {
  if (!enabled || !amfiSchemeCode) return [];
  return sources.find((s) => s.amfiSchemeCode === amfiSchemeCode)?.declared ?? [];
}

// ---------------------------------------------------------------------------
// Which benchmark applies
// ---------------------------------------------------------------------------

/** Pure: the benchmark state for one held scheme. A declared (mapped) scheme is declared; the rest use the category reference or none. */
export function heldBenchmarkState(r: Pick<HeldSchemeRaw, 'instrumentName' | 'subCategory' | 'categoryHeaderRaw' | 'mapped'>): HeldBenchmarkState {
  if (r.mapped) return { kind: 'declared', label: DECLARED_BENCHMARK_LABEL };
  const ref = categoryReferenceFor({ subCategory: r.subCategory, categoryHeaderRaw: r.categoryHeaderRaw, instrumentName: r.instrumentName });
  if (ref.state === 'none') return { kind: 'none', message: ref.message };
  return { kind: CATEGORY_REFERENCE_KIND, categoryLabel: ref.categoryLabel, categorySource: ref.categorySource, benchmarkKey: ref.benchmarkKey, benchmarkLabel: ref.benchmarkLabel, basisLabel: ref.basisLabel, unsure: ref.unsure };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface BuildHeldOptions {
  verifiedSourceEnabled?: boolean;
  verifiedSources?: readonly VerifiedDeclaredBenchmark[];
}

export function buildHeldSchemeRows(raw: readonly HeldSchemeRaw[], opts: BuildHeldOptions = {}): HeldSchemesResponse {
  const enabled = opts.verifiedSourceEnabled ?? VERIFIED_DECLARED_BENCHMARK_SOURCE_AVAILABLE;
  const rows: HeldSchemeRow[] = raw.map((r) => {
    const sub = (r.subCategory ?? '').trim();
    const hint = sub ? null : categoryHintFromName(cleanSchemeName(r.instrumentName));
    const status: HeldStatus = r.mapped ? 'mapped' : r.proposalWaiting ? 'proposal_waiting' : 'not_mapped';
    const prefilledDeclared = status === 'not_mapped' ? declaredBenchmarksFor(r.amfiSchemeCode, enabled, opts.verifiedSources) : [];
    return {
      instrumentId: r.instrumentId,
      displayName: cleanSchemeName(r.instrumentName) || r.instrumentName,
      originalName: r.instrumentName,
      planType: planTypeFromName(r.instrumentName),
      amcName: r.amcName,
      amfiSchemeCode: r.amfiSchemeCode,
      category: sub || hint || 'Unknown',
      categorySource: sub ? 'scheme_master' : hint ? 'name_hint' : 'unknown',
      holderCount: r.holderCount,
      firstHeldDate: r.firstHeldDate,
      status,
      benchmark: heldBenchmarkState(r),
      sourcePrefilled: prefilledDeclared.length > 0,
      prefilledDeclared,
    };
  });
  // No declared benchmark first (the ones an admin might want to enter), then waiting, then declared; most held first.
  const order: Record<HeldStatus, number> = { not_mapped: 0, proposal_waiting: 1, mapped: 2 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.holderCount - a.holderCount || a.displayName.localeCompare(b.displayName));
  return {
    rows,
    verifiedSourceAvailable: enabled,
    counts: {
      held: rows.length,
      declared: rows.filter((r) => r.benchmark.kind === 'declared').length,
      categoryReference: rows.filter((r) => r.benchmark.kind === CATEGORY_REFERENCE_KIND).length,
      noBenchmark: rows.filter((r) => r.benchmark.kind === 'none').length,
      proposalWaiting: rows.filter((r) => r.status === 'proposal_waiting').length,
    },
  };
}

/** Coerce the RPC's rows; anything unexpected is dropped rather than shown (fail closed). */
export function heldRawFromRpc(data: unknown): HeldSchemeRaw[] {
  if (!Array.isArray(data)) return [];
  const out: HeldSchemeRaw[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    if (typeof r?.instrument_id !== 'string' || typeof r.instrument_name !== 'string') continue;
    out.push({
      instrumentId: r.instrument_id,
      instrumentName: r.instrument_name,
      amcName: typeof r.amc_name === 'string' ? r.amc_name : null,
      amfiSchemeCode: typeof r.amfi_scheme_code === 'string' ? r.amfi_scheme_code : null,
      subCategory: typeof r.sub_category === 'string' ? r.sub_category : null,
      categoryHeaderRaw: typeof r.category_header_raw === 'string' ? r.category_header_raw : null,
      holderCount: Number(r.holder_count) || 0,
      firstHeldDate: typeof r.first_held_date === 'string' ? r.first_held_date.slice(0, 10) : null,
      mapped: r.mapped === true,
      proposalWaiting: r.proposal_waiting === true,
    });
  }
  return out;
}
