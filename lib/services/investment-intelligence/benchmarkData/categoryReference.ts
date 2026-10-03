// CATEGORY REFERENCE benchmark: one pure, config-driven table from a fund's CATEGORY to a catalogue series.
//
// PO decision (2026-10-03): a fund that has no declared (admin-entered) benchmark is compared with the
// usual benchmark for its category, automatically, with NO approval step, and always labelled as such.
// This module is the single place that table lives.
//
// HOW IT STAYS SAFE (nothing here weakens a database or engine guard):
//   * It resolves at READ time. A category reference is never written to ii_instrument_benchmarks, never
//     stored as 'primary', never a proposal, and never reaches auto_publish_benchmark_mapping. In code it is
//     its own relationship kind: 'category_reference'. No migration, no new table.
//   * A DECLARED or admin mapping ALWAYS wins. If an instrument has any declared primary mapping, the
//     category reference is not consulted for it at all.
//   * Every gate downstream still applies: the catalogue entry must be VERIFIED, the series must be total
//     return (a price index is never used), customer display must be entitled, the holding-period replay
//     must have history. Until a licence exists a user sees the benchmark NAME and no return figure.
//   * A category with no honest equivalent in the catalogue gets NO category benchmark, and the screen says
//     "benchmark not available for this fund category".
//
// STATUS: THE TABLE IS UNVERIFIED. AMFI's own Tier-1 category list could not be read from this environment
// (see docs/investment-intelligence/bench1_phase2/SCHEME_BENCHMARK_SOURCES_2026-10-03.md). Each row names a
// series that exists in the seeded catalogue manifest (bench1_phase2/catalogue_manifest.json); the choice of
// series per category is a judgement documented per row, to be eyeballed by the PO.

export const CATEGORY_REFERENCE_VERSION = 'category-reference-v1';
/** The relationship kind used in code only. Never a stored value of ii_instrument_benchmarks.relationship_type. */
export const CATEGORY_REFERENCE_KIND = 'category_reference' as const;
export const DECLARED_BENCHMARK_LABEL = "Fund's declared benchmark";

export type CategoryRefKey =
  | 'large_cap'
  | 'mid_cap'
  | 'small_cap'
  | 'large_mid_cap'
  | 'flexi_cap'
  | 'multi_cap'
  | 'elss'
  | 'focused'
  | 'value'
  | 'contra'
  | 'balanced_advantage'
  | 'aggressive_hybrid'
  | 'corporate_bond'
  | 'infrastructure'
  | 'mnc';

export interface CategoryReferenceRow {
  key: CategoryRefKey;
  /** Used in user-facing text: "usual benchmark for <label> funds". */
  label: string;
  /** The catalogue series (ii_benchmarks.benchmark_key). */
  benchmarkKey: string;
  benchmarkLabel: string;
  /** Why this series for this category, and how sure that is. */
  rationale: string;
  /** true where the choice rests on more judgement than the category norm; flagged to the PO. */
  unsure: boolean;
  status: 'UNVERIFIED';
}

