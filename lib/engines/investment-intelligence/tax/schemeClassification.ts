// Investment Intelligence R6-P1 — mutual-fund tax classification
// (equity-oriented / debt-specified / other-hybrid / unresolved).
//
// Reuses R2's Portfolio Truth look-through data (`ii_fund_holdings`:
// fund_instrument_id → underlying_instrument_id, weight_pct, disclosure_date;
// joined to `ii_instruments` for each underlying's instrument_class and
// country_of_domicile) rather than inventing a parallel classification
// table populated from scratch. This module does not re-run R5's full
// recursive weighted look-through engine (`xray/lookThrough.ts`) — tax
// classification only needs the FUND's own top-level disclosed allocation
// (equity vs non-equity, domestic vs foreign), not a portfolio-wide
// effective-exposure walk through nested funds-of-funds, so a narrower,
// purpose-built aggregation is used here instead of pulling in X-Ray's
// heavier machinery.
//
// AMBIGUITY HANDLING: when disclosure data is missing, or is present but
// stale beyond a reasonable staleness window, or a scheme is a "specified
// mutual fund" only by acquisition-date rule (debt/specified — see
// ruleVersions.ts) rather than allocation, the engine marks the
// classification `unresolved` rather than defaulting to any specific class.
// An unresolved scheme is excluded from any confident tax figure (see
// capitalGainsEngine.ts) and surfaced as a data-quality gap, never silently
// guessed as equity.

export interface UnderlyingHoldingRow {
  underlyingInstrumentId: string | null;
  weightPct: number; // 0..100
  underlyingInstrumentClass: string | null; // e.g. 'equity', 'bond', 'cash', null if unresolved underlying
  underlyingCountryOfDomicile: string | null; // ISO country code, null if unresolved
}

export interface SchemeClassificationInput {
  instrumentKey: string;
  /** Fund's own domicile — "domestic" equity means underlying equity whose
   * country_of_domicile matches this. */
  fundCountryOfDomicile: string;
  /** Most recent disclosure batch at/ before the as-of date, or null if no
   * disclosure exists at all. */
  holdings: readonly UnderlyingHoldingRow[] | null;
  disclosureDate: string | null;
  asOfDate: string;
  /** Domestic-equity threshold, sourced from the resolved rule version
   * (ruleVersions.ts EquityOrientedRules.domesticEquityThresholdPct) —
   * NEVER hardcoded independently here, so classification always matches
   * whichever rule version is in force for the disposal being evaluated. */
  domesticEquityThresholdPct: number;
  /** Debt/specified-fund acquisition-date rule: if the scheme is known
   * (from the instrument master / scheme category) to be a debt/specified
   * mutual fund, this overrides the allocation-based test entirely, per
   * spec — "specified mutual fund" status is an acquisition-date rule, not
   * an allocation percentage. */
  knownDebtSpecifiedByCategory: boolean;
  /** How stale a disclosure is allowed to be (days) before it's treated as
   * missing for classification purposes. Defaults to ~18 months (548 days)
   * — mutual fund portfolio disclosures are monthly/fortnightly in India, so
   * anything older than that is stale enough to not trust for a >=65% test. */
  maxDisclosureAgeDays?: number;
}

export type SchemeClassificationBasis =
  | 'computed_from_holdings'
  | 'known_debt_specified_category'
  | 'unresolved_no_data'
  | 'unresolved_stale_data'
  // R12 addition — a direct listed security (equity or equity-oriented ETF)
  // classified by statute, not by look-through allocation. See
  // classifyDirectListedSecurity() below and migration 0092.
  | 'direct_listed_security_rule';

export interface SchemeClassificationResult {
  instrumentKey: string;
  classification: import('./ruleVersions').SchemeTaxClass | 'unresolved';
  domesticEquityPct: number | null;
  basis: SchemeClassificationBasis;
  disclosureDate: string | null;
  note: string;
}

function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

