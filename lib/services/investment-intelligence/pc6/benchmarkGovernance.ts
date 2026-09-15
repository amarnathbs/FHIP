// PC6 (M6) — benchmark master governance and scheme -> benchmark mapping.
//
// N.7  benchmark master: identity, TRI/price-return distinction, category
//      applicability, source, currency, frequency, effective dates,
//      active/deprecated status.
// N.8  mapping: scheme-specific disclosed benchmark; category default WHERE
//      EXPLICITLY GOVERNED; effective dates; mapping source; admin override
//      with audit; "unmapped" as an HONEST STATE.
//      "Never guess Nifty/Sensex or another index merely to fill a blank."
//
// Pure decision logic. The repository/SQL half lives in the migration and the
// import runner; nothing here touches the network or the database.
//
// RELATIONSHIP TO THE CERTIFIED ENGINE. R4 already owns benchmark ARITHMETIC
// (lib/engines/investment-intelligence/benchmarkEngine.ts: resolveBenchmarkForDate,
// blendedBenchmarkReturn, activeReturn) and R5 owns the identical-cashflow
// benchmark SIP (sip/sipXirr.ts). None of that is reimplemented here. This
// module decides WHICH benchmark a scheme is entitled to be compared against
// and on what authority — a governance question, not a maths question.

export const PC6_MAPPING_RULES_VERSION = 'pc6-benchmark-mapping-v1';

/** Matches ii_benchmarks.return_type's CHECK domain (migration 0043). */
export type BenchmarkReturnType = 'TRI' | 'PRI' | 'DEBT_INDEX' | 'COMMODITY_GOLD' | 'OTHER';

export type BenchmarkLifecycle = 'active' | 'deprecated';

export type BenchmarkFrequency = 'daily' | 'business_daily' | 'monthly';

export interface BenchmarkDefinition {
  benchmarkId: string;
  benchmarkKey: string;
  benchmarkLabel: string;
  returnType: BenchmarkReturnType;
  currencyCode: string;
  countryCode: string;
  frequency: BenchmarkFrequency;
  /** Which PC6 source publishes this series. Null = not yet sourced (N.7/N.9). */
  sourceKey: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  lifecycle: BenchmarkLifecycle;
}

/**
 * On whose authority a scheme is mapped to a benchmark. The ORDER of this
 * union is the precedence order, and it is deliberately short: there is no
 * "inferred", "fuzzy" or "best guess" basis, because N.8 forbids one.
 */
export type MappingBasis =
  /** The AMC's own disclosed benchmark for that scheme, from an authoritative document. */
  | 'scheme_disclosed'
  /** A category-level default an admin has explicitly governed and signed off. */
  | 'governed_category_default'
  /** An admin's deliberate, reasoned, audited override of either of the above. */
  | 'admin_override';

export const MAPPING_BASIS_PRECEDENCE: readonly MappingBasis[] = [
  'admin_override',
  'scheme_disclosed',
  'governed_category_default',
] as const;

export interface SchemeBenchmarkMapping {
  instrumentId: string;
  benchmarkId: string;
  relationshipType: 'primary' | 'secondary' | 'category_average';
  basis: MappingBasis;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** ii_sources.source_key the mapping came from; null for an admin override. */
  mappingSourceKey: string | null;
  mappingVersion: string;
  /** Set only for admin_override. Enforced by `validateOverride` below. */
  overrideActorId?: string | null;
  overrideReason?: string | null;
  overrideRecordedAt?: string | null;
}