export const CATEGORY_REFERENCE_TABLE: readonly CategoryReferenceRow[] = [
  { key: 'large_cap', label: 'Large Cap', benchmarkKey: 'IN_NIFTY_100_TRI', benchmarkLabel: 'NIFTY 100 TRI', rationale: 'The SEBI Tier-1 norm for large cap is NIFTY 100 or BSE 100; NIFTY 100 TRI is the seeded series most held large-cap funds declare.', unsure: false, status: 'UNVERIFIED' },
  { key: 'mid_cap', label: 'Mid Cap', benchmarkKey: 'IN_NIFTY_MIDCAP_150_TRI', benchmarkLabel: 'Nifty Midcap 150 TRI', rationale: 'The usual mid-cap Tier-1 index; all three held mid-cap funds declare it.', unsure: false, status: 'UNVERIFIED' },
  { key: 'small_cap', label: 'Small Cap', benchmarkKey: 'IN_BSE_250_SMALLCAP_TRI', benchmarkLabel: 'BSE 250 SmallCap TRI', rationale: 'PO choice. The category norm may equally be Nifty Smallcap 250 TRI, which is not in the seeded catalogue.', unsure: true, status: 'UNVERIFIED' },
  { key: 'large_mid_cap', label: 'Large and Mid Cap', benchmarkKey: 'IN_NIFTY_LARGEMIDCAP_250_TRI', benchmarkLabel: 'Nifty LargeMidcap 250 TRI', rationale: 'The usual Tier-1 index for large and mid cap funds.', unsure: false, status: 'UNVERIFIED' },
  { key: 'flexi_cap', label: 'Flexi Cap', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'Broad all-cap index; the usual flexi-cap Tier-1 choice (BSE 500 is the alternative).', unsure: false, status: 'UNVERIFIED' },
  { key: 'multi_cap', label: 'Multi Cap', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'PO choice. The category norm is the Nifty500 Multicap 50:25:25 index, which is not in the seeded catalogue; Nifty 500 is the nearest broad series.', unsure: true, status: 'UNVERIFIED' },
  { key: 'elss', label: 'ELSS', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'Tax-saving funds are diversified equity; Nifty 500 (or BSE 500) is the usual Tier-1 choice.', unsure: false, status: 'UNVERIFIED' },
  { key: 'focused', label: 'Focused', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'PO choice: broad all-cap index. Individual focused funds declare different indices.', unsure: true, status: 'UNVERIFIED' },
  { key: 'value', label: 'Value', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'PO choice: broad all-cap index. Value funds often declare a style index instead.', unsure: true, status: 'UNVERIFIED' },
  { key: 'contra', label: 'Contra', benchmarkKey: 'IN_NIFTY_500_TRI', benchmarkLabel: 'Nifty 500 TRI', rationale: 'PO choice: broad all-cap index. The held contra fund declares BSE 500 TRI, a different owner\'s equivalent.', unsure: true, status: 'UNVERIFIED' },
  { key: 'balanced_advantage', label: 'Balanced Advantage', benchmarkKey: 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', benchmarkLabel: 'NIFTY 50 Hybrid Composite Debt 50:50 Index TRI', rationale: 'PO choice. Balanced advantage funds usually declare this index, but some declare their own composite.', unsure: true, status: 'UNVERIFIED' },
  { key: 'aggressive_hybrid', label: 'Aggressive Hybrid', benchmarkKey: 'IN_NIFTY50_HYBRID_COMP_DEBT_5050_TRI', benchmarkLabel: 'NIFTY 50 Hybrid Composite Debt 50:50 Index TRI', rationale: 'PO choice. UNSURE: the usual aggressive-hybrid norm is a 65:35 equity-debt composite, not 50:50.', unsure: true, status: 'UNVERIFIED' },
  { key: 'corporate_bond', label: 'Corporate Bond', benchmarkKey: 'IN_NIFTY_CORPORATE_BOND_A2_TRI', benchmarkLabel: 'NIFTY Corporate Bond Index A-II TRI', rationale: 'The seeded debt series; corporate bond funds commonly use the NIFTY Corporate Bond Index (A-II or A-III by risk class).', unsure: true, status: 'UNVERIFIED' },
  { key: 'infrastructure', label: 'Infrastructure', benchmarkKey: 'IN_NIFTY_INFRASTRUCTURE_TRI', benchmarkLabel: 'Nifty Infrastructure TRI', rationale: 'Applied to a sectoral fund whose NAME says infrastructure or power. A category list gives no single index for sectoral funds, so this rests on the name.', unsure: true, status: 'UNVERIFIED' },
  { key: 'mnc', label: 'MNC', benchmarkKey: 'IN_NIFTY_MNC_TRI', benchmarkLabel: 'Nifty MNC TRI', rationale: 'Applied to a thematic fund whose NAME says MNC. Rests on the name.', unsure: true, status: 'UNVERIFIED' },
];

/**
 * Categories that deliberately get NO category benchmark (no honest equivalent in the catalogue or the
 * benchmark depends on the fund's own composite / index / theme). Listed for the PO and for tests.
 */
export const CATEGORIES_WITHOUT_REFERENCE: readonly string[] = [
  'Gold / silver fund of funds', 'Multi asset allocation', 'International / overseas funds', 'Index funds and ETFs', 'Liquid, overnight, money market and other debt categories (other than corporate bond)', 'Gilt', 'Dividend yield', 'Other sectoral and thematic funds', 'Solution-oriented (retirement, children)', 'Conservative and other hybrid categories',
];

// ---------------------------------------------------------------------------
// Category resolution
// ---------------------------------------------------------------------------

export interface FundCategoryInput {
  /** AMFI sub-category as ii_scheme_master stores it ("Large Cap Fund"). */
  subCategory: string | null | undefined;
  /** The AMFI section header as stored (verbatim). Used only when the sub-category is empty. */
  categoryHeaderRaw?: string | null;
  /** The instrument's name as the statement printed it (used only for statement-created funds with no category, and for sectoral name hints). */
  instrumentName?: string | null;
}

export type FundCategorySource = 'scheme_master' | 'category_header' | 'name_inference' | 'none';

export interface ResolvedFundCategory {
  key: CategoryRefKey | null;
  /** Human wording of the category the fund is in, even when no reference exists ("Gilt Fund"). */
  displayCategory: string | null;
  source: FundCategorySource;
}

const norm = (s: string | null | undefined): string =>
  (s ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Strip a registrar code prefix and demat noise so the name can be inspected. */
function nameForInference(raw: string | null | undefined): string {
  return norm((raw ?? '').replace(/^[A-Z0-9]{2,10}-(?=\S)/, '').replace(/\(\s*non[\s-]*demat\s*\)/gi, ' '));
}

/** Patterns tried, in order, against a normalised category string. null result = "no category reference". */
function keyFromCategoryText(s: string): { key: CategoryRefKey | null; matched: boolean } {
  if (!s) return { key: null, matched: false };
  // Categories that never get a reference.
  if (/\bindex\b|\betf\b|\bfof\b|fund of fund|\bdebt\b|duration|liquid|overnight|money market|gilt|credit|floater|banking and psu|solution|retirement|children|gold|silver|overseas|international|multi asset|arbitrage|equity savings|conservative|dividend yield/.test(s) && !/corporate bond/.test(s)) {
    return { key: null, matched: true };
  }
  if (/corporate bond/.test(s)) return { key: 'corporate_bond', matched: true };
  if (/large and mid/.test(s)) return { key: 'large_mid_cap', matched: true };
  if (/\bmulti cap\b/.test(s)) return { key: 'multi_cap', matched: true };
  if (/\bflexi cap\b/.test(s)) return { key: 'flexi_cap', matched: true };
  if (/\blarge cap\b/.test(s)) return { key: 'large_cap', matched: true };
  if (/\bmid cap\b/.test(s)) return { key: 'mid_cap', matched: true };
  if (/\bsmall cap\b/.test(s)) return { key: 'small_cap', matched: true };
  if (/\belss\b|tax saver|tax saving/.test(s)) return { key: 'elss', matched: true };
  if (/\bfocused\b/.test(s)) return { key: 'focused', matched: true };
  if (/\bcontra\b/.test(s)) return { key: 'contra', matched: true };
  if (/\bvalue\b/.test(s)) return { key: 'value', matched: true };
  if (/dynamic asset allocation|balanced advantage/.test(s)) return { key: 'balanced_advantage', matched: true };
  if (/aggressive hybrid/.test(s)) return { key: 'aggressive_hybrid', matched: true };
  if (/\bsectoral\b|\bthematic\b/.test(s)) return { key: null, matched: true }; // refined by the fund's name below
  return { key: null, matched: false };
}

/** Name hints for sectoral/thematic funds only. */
function sectoralKeyFromName(name: string): CategoryRefKey | null {
  if (/\binfra|\bpower\b/.test(name)) return 'infrastructure';
  if (/\bmnc\b/.test(name)) return 'mnc';
  return null;
}

/**
 * The fund's category. The scheme master's sub-category is authoritative whenever present; the section
 * header is next; the NAME is used only when the fund has neither (a statement-created instrument with no
 * scheme-master link), and, for a sectoral/thematic fund, to pick infrastructure or MNC.
 */
export function resolveFundCategory(input: FundCategoryInput): ResolvedFundCategory {
  const sub = (input.subCategory ?? '').trim();
  const header = (input.categoryHeaderRaw ?? '').trim();
  const name = nameForInference(input.instrumentName);

  const fromText = (text: string, source: FundCategorySource, display: string): ResolvedFundCategory | null => {
    const r = keyFromCategoryText(norm(text));
    if (!r.matched) return null;
    if (r.key) return { key: r.key, displayCategory: display, source };
    if (/\bsectoral\b|\bthematic\b/.test(norm(text))) {
      const byName = sectoralKeyFromName(name);
      return { key: byName, displayCategory: display, source: byName ? 'name_inference' : source };
    }
    return { key: null, displayCategory: display, source };
  };

  if (sub) {
    const r = fromText(sub, 'scheme_master', sub);
    return r ?? { key: null, displayCategory: sub, source: 'scheme_master' };
  }
  if (header) {
    // Header form "Open Ended Schemes(Equity Scheme - Large Cap Fund)": use the part after the last " - ".
    const inner = /\(([^)]*)\)\s*$/.exec(header)?.[1] ?? header;
    const display = inner.includes(' - ') ? inner.slice(inner.lastIndexOf(' - ') + 3).trim() : inner.trim();
    const r = fromText(display, 'category_header', display);
    if (r) return r;
  }
  if (name) {
    const r = fromText(name, 'name_inference', 'category inferred from the fund name');
    if (r) return r; // a recognised category (including "no reference", e.g. an index fund) is final
    const sectoral = sectoralKeyFromName(name);
    if (sectoral) return { key: sectoral, displayCategory: 'category inferred from the fund name', source: 'name_inference' };
  }
  return { key: null, displayCategory: null, source: 'none' };
}

// ---------------------------------------------------------------------------
// The reference itself
// ---------------------------------------------------------------------------

/** "Compared with the usual benchmark for Large Cap funds (not this fund's own declared benchmark)". */
export function categoryReferenceBasisLabel(categoryLabel: string): string {
  return `Compared with the usual benchmark for ${categoryLabel} funds (not this fund's own declared benchmark)`;
}

export const NO_CATEGORY_BENCHMARK_MESSAGE = 'Benchmark not available for this fund category';

export type CategoryReference =
  | {
      state: 'available';
      kind: typeof CATEGORY_REFERENCE_KIND;
      categoryKey: CategoryRefKey;
      categoryLabel: string;
      categorySource: FundCategorySource;
      benchmarkKey: string;
      benchmarkLabel: string;
      basisLabel: string;
      unsure: boolean;
    }
  | { state: 'none'; kind: typeof CATEGORY_REFERENCE_KIND; displayCategory: string | null; categorySource: FundCategorySource; message: string };

/** Pure: the category reference for one fund. The table is injectable only so tests can doctor it. */
export function categoryReferenceFor(input: FundCategoryInput, table: readonly CategoryReferenceRow[] = CATEGORY_REFERENCE_TABLE): CategoryReference {
  const cat = resolveFundCategory(input);
  const row = cat.key ? table.find((r) => r.key === cat.key) : undefined;
  if (!row) {
    return {
      state: 'none',
      kind: CATEGORY_REFERENCE_KIND,
      displayCategory: cat.displayCategory,
      categorySource: cat.source,
      message: cat.displayCategory && cat.source !== 'name_inference' ? `${NO_CATEGORY_BENCHMARK_MESSAGE} (${cat.displayCategory}).` : `${NO_CATEGORY_BENCHMARK_MESSAGE}.`,
    };
  }
  return {
    state: 'available',
    kind: CATEGORY_REFERENCE_KIND,
    categoryKey: row.key,
    categoryLabel: row.label,
    categorySource: cat.source,
    benchmarkKey: row.benchmarkKey,
    benchmarkLabel: row.benchmarkLabel,
    basisLabel: categoryReferenceBasisLabel(row.label),
    unsure: row.unsure,
  };
}

/** The benchmark keys the table needs from the catalogue (for one batched lookup). */
export function categoryReferenceBenchmarkKeys(table: readonly CategoryReferenceRow[] = CATEGORY_REFERENCE_TABLE): string[] {
  return [...new Set(table.map((r) => r.benchmarkKey))];
}
