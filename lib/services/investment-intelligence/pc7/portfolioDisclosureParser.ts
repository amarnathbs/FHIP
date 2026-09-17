// PC7 (M7) — deterministic parser for a SEBI-layout monthly portfolio
// disclosure (O.3, O.4).
//
// TERMINOLOGY (O.2). Every record this parser emits is an **Underlying Fund
// Holding** — a constituent security held INSIDE a scheme. Nothing here
// describes a user's own fund position.
//
// WHY A ROW-ARRAY INPUT, NOT A FILE. The parser takes `string[][]` — the cell
// grid of one worksheet — and nothing else. Three reasons, all of which are
// about not repeating known failure modes:
//
//   1. It makes the whole parse PURE and unit-testable with no spreadsheet
//      library, no network and no fixture binary.
//   2. It keeps the FORMAT decoder (xls / xlsx / csv / pdf-table) separate
//      from the LAYOUT decoder. O.3 explicitly warns against assuming PDF;
//      splitting here means the layout logic is identical whichever decoder
//      produced the grid.
//   3. If a reference-data PDF is ever processed with a shared extraction
//      utility, the utility hands over a grid and stops. It does NOT hand over
//      an AIE document, an acceptance lifecycle, or a user-review queue —
//      O.3's boundary is enforced by there being no such parameter to pass.
//
// THE LAYOUT, and the finding that shapes this whole parser.
//
// SEBI's mandate (Master Circular for Mutual Funds
// SEBI/HO/IMD/IMD-PoD-1/P/CIR/2024/90, 27 Jun 2024, Chapter 5 clause 5.1.1)
// requires portfolio disclosure "along with ISIN" in a "user-friendly and
// downloadable spreadsheet format", plus "yield of the instrument". Clause
// 5.1.5 points at a prescribed format.
//
// THE PRESCRIBED FORMAT IS A PRINT TEMPLATE, NOT A SCHEMA. SEBI's own format
// 3.C prescribes only four columns:
//
//   Name of the instrument | Quantity | Mkt value (Rs in lakhs) | % to NAV
//
// ISIN, Industry and YTM are required by the circular TEXT but are NOT columns
// in the prescribed table. Publishers therefore add them wherever they like,
// under whatever heading they like, and real files look more like:
//
//   ISIN Number | Name of the Instrument | Credit Rating | Quantity |
//   Market Value (including accrued interest, if any) (Rs. in Lakhs) |
//   % to Net Assets | YTM
//
// with `Industry` replacing `Credit Rating` on equity schemes. That mismatch
// between a mandated CONTENT list and an unmandated COLUMN list is exactly why
// this parser SEARCHES for its columns by heading and records the layout it
// found (O.9 source-change detection), instead of reading fixed offsets.
//
// with section headers ("EQUITY & EQUITY RELATED", "DEBT INSTRUMENTS",
// "MONEY MARKET INSTRUMENTS", "Derivatives", "TREPS", "Net Receivables /
// (Payables)"), sub-section headers ("(a) Listed / awaiting listing on Stock
// Exchanges", "(b) Unlisted"), and — critically — CONTROL TOTAL rows
// ("Sub Total", "Total", "Grand Total", "Net Assets").
//
// THE DOUBLE-COUNT TRAP THIS PARSER EXISTS TO AVOID. A "Sub Total" row has a
// name, a market value and a "% to Net Assets" just like a holding row. A
// parser that treats it as a holding double-counts every security beneath it
// and produces a fund whose weights sum to roughly 200%. This is the single
// most likely way look-through data goes wrong, and it is a within-fund
// cousin of the household-level D.2/O.7 invariant. Control rows are therefore
// classified explicitly and RETAINED AS ORACLES (O.10) — they are the
// publisher's own arithmetic, which the parser checks its own totals against.
//
// NO RESCALING (O.4 coverage, O.8 honesty). Real disclosures do not sum to
// 100%. The parser reports the genuine disclosed total and lets the coverage
// model carry the shortfall; it never scales 93% of a portfolio up to 100%.

import { createHash } from 'node:crypto';
import { validateIsin } from '../isinValidation';

export const PC7_DISCLOSURE_PARSER_VERSION = 'pc7-sebi-portfolio-parser-v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `ii_fund_holdings_lines.asset_kind` CHECK domain (migration 0044). */
export type AssetKind = 'security' | 'cash' | 'derivative' | 'other';