export interface GovernedCategoryDefault {
  countryCode: string;
  /** The AMFI category header verbatim, e.g. "Open Ended Schemes(Equity Scheme - Large Cap Fund)". */
  categoryHeaderRaw: string;
  benchmarkId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  /** Who signed this default off. A default with no approver is not governed. */
  approvedByActorId: string;
  approvedAt: string;
  rationale: string;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type MappingResolution =
  | { state: 'mapped'; mapping: SchemeBenchmarkMapping; basis: MappingBasis }
  | {
      state: 'unmapped';
      reason: 'NO_DISCLOSED_BENCHMARK' | 'NO_GOVERNED_CATEGORY_DEFAULT' | 'ALL_MAPPINGS_EXPIRED' | 'BENCHMARK_DEPRECATED';
      /** Operator-facing explanation. Never rendered as a number, never as zero. */
      detail: string;
    };

function isEffective(from: string, to: string | null, onDate: string): boolean {
  if (onDate < from) return false;
  if (to !== null && onDate > to) return false;
  return true;
}

/**
 * Resolve the benchmark a scheme should be compared against on a given date.
 *
 * `unmapped` IS A FIRST-CLASS RESULT, not a failure to be papered over. The
 * downstream certified engines already handle it correctly:
 * benchmarkService.computeBlendedBenchmark counts an unmapped holding toward
 * the coverage DENOMINATOR as `hasBenchmarkMapping: false`, so coverage falls
 * and blendedBenchmarkReturn suppresses the conclusion below its 80%
 * threshold. An unmapped scheme therefore reduces confidence in a comparison
 * rather than quietly contributing a 0% benchmark return.
 *
 * There is intentionally NO fallback to "the country's main index". Mapping a
 * debt fund or a gold ETF to NIFTY 50 because nothing better was on file would
 * produce a confidently wrong active return, which is worse than no number.
 */
export function resolveMapping(
  instrumentId: string,
  onDate: string,
  mappings: SchemeBenchmarkMapping[],
  benchmarksById: Record<string, BenchmarkDefinition>,
  categoryDefaults: GovernedCategoryDefault[],
  schemeCategoryHeaderRaw: string | null,
  countryCode: string
): MappingResolution {
  const candidates = mappings.filter(
    (m) => m.instrumentId === instrumentId && m.relationshipType === 'primary' && isEffective(m.effectiveFrom, m.effectiveTo, onDate)
  );

  const hadAnyMapping = mappings.some((m) => m.instrumentId === instrumentId && m.relationshipType === 'primary');

  for (const basis of MAPPING_BASIS_PRECEDENCE) {
    // Deterministic tie-break: the most recently effective wins, then benchmarkId.
    const forBasis = candidates
      .filter((m) => m.basis === basis)
      .sort((a, b) => (a.effectiveFrom === b.effectiveFrom ? a.benchmarkId.localeCompare(b.benchmarkId) : b.effectiveFrom.localeCompare(a.effectiveFrom)));
    for (const m of forBasis) {
      const bm = benchmarksById[m.benchmarkId];
      if (!bm) continue;
      if (bm.lifecycle === 'deprecated' || !isEffective(bm.effectiveFrom, bm.effectiveTo, onDate)) {
        return {
          state: 'unmapped',
          reason: 'BENCHMARK_DEPRECATED',
          detail: `The mapped benchmark ${bm.benchmarkKey} is not active on ${onDate} (lifecycle=${bm.lifecycle}, effective ${bm.effectiveFrom}..${bm.effectiveTo ?? 'open'}). No substitute is chosen automatically.`,
        };
      }
      return { state: 'mapped', mapping: m, basis };
    }
  }

  if (hadAnyMapping) {
    return {
      state: 'unmapped',
      reason: 'ALL_MAPPINGS_EXPIRED',
      detail: `Benchmark mappings exist for this scheme but none is effective on ${onDate}.`,
    };
  }

  if (schemeCategoryHeaderRaw) {
    const anyDefaultForCategory = categoryDefaults.some(
      (d) => d.countryCode === countryCode && d.categoryHeaderRaw === schemeCategoryHeaderRaw
    );
    if (!anyDefaultForCategory) {
      return {
        state: 'unmapped',
        reason: 'NO_GOVERNED_CATEGORY_DEFAULT',
        detail: `No admin-governed default benchmark exists for category "${schemeCategoryHeaderRaw}" in ${countryCode}. A default must be explicitly approved before it can be used; none is guessed.`,
      };
    }
  }

  return {
    state: 'unmapped',
    reason: 'NO_DISCLOSED_BENCHMARK',
    detail: 'No disclosed benchmark, governed category default, or admin override is on file for this scheme.',
  };
}

// ---------------------------------------------------------------------------
// Admin override — must be audited (N.8, N.11)
// ---------------------------------------------------------------------------

export interface OverrideValidation {
  ok: boolean;
  errors: string[];
}

export const MIN_OVERRIDE_REASON_LENGTH = 20;

/**
 * An admin override is only valid if it carries WHO, WHEN and WHY. This is
 * checked here AND enforced by a CHECK constraint in migration 0155, so an
 * unreasoned override cannot be written even by a direct service-role insert
 * that bypasses this code.
 */
export function validateOverride(mapping: SchemeBenchmarkMapping): OverrideValidation {
  const errors: string[] = [];
  if (mapping.basis !== 'admin_override') {
    if (mapping.overrideActorId || mapping.overrideReason) {
      errors.push('Override actor/reason supplied on a mapping whose basis is not admin_override.');
    }
    return { ok: errors.length === 0, errors };
  }
  if (!mapping.overrideActorId) errors.push('An admin override must record the acting admin.');
  if (!mapping.overrideRecordedAt) errors.push('An admin override must record when it was made.');
  const reason = (mapping.overrideReason ?? '').trim();
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
    errors.push(`An admin override must record a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters; got ${reason.length}.`);
  }
  if (mapping.mappingSourceKey) errors.push('An admin override must not claim an external source as its authority.');
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// TRI vs PRI (N.7, N.9)
// ---------------------------------------------------------------------------

export interface ReturnTypeCheck {
  acceptable: boolean;
  qualified: boolean;
  detail: string;
}

/**
 * A disclosed TRI benchmark must never be quietly satisfied by a price-return
 * series: PRI excludes dividends and structurally understates the benchmark,
 * making a fund look better than it is.
 *
 * R4 already annotates this at calculation time
 * (benchmarkService.computeBlendedBenchmark -> BENCHMARK_HISTORY_INCOMPLETE
 * when `requireTotalReturn` meets a PRI mapping). PC6's addition is at
 * GOVERNANCE time: the mapping itself is recorded as qualified, so the gap is
 * visible on the admin surface before any user ever sees a comparison.
 */
export function checkReturnType(required: BenchmarkReturnType, actual: BenchmarkReturnType): ReturnTypeCheck {
  if (required === actual) return { acceptable: true, qualified: false, detail: `Benchmark return type matches the requirement (${required}).` };
  if (required === 'TRI' && actual === 'PRI') {
    return {
      acceptable: true,
      qualified: true,
      detail:
        'A Price Return Index is standing in for a required Total Return Index. PRI excludes dividends and understates the benchmark, so any comparison built on it is qualified, never presented as like-for-like.',
    };
  }
  return {
    acceptable: false,
    qualified: true,
    detail: `Benchmark return type ${actual} cannot stand in for a required ${required}. The comparison is unavailable rather than approximated.`,
  };
}

// ---------------------------------------------------------------------------
// Gap reporting for the admin surface (N.11)
// ---------------------------------------------------------------------------

/** The reasons a scheme can be unmapped, extracted from MappingResolution itself. */
export type UnmappedReason = Extract<MappingResolution, { state: 'unmapped' }>['reason'];

export interface MappingGapRow {
  instrumentId: string;
  schemeName: string;
  amfiSchemeCode: string | null;
  categoryHeaderRaw: string | null;
  reason: UnmappedReason;
  detail: string;
}

export function collectMappingGaps(
  schemes: Array<{ instrumentId: string; schemeName: string; amfiSchemeCode: string | null; categoryHeaderRaw: string | null }>,
  onDate: string,
  mappings: SchemeBenchmarkMapping[],
  benchmarksById: Record<string, BenchmarkDefinition>,
  categoryDefaults: GovernedCategoryDefault[],
  countryCode: string
): MappingGapRow[] {
  const gaps: MappingGapRow[] = [];
  for (const s of schemes) {
    const r = resolveMapping(s.instrumentId, onDate, mappings, benchmarksById, categoryDefaults, s.categoryHeaderRaw, countryCode);
    if (r.state === 'unmapped') {
      gaps.push({
        instrumentId: s.instrumentId,
        schemeName: s.schemeName,
        amfiSchemeCode: s.amfiSchemeCode,
        categoryHeaderRaw: s.categoryHeaderRaw,
        reason: r.reason,
        detail: r.detail,
      });
    }
  }
  return gaps;
}