export function classifyScheme(input: SchemeClassificationInput): SchemeClassificationResult {
  const { instrumentKey, fundCountryOfDomicile, holdings, disclosureDate, asOfDate, domesticEquityThresholdPct, knownDebtSpecifiedByCategory, maxDisclosureAgeDays = 548 } = input;

  if (knownDebtSpecifiedByCategory) {
    return {
      instrumentKey,
      classification: 'debt_specified',
      domesticEquityPct: null,
      basis: 'known_debt_specified_category',
      disclosureDate,
      note: 'Classified debt/specified mutual fund from scheme category master data — the "specified mutual fund" rule is an acquisition-date rule, not an allocation test.',
    };
  }

  if (!holdings || holdings.length === 0 || !disclosureDate) {
    return {
      instrumentKey,
      classification: 'unresolved',
      domesticEquityPct: null,
      basis: 'unresolved_no_data',
      disclosureDate: null,
      note: 'No fund-holdings disclosure available for this scheme — classification cannot be determined from actual allocation data. Excluded from confident tax figures; flagged as a data-quality gap.',
    };
  }

  const ageDays = daysBetween(disclosureDate, asOfDate);
  if (ageDays > maxDisclosureAgeDays) {
    return {
      instrumentKey,
      classification: 'unresolved',
      domesticEquityPct: null,
      basis: 'unresolved_stale_data',
      disclosureDate,
      note: `Most recent disclosure (${disclosureDate}) is ${ageDays} days old, beyond the ${maxDisclosureAgeDays}-day staleness window — treated as unavailable rather than guessed.`,
    };
  }

  const totalWeight = holdings.reduce((sum, h) => sum + h.weightPct, 0);
  const domesticEquityWeight = holdings
    .filter((h) => h.underlyingInstrumentClass === 'equity' && h.underlyingCountryOfDomicile === fundCountryOfDomicile)
    .reduce((sum, h) => sum + h.weightPct, 0);

  // If more than a small slice of the disclosed weight has no resolvable
  // underlying classification, the >=65% test isn't trustworthy either way
  // — an unresolved 40% chunk could tip a 60%-equity fund over or under the
  // threshold. Treat coverage below 80% of disclosed weight as unresolved.
  const unresolvedWeight = holdings.filter((h) => h.underlyingInstrumentClass === null || h.underlyingCountryOfDomicile === null).reduce((sum, h) => sum + h.weightPct, 0);
  const resolvedCoveragePct = totalWeight > 0 ? ((totalWeight - unresolvedWeight) / totalWeight) * 100 : 0;

  if (resolvedCoveragePct < 80) {
    return {
      instrumentKey,
      classification: 'unresolved',
      domesticEquityPct: totalWeight > 0 ? Math.round((domesticEquityWeight / totalWeight) * 1000) / 10 : null,
      basis: 'unresolved_no_data',
      disclosureDate,
      note: `Only ${resolvedCoveragePct.toFixed(1)}% of disclosed holdings weight has resolvable underlying classification — insufficient to confidently apply the ${domesticEquityThresholdPct}% domestic-equity test.`,
      };
  }

  const domesticEquityPct = totalWeight > 0 ? Math.round((domesticEquityWeight / totalWeight) * 1000) / 10 : 0;
  const classification = domesticEquityPct >= domesticEquityThresholdPct ? 'equity_oriented' : 'other_hybrid';

  return {
    instrumentKey,
    classification,
    domesticEquityPct,
    basis: 'computed_from_holdings',
    disclosureDate,
    note: `Domestic equity allocation ${domesticEquityPct}% vs ${domesticEquityThresholdPct}% threshold, as disclosed ${disclosureDate}.`,
  };
}

// ---------------------------------------------------------------------------
// R12 — direct listed security classification (equity / equity-oriented
// ETF). Deliberately NOT a look-through allocation test: a direct listed
// equity share IS the underlying security (spec section 48 — "do not
// attempt fund-style look-through"), and Section 111A/112A of the Income
// Tax Act taxes "an equity share in a company" and "a unit of an equity
// oriented fund" (which includes an equity ETF, per SEBI/CBDT's own
// definition of equity-oriented fund extending to exchange-traded funds
// substantially invested in domestic equity) identically — same 12-month
// STCG/LTCG holding-period threshold, same rate structure, same Section
// 55(2)(ac) 31-Jan-2018 FMV grandfathering scope. Grandfathering has never
// been mutual-fund-specific; the statute's own language covers "a capital
// asset being an equity share... or a unit... in respect of which
// securities transaction tax has been paid" without distinguishing a
// directly-held share from a fund unit.
//
// This function is intentionally NOT called classifyScheme() and does not
// touch classifyScheme() at all — it is a separate, much simpler rule for
// a genuinely different input shape (a single security with no underlying
// holdings to disclose, vs. a pooled vehicle's allocation). Both write into
// the SAME ii_scheme_tax_classification cache table and are read by the
// SAME unmodified computeDisposalTax() (capitalGainsEngine.ts) — R12 does
// not create a second tax calculator (spec section 53).
//
// R12's frozen scope (R12_ASSET_CLASS_SCOPE_MATRIX.md) restricts this to
// instrument_class 'equity' (always equity_oriented by statute) and 'etf'
// (equity_oriented ONLY when the ETF is itself equity-oriented — R12 does
// NOT attempt to infer this from instrument_class alone, per spec section
// 57's explicit warning; the caller must supply isEquityOriented, sourced
// from the user's own declaration at manual-entry time, which the R12
// manual-entry route restricts to equity-oriented ETFs only).
// ---------------------------------------------------------------------------
export type DirectSecurityInstrumentClass = 'equity' | 'etf';

export interface ClassifyDirectListedSecurityInput {
  instrumentKey: string;
  instrumentClass: DirectSecurityInstrumentClass;
  /** For 'etf' only — must be explicitly declared true by the entry path;
   * never inferred. Ignored (treated as true) for 'equity'. */
  isEquityOriented?: boolean;
}

export function classifyDirectListedSecurity(input: ClassifyDirectListedSecurityInput): SchemeClassificationResult {
  const { instrumentKey, instrumentClass, isEquityOriented } = input;

  if (instrumentClass === 'etf' && isEquityOriented !== true) {
    return {
      instrumentKey,
      classification: 'unresolved',
      domesticEquityPct: null,
      basis: 'unresolved_no_data',
      disclosureDate: null,
      note: 'ETF was not declared equity-oriented at entry — R12 does not infer tax classification from instrument_class="etf" alone (non-equity ETFs have distinct tax treatment). Excluded from confident tax figures.',
    };
  }

  return {
    instrumentKey,
    classification: 'equity_oriented',
    domesticEquityPct: 100,
    basis: 'direct_listed_security_rule',
    disclosureDate: null,
    note:
      instrumentClass === 'equity'
        ? 'Direct listed Indian equity share — equity_oriented by statute (Section 111A/112A), not an allocation test. No look-through disclosure applies (the security is its own underlying).'
        : 'Equity-oriented ETF, declared at entry — equity_oriented by statute (Section 111A/112A extends to equity-oriented exchange-traded funds), not an allocation test.',
  };
}