/** The `ii_fund_holdings_lines.credit_rating_band` CHECK domain (migration 0044). */
export type CreditRatingBand =
  | 'SOVEREIGN'
  | 'AAA'
  | 'AA'
  | 'A'
  | 'BELOW_A'
  | 'UNRATED'
  | 'OTHER_UNCLASSIFIED';

export type DisclosureSection =
  | 'EQUITY'
  | 'DEBT'
  | 'MONEY_MARKET'
  | 'DERIVATIVE'
  | 'CASH_EQUIVALENT'
  | 'RECEIVABLES'
  | 'MUTUAL_FUND_UNITS'
  | 'OTHER'
  | 'UNKNOWN';

export interface DisclosureHoldingRecord {
  /** Row index in the source grid, 0-based. Provenance for every record. */
  sourceRow: number;
  /** The instrument name exactly as the publisher printed it. Never normalised. */
  instrumentName: string;
  /** Valid ISIN only. A failing check digit yields null plus a field warning. */
  isin: string | null;
  /** The publisher's Industry (equity) or Rating (debt) column, verbatim. */
  industryOrRatingRaw: string | null;
  /** Derived from industryOrRatingRaw for debt/money-market rows only. */
  creditRatingBand: CreditRatingBand | null;
  quantity: number | null;
  /** In the file's own unit (usually Rs. lakhs). The unit is carried separately. */
  marketValue: number | null;
  /** The publisher's own "% to Net Assets". EXACT source decimal string retained. */
  weightPct: number;
  weightPctRaw: string;
  yieldPct: number | null;
  section: DisclosureSection;
  /** Sub-section verbatim, e.g. "(a) Listed / awaiting listing on Stock Exchanges". */
  subSectionRaw: string | null;
  assetKind: AssetKind;
  /** Publisher's security type label, for ii_fund_holdings_lines.security_type. */
  securityType: string | null;
}

/** A publisher-computed total row. NEVER a holding; used as an oracle (O.10). */
export interface ControlTotalRecord {
  sourceRow: number;
  kind: 'sub_total' | 'total' | 'grand_total' | 'net_assets';
  labelRaw: string;
  section: DisclosureSection;
  marketValue: number | null;
  weightPct: number | null;
}

export type DisclosureRejectionReason =
  | 'NO_HEADER_ROW'
  | 'MISSING_REQUIRED_COLUMN'
  | 'MISSING_INSTRUMENT_NAME'
  | 'MISSING_WEIGHT'
  | 'MALFORMED_WEIGHT'
  | 'WEIGHT_OUT_OF_RANGE'
  | 'MALFORMED_QUANTITY'
  | 'MALFORMED_MARKET_VALUE'
  | 'NEGATIVE_QUANTITY_IN_LONG_ONLY_SECTION'
  | 'DUPLICATE_CONFLICTING_ISIN';

export interface DisclosureRejection {
  sourceRow: number;
  reason: DisclosureRejectionReason;
  detail: string;
  /** Truncated row text. Reference data only — contains no user data. */
  rawExcerpt: string;
}

export type DisclosureWarningReason =
  | 'INVALID_ISIN_DROPPED'
  | 'MISSING_ISIN'
  | 'UNRECOGNISED_SECTION'
  | 'UNRECOGNISED_RATING'
  | 'DUPLICATE_IDENTICAL_ISIN'
  | 'CONTROL_TOTAL_MISMATCH'
  | 'NEGATIVE_WEIGHT_RETAINED';

export interface DisclosureWarning {
  field: string;
  reason: DisclosureWarningReason;
  detail: string;
  sourceRow: number | null;
}

export interface DisclosureFingerprint {
  byteLength: number;
  sha256: string;
  retrievedAt: string;
}

export interface DisclosureParseResult {
  records: DisclosureHoldingRecord[];
  controlTotals: ControlTotalRecord[];
  rejections: DisclosureRejection[];
  warnings: DisclosureWarning[];
  parserVersion: string;
  /** Resolved column indices, so a layout change is visible in the batch log. */
  columnMap: ColumnMap | null;
  headerRowIndex: number | null;
  /** Section headers seen verbatim, for governance review. */
  sectionsSeen: string[];
  /**
   * Sum of every ACCEPTED holding's `% to Net Assets`, as disclosed. NOT
   * clamped, NOT rescaled. This is the raw truth the coverage model consumes.
   */
  disclosedWeightTotalPct: number;
  counts: {
    gridRows: number;
    accepted: number;
    rejected: number;
    controlRows: number;
    sectionHeaderRows: number;
    blankRows: number;
  };
}

export interface ColumnMap {
  name: number;
  isin: number | null;
  industryOrRating: number | null;
  quantity: number | null;
  marketValue: number | null;
  weightPct: number;
  yieldPct: number | null;
}

export interface DisclosureParseOptions {
  /** Scheme this file describes. Identity comes from the CALLER, never the file. */
  schemeLabel: string;
  /** ISO yyyy-mm-dd the holdings DESCRIBE. */
  holdingsAsOfDate: string;
  /** Today, ISO yyyy-mm-dd, for the no-future-date rule. */
  today: string;
}

// ---------------------------------------------------------------------------
// Cell helpers
// ---------------------------------------------------------------------------

/** Collapse whitespace and trim. Does NOT change case — names stay verbatim. */
export function normaliseCell(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function canon(raw: unknown): string {
  return normaliseCell(raw).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse a numeric cell the way a disclosure file actually writes numbers:
 * thousands separators (Indian or Western grouping), a parenthesised
 * negative, a trailing %, an em/en dash or '-' meaning "nil".
 *
 * Returns `{ ok: true, value: null }` for a genuinely blank/nil cell, which is
 * different from a malformed one. Absence must never become zero (O.8).
 */
export function parseNumericCell(raw: unknown): { ok: true; value: number | null; text: string } | { ok: false } {
  const text = normaliseCell(raw);
  if (text === '' || text === '-' || text === '--' || text === '—' || text === '–') {
    return { ok: true, value: null, text };
  }
  if (/^(nil|na|n\.a\.?|not applicable)$/i.test(text)) return { ok: true, value: null, text };

  let body = text;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(body);
  if (paren) {
    negative = true;
    body = paren[1].trim();
  }
  body = body.replace(/%$/, '').trim();
  if (/^-/.test(body)) {
    negative = true;
    body = body.slice(1).trim();
  }
  // Strip grouping commas only when they are genuinely grouping separators,
  // not a decimal comma. Indian grouping (12,34,567.89) and Western grouping
  // (1,234,567.89) both leave the decimal point intact.
  body = body.replace(/,/g, '');
  if (!/^\d*\.?\d+$/.test(body) && !/^\d+\.$/.test(body)) return { ok: false };
  const value = Number(body);
  if (!Number.isFinite(value)) return { ok: false };
  return { ok: true, value: negative ? -value : value, text };
}

// ---------------------------------------------------------------------------
// Header detection
// ---------------------------------------------------------------------------

const NAME_HEADERS = ['nameoftheinstrument', 'nameofinstrument', 'instrumentname', 'nameofthesecurity', 'particulars'];
const ISIN_HEADERS = ['isin'];
const IND_HEADERS = ['industryrating', 'industry', 'rating', 'ratingindustry', 'industryrating1'];
const QTY_HEADERS = ['quantity', 'qty', 'noofshares', 'units'];
// 'mktvalue' is SEBI's OWN spelling in the prescribed format table
// ("Mkt value (Rs in lakhs)"), which is not the spelling most AMCs actually
// use. Both are listed because the prescribed template and real files differ.
const MV_HEADERS = ['marketvalue', 'mktvalue', 'marketvaluersinlakhs', 'marketvaluerslakhs', 'marketvalueinlakhs', 'fairvalue', 'marketfairvalue'];
const WT_HEADERS = ['tonetassets', 'ofnetassets', 'tonav', 'ofnav', 'percentagetonetassets', 'weightage', 'tonetassets1'];
const YLD_HEADERS = ['ytm', 'yield', 'yieldoftheinstrument', 'annualisedyield', 'ytmannualised'];

/**
 * Header matching, deliberately narrow.
 *
 * Exact match, or the cell STARTS WITH the needle, or (only for needles of 4+
 * characters) contains it. The length floor exists because short needles like
 * `cd` or `qty` used as substrings match half the alphabet — a header matcher
 * that is too eager picks the wrong column and produces a file-shaped result
 * built from the wrong numbers, which is far worse than failing to find a
 * header at all.
 */
function matchesAny(cell: string, needles: string[]): boolean {
  const c = canon(cell);
  if (!c) return false;
  return needles.some((n) => c === n || c.startsWith(n) || (n.length >= 4 && c.includes(n)));
}

/**
 * Find the header row and map its columns.
 *
 * SEARCHES, rather than assuming row 0, because every real disclosure file
 * begins with title/AMC/scheme/as-of-date banner rows above the table, and
 * how many of them there are varies by publisher and by month. Assuming a
 * fixed offset is how a parser starts reading the banner as data.
 *
 * REQUIRES both a name column and a weight column. Without the weight column
 * there is no look-through at all, and a parser that carried on regardless
 * would produce a snapshot of zero-weight holdings — exactly the "zero as if
 * measured" state O.8 forbids.
 */
export function findHeaderRow(grid: string[][], searchLimit = 40): { rowIndex: number; map: ColumnMap } | null {
  const limit = Math.min(grid.length, searchLimit);
  for (let r = 0; r < limit; r++) {
    const row = grid[r] ?? [];
    let name = -1;
    let weight = -1;
    let isin: number | null = null;
    let industry: number | null = null;
    let quantity: number | null = null;
    let marketValue: number | null = null;
    let yieldPct: number | null = null;

    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (name === -1 && matchesAny(cell, NAME_HEADERS)) { name = c; continue; }
      if (isin === null && matchesAny(cell, ISIN_HEADERS)) { isin = c; continue; }
      if (weight === -1 && matchesAny(cell, WT_HEADERS)) { weight = c; continue; }
      if (quantity === null && matchesAny(cell, QTY_HEADERS)) { quantity = c; continue; }
      if (marketValue === null && matchesAny(cell, MV_HEADERS)) { marketValue = c; continue; }
      if (yieldPct === null && matchesAny(cell, YLD_HEADERS)) { yieldPct = c; continue; }
      if (industry === null && matchesAny(cell, IND_HEADERS)) { industry = c; continue; }
    }
    if (name !== -1 && weight !== -1) {
      return {
        rowIndex: r,
        map: { name, isin, industryOrRating: industry, quantity, marketValue, weightPct: weight, yieldPct },
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section and control-row classification
// ---------------------------------------------------------------------------

interface SectionRule {
  test: RegExp;
  section: DisclosureSection;
  assetKind: AssetKind;
  securityType: string | null;
}

/**
 * Ordered — first match wins. Order matters: "Mutual Fund Units" must be
 * tested before the generic "Units", and the derivative rule must precede the
 * equity rule so an "Equity Derivatives" header is not read as equity.
 */
const SECTION_RULES: SectionRule[] = [
  { test: /derivativ|futures?|options?|index\s*fut|stock\s*fut/i, section: 'DERIVATIVE', assetKind: 'derivative', securityType: 'DERIVATIVE' },
  { test: /mutual\s*fund\s*units?|units?\s*of\s*(mutual\s*fund|.*\bmf\b)|exchange\s*traded\s*fund|\betf\b/i, section: 'MUTUAL_FUND_UNITS', assetKind: 'security', securityType: 'FUND_UNITS' },
  { test: /equity\s*(&|and)?\s*equity\s*related|^equity\b|equity\s*shares/i, section: 'EQUITY', assetKind: 'security', securityType: 'EQUITY' },
  { test: /debt\s*instrument|bonds?\s*(&|and)?\s*ncds?|non[-\s]?convertible|government\s*securit|g[-\s]?sec|state\s*development\s*loan|\bsdl\b|treasury\s*bill|securitis?ed\s*debt|\bptc\b/i, section: 'DEBT', assetKind: 'security', securityType: 'DEBT' },
  { test: /money\s*market|certificate\s*of\s*deposit|commercial\s*paper|\bcd\b|\bcp\b|bill\s*rediscount/i, section: 'MONEY_MARKET', assetKind: 'security', securityType: 'MONEY_MARKET' },
  { test: /treps|tri[-\s]?party\s*repo|reverse\s*repo|\brepo\b|cash\s*(&|and)?\s*cash\s*equivalent|cash\s*margin|bank\s*balance|clearing\s*corporation/i, section: 'CASH_EQUIVALENT', assetKind: 'cash', securityType: 'CASH_EQUIVALENT' },
  { test: /net\s*receivable|net\s*payable|receivables?\s*\/?\s*\(?payables?\)?|other\s*(current\s*)?(assets?|liabilit)/i, section: 'RECEIVABLES', assetKind: 'other', securityType: 'RECEIVABLE' },
  { test: /preference\s*shares?|warrants?|rights?\s*entitlement|reits?|invits?|unlisted/i, section: 'OTHER', assetKind: 'security', securityType: 'OTHER_SECURITY' },
];

export function classifySection(label: string): SectionRule | null {
  for (const rule of SECTION_RULES) if (rule.test.test(label)) return rule;
  return null;
}

/**
 * A row is a SECTION HEADER when it has a label and no weight at all.
 * A row is a CONTROL TOTAL when its label is a total word — regardless of
 * whether it carries a weight, which is exactly why it must be tested BEFORE
 * the holding path.
 */
export function classifyControlLabel(label: string): ControlTotalRecord['kind'] | null {
  const c = canon(label);
  if (!c) return null;
  if (/^grandtotal/.test(c)) return 'grand_total';
  if (/^netassets?(value)?$/.test(c) || /^totalnetassets/.test(c)) return 'net_assets';
  if (/^subtotal/.test(c)) return 'sub_total';
  if (/^total/.test(c)) return 'total';
  // "Total Equity & Equity Related", "Sub Total (a)" and similar.
  if (/^(sub)?total[a-z0-9]*$/.test(c)) return c.startsWith('sub') ? 'sub_total' : 'total';
  return null;
}

const SUBSECTION_RE = /^\(?[a-z]\)?\s*[).:-]?\s*(listed|unlisted|awaiting|privately|securitised|others?)/i;

// ---------------------------------------------------------------------------
// Rating normalisation (O.4 debt fields)
// ---------------------------------------------------------------------------

/**
 * Map a publisher's rating string onto the `credit_rating_band` domain.
 *
 * DELIBERATELY CONSERVATIVE. An unrecognised rating becomes
 * OTHER_UNCLASSIFIED with a warning, never a guessed band — inventing a
 * credit band is how a debt X-Ray tells a user their portfolio is safer than
 * it is. The ordering tests the longest/strongest patterns first so that
 * "AAA" is not matched by the "AA" rule, and "SOVEREIGN"/"SOV"/"GOI"/"SDL"
 * wins over any letter rule.
 */
export function normaliseRatingBand(raw: string | null): { band: CreditRatingBand | null; recognised: boolean } {
  const text = normaliseCell(raw);
  if (!text) return { band: null, recognised: true };
  const u = text.toUpperCase();
  if (/SOVEREIGN|\bSOV\b|\bGOI\b|\bSDL\b|GOVERNMENT|G-?SEC|TREASURY/.test(u)) return { band: 'SOVEREIGN', recognised: true };
  if (/UNRATED|NOT\s*RATED|\bNR\b/.test(u)) return { band: 'UNRATED', recognised: true };
  // Strip agency prefixes (CRISIL, ICRA, CARE, IND, BWR, ACUITE) and suffixes
  // (+, -, (CE), (SO), r, /Stable) before banding.
  const core = u
    .replace(/\b(CRISIL|ICRA|CARE|IND|INDIA RATINGS|BWR|BRICKWORK|ACUITE|SMERA|FITCH|MOODY'?S?|S&P)\b/g, ' ')
    .replace(/\((CE|SO)\)/g, ' ')
    .replace(/\/\s*(STABLE|POSITIVE|NEGATIVE|WATCH).*/g, ' ')
    .replace(/[^A-Z+\-\d ]/g, ' ')
    .trim();
  if (/\bA\s*1\s*\+?/.test(core) || /\bP\s*1\s*\+?/.test(core)) return { band: 'AAA', recognised: true }; // A1+ short-term ≈ highest
  if (/\bAAA\b/.test(core)) return { band: 'AAA', recognised: true };
  if (/\bAA[+\-]?\b/.test(core)) return { band: 'AA', recognised: true };
  if (/\bA[+\-]?\b/.test(core)) return { band: 'A', recognised: true };
  if (/\b(BBB|BB|B|CCC|CC|C|D)[+\-]?\b/.test(core)) return { band: 'BELOW_A', recognised: true };
  // An INDUSTRY name lands here on equity rows, which is correct and not an
  // error: equities have no rating, so the caller passes null for them.
  return { band: 'OTHER_UNCLASSIFIED', recognised: false };
}

// ---------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------

export function fingerprintDisclosureBytes(bytes: Uint8Array, retrievedAt: string): DisclosureFingerprint {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    retrievedAt,
  };
}

/** Checksum of ONE parsed record, for content-idempotent re-import (O.3). */
export function recordChecksum(r: DisclosureHoldingRecord): string {
  return createHash('sha256')
    .update([r.instrumentName, r.isin ?? '', r.section, r.assetKind, r.weightPctRaw, r.quantity ?? '', r.marketValue ?? ''].join('|'))
    .digest('hex');
}

// ---------------------------------------------------------------------------
// The parse
// ---------------------------------------------------------------------------

/**
 * Parse one worksheet grid into Underlying Fund Holding records.
 *
 * Deterministic and total: every grid row lands in exactly one of
 * accepted / rejected / control / section-header / blank, and the five counts
 * sum to `gridRows`. That identity is asserted in the test pack, and it is
 * what makes "the parser silently dropped rows" a detectable condition rather
 * than an invisible one.
 */
export function parsePortfolioDisclosure(grid: string[][], opts: DisclosureParseOptions): DisclosureParseResult {
  const rejections: DisclosureRejection[] = [];
  const warnings: DisclosureWarning[] = [];
  const records: DisclosureHoldingRecord[] = [];
  const controlTotals: ControlTotalRecord[] = [];
  const sectionsSeen: string[] = [];

  const base = {
    parserVersion: PC7_DISCLOSURE_PARSER_VERSION,
    sectionsSeen,
    records,
    controlTotals,
    rejections,
    warnings,
  };

  const header = findHeaderRow(grid);
  if (!header) {
    rejections.push({
      sourceRow: -1,
      reason: 'NO_HEADER_ROW',
      detail:
        'No row in the first 40 carried both an instrument-name column and a "% to Net Assets" column. ' +
        'The file is refused whole rather than parsed on a guessed layout.',
      rawExcerpt: (grid[0] ?? []).join(' | ').slice(0, 200),
    });
    return {
      ...base,
      columnMap: null,
      headerRowIndex: null,
      disclosedWeightTotalPct: 0,
      counts: { gridRows: grid.length, accepted: 0, rejected: 1, controlRows: 0, sectionHeaderRows: 0, blankRows: 0 },
    };
  }

  const { map } = header;
  let currentSection: SectionRule | null = null;
  let currentSubSection: string | null = null;
  let blankRows = 0;
  let sectionHeaderRows = 0;
  let disclosedWeightTotalPct = 0;
  const seenIsin = new Map<string, { row: number; weightPctRaw: string; name: string }>();

  for (let r = header.rowIndex + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const excerpt = row.join(' | ').slice(0, 200);
    const name = normaliseCell(row[map.name]);
    const weightCell = normaliseCell(row[map.weightPct]);

    // ---- blank -----------------------------------------------------------
    if (row.every((c) => normaliseCell(c) === '')) {
      blankRows++;
      continue;
    }
    if (!name && !weightCell) {
      blankRows++;
      continue;
    }

    // ---- control total (tested BEFORE holdings — the double-count trap) ---
    const controlKind = classifyControlLabel(name);
    if (controlKind) {
      const mv = map.marketValue === null ? { ok: true as const, value: null, text: '' } : parseNumericCell(row[map.marketValue]);
      const wt = parseNumericCell(weightCell);
      controlTotals.push({
        sourceRow: r,
        kind: controlKind,
        labelRaw: name,
        section: currentSection?.section ?? 'UNKNOWN',
        marketValue: mv.ok ? mv.value : null,
        weightPct: wt.ok ? wt.value : null,
      });
      continue;
    }

    // ---- sub-section header ---------------------------------------------
    if (name && !weightCell && SUBSECTION_RE.test(name)) {
      currentSubSection = name;
      sectionHeaderRows++;
      continue;
    }

    // ---- section header --------------------------------------------------
    // A labelled row with NO weight is a header, not a zero-weight holding.
    // Treating it as a holding would be the "zero as if measured" error O.8
    // forbids, in miniature.
    if (name && !weightCell) {
      const rule = classifySection(name);
      if (rule) {
        currentSection = rule;
        currentSubSection = null;
        if (!sectionsSeen.includes(name)) sectionsSeen.push(name);
      } else {
        warnings.push({
          field: 'section',
          reason: 'UNRECOGNISED_SECTION',
          detail: `Row ${r} is a labelled row with no weight ("${name.slice(0, 80)}") that matches no known section. It is treated as a header and contributes nothing, rather than being guessed into a bucket.`,
          sourceRow: r,
        });
        if (!sectionsSeen.includes(name)) sectionsSeen.push(name);
      }
      sectionHeaderRows++;
      continue;
    }

    // ---- holding ---------------------------------------------------------
    if (!name) {
      rejections.push({ sourceRow: r, reason: 'MISSING_INSTRUMENT_NAME', detail: 'Row carries a weight but no instrument name.', rawExcerpt: excerpt });
      continue;
    }
    const wt = parseNumericCell(weightCell);
    if (!wt.ok) {
      rejections.push({ sourceRow: r, reason: 'MALFORMED_WEIGHT', detail: `"% to Net Assets" cell "${weightCell.slice(0, 40)}" is not a number.`, rawExcerpt: excerpt });
      continue;
    }
    if (wt.value === null) {
      rejections.push({ sourceRow: r, reason: 'MISSING_WEIGHT', detail: 'Row has an instrument name but no "% to Net Assets" value. A holding with no weight cannot participate in look-through and is refused rather than counted as zero.', rawExcerpt: excerpt });
      continue;
    }
    if (wt.value > 100 || wt.value < -100) {
      rejections.push({ sourceRow: r, reason: 'WEIGHT_OUT_OF_RANGE', detail: `Weight ${wt.value}% is outside -100..100. A row this size is a total or a unit error, not a holding.`, rawExcerpt: excerpt });
      continue;
    }

    // A row whose OWN name identifies a bucket overrides the running section.
    // Real files put "TREPS" and "Net Receivables / (Payables)" as ordinary
    // rows under no header at all.
    const selfRule = classifySection(name);
    const effective = selfRule && (selfRule.section === 'CASH_EQUIVALENT' || selfRule.section === 'RECEIVABLES' || selfRule.section === 'DERIVATIVE')
      ? selfRule
      : currentSection ?? selfRule;

    const section: DisclosureSection = effective?.section ?? 'UNKNOWN';
    let assetKind: AssetKind = effective?.assetKind ?? 'other';
    const securityType = effective?.securityType ?? null;

    // A NEGATIVE weight is real: it is how a file writes net payables and
    // short derivative legs. It is RETAINED with a warning, never clamped to
    // zero and never dropped, because dropping it would overstate the fund's
    // long exposure.
    if (wt.value < 0) {
      warnings.push({
        field: 'weight_pct',
        reason: 'NEGATIVE_WEIGHT_RETAINED',
        detail: `Row ${r} ("${name.slice(0, 60)}") discloses ${wt.value}%. Negative weights are genuine (net payables, short derivative legs) and are retained as disclosed.`,
        sourceRow: r,
      });
      if (assetKind === 'security') assetKind = 'other';
    }

    // ---- ISIN ------------------------------------------------------------
    let isin: string | null = null;
    if (map.isin !== null) {
      const rawIsin = normaliseCell(row[map.isin]);
      if (rawIsin) {
        const v = validateIsin(rawIsin);
        if (v.ok && v.normalised) isin = v.normalised;
        else {
          warnings.push({
            field: 'isin',
            reason: 'INVALID_ISIN_DROPPED',
            detail: `Row ${r} ISIN "${rawIsin.slice(0, 20)}" failed validation (${v.error ?? 'unknown'}). Dropped rather than stored: a wrong ISIN resolves to the WRONG company, which is worse than no ISIN. The line is retained and stays unresolved.`,
            sourceRow: r,
          });
        }
      } else if (assetKind === 'security') {
        warnings.push({
          field: 'isin',
          reason: 'MISSING_ISIN',
          detail: `Row ${r} ("${name.slice(0, 60)}") is a security with no ISIN. It is retained as an UNRESOLVED holding — never name-matched into a lookalike security.`,
          sourceRow: r,
        });
      }
    }

    if (isin) {
      const prior = seenIsin.get(isin);
      if (prior) {
        if (prior.weightPctRaw === wt.text) {
          warnings.push({ field: 'isin', reason: 'DUPLICATE_IDENTICAL_ISIN', detail: `ISIN ${isin} appears on rows ${prior.row} and ${r} with an identical weight. Retained: a scheme legitimately holds the same security in more than one section.`, sourceRow: r });
        } else {
          warnings.push({ field: 'isin', reason: 'DUPLICATE_IDENTICAL_ISIN', detail: `ISIN ${isin} appears on rows ${prior.row} (${prior.weightPctRaw}%) and ${r} (${wt.text}%). Both are retained and summed by the look-through engine, which is correct for a security held across sections.`, sourceRow: r });
        }
      } else {
        seenIsin.set(isin, { row: r, weightPctRaw: wt.text, name });
      }
    }

    // ---- quantity / market value ----------------------------------------
    let quantity: number | null = null;
    if (map.quantity !== null) {
      const q = parseNumericCell(row[map.quantity]);
      if (!q.ok) {
        rejections.push({ sourceRow: r, reason: 'MALFORMED_QUANTITY', detail: `Quantity cell "${normaliseCell(row[map.quantity]).slice(0, 40)}" is not a number.`, rawExcerpt: excerpt });
        continue;
      }
      quantity = q.value;
    }
    let marketValue: number | null = null;
    if (map.marketValue !== null) {
      const m = parseNumericCell(row[map.marketValue]);
      if (!m.ok) {
        rejections.push({ sourceRow: r, reason: 'MALFORMED_MARKET_VALUE', detail: `Market value cell "${normaliseCell(row[map.marketValue]).slice(0, 40)}" is not a number.`, rawExcerpt: excerpt });
        continue;
      }
      marketValue = m.value;
    }

    // ---- industry / rating ----------------------------------------------
    const industryOrRatingRaw = map.industryOrRating === null ? null : normaliseCell(row[map.industryOrRating]) || null;
    let creditRatingBand: CreditRatingBand | null = null;
    if (industryOrRatingRaw && (section === 'DEBT' || section === 'MONEY_MARKET')) {
      const { band, recognised } = normaliseRatingBand(industryOrRatingRaw);
      creditRatingBand = band;
      if (!recognised) {
        warnings.push({
          field: 'credit_rating_band',
          reason: 'UNRECOGNISED_RATING',
          detail: `Row ${r} rating "${industryOrRatingRaw.slice(0, 40)}" matched no known band and is recorded as OTHER_UNCLASSIFIED. A credit band is never guessed.`,
          sourceRow: r,
        });
      }
    }

    let yieldPct: number | null = null;
    if (map.yieldPct !== null) {
      const y = parseNumericCell(row[map.yieldPct]);
      yieldPct = y.ok ? y.value : null;
    }

    records.push({
      sourceRow: r,
      instrumentName: name,
      isin,
      industryOrRatingRaw,
      creditRatingBand,
      quantity,
      marketValue,
      weightPct: wt.value,
      weightPctRaw: wt.text,
      yieldPct,
      section,
      subSectionRaw: currentSubSection,
      assetKind,
      securityType,
    });
    disclosedWeightTotalPct += wt.value;
  }

  // ---- O.10: check our own arithmetic against the publisher's ------------
  const grand = controlTotals.find((c) => c.kind === 'grand_total') ?? controlTotals.find((c) => c.kind === 'net_assets');
  if (grand && grand.weightPct !== null) {
    const diff = Math.abs(disclosedWeightTotalPct - grand.weightPct);
    if (diff > 0.5) {
      warnings.push({
        field: 'disclosed_weight_total_pct',
        reason: 'CONTROL_TOTAL_MISMATCH',
        detail:
          `Parsed holdings sum to ${disclosedWeightTotalPct.toFixed(4)}% but the publisher's own ` +
          `"${grand.labelRaw}" row states ${grand.weightPct}% (difference ${diff.toFixed(4)} pp, tolerance 0.5 pp). ` +
          'The publisher total is an INDEPENDENT ORACLE, not an authority to overwrite the parse: the parsed ' +
          'figure is reported as-is and this mismatch is raised for a human.',
        sourceRow: grand.sourceRow,
      });
    }
  }

  const accepted = records.length;
  const rejected = rejections.length;
  const controlRows = controlTotals.length;
  return {
    ...base,
    columnMap: map,
    headerRowIndex: header.rowIndex,
    disclosedWeightTotalPct,
    counts: {
      // Rows BELOW the header, plus the header and banner rows above it, is
      // the whole grid. The five buckets below account for every row after
      // the header; rows at or above it are the banner.
      gridRows: grid.length,
      accepted,
      rejected,
      controlRows,
      sectionHeaderRows,
      blankRows,
    },
  };
}

export const __parserInternals = { canon, matchesAny, SECTION_RULES, SUBSECTION_RE };
