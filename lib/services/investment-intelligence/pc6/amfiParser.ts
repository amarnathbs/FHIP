// PC6 (M6) — deterministic parsers for AMFI's two public NAV files.
//
// N.4: "Parse deterministically. Reject malformed records."
// N.3: "Do not silently collapse economically distinct plans/options."
// N.5: "decimal precision; no future dates; non-negative/valid values".
//
// WRITTEN AGAINST THE REAL FILES, NOT AGAINST AN ASSUMED SHAPE. Both formats
// below were downloaded and analysed on 2026-09-15:
//
//   NAVAll.txt            1,519,199 B  18,062 lines  14,361 data rows
//                         sha256 b1a8be20149399454ec9a12f620af499657e9fde3c3b12cd85e755414f062cab
//   NAV history (3 days)  3,486,515 B  28,709 lines  26,152 data rows
//
// The two files have DIFFERENT column orders and are therefore parsed by two
// different functions. They are not unified behind one "flexible" parser,
// because a flexible parser is exactly how a column-order change becomes a
// silent data corruption instead of a loud failure.
//
//   NAVAll.txt   Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;
//                Scheme Name;Plan;Option;Net Asset Value;Date
//   NAV history  Scheme Code;NAV Name;Plan;Option;ISIN Div Payout/ISIN Growth;
//                ISIN Div Reinvestment;Net Asset Value;Date
//
// NEITHER PARSER EVER TOUCHES A USER STATEMENT (D.7). These are external
// reference facts. What a CAMS/KFintech statement printed stays exactly as
// printed; a PC6 NAV is a separate dated observation that sits beside it.

import { createHash } from 'node:crypto';
import { validateIsin } from '../isinValidation';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const AMFI_PARSER_VERSION = 'pc6-amfi-parser-v1';

export type SchemeStructure = 'open_ended' | 'close_ended' | 'interval';

/** The existing ii_instruments.plan_type CHECK domain (migration 0041). */
export type PlanType = 'direct' | 'regular' | 'not_applicable';

/** The existing ii_instruments.option_type CHECK domain (migration 0041). */
export type OptionType = 'growth' | 'idcw' | 'dividend_payout' | 'dividend_reinvestment' | 'not_applicable';

export interface AmfiSchemeNavRecord {
  /** AMFI scheme code — the country-scoped canonical identifier. */
  amfiSchemeCode: string;
  schemeName: string;
  /**
   * Null where AMFI itself omitted the AMC sub-header. This is a REAL
   * condition in the live file (23 rows on 2026-09-15, all Franklin India
   * segregated-portfolio schemes under "Debt Scheme - Medium Duration Fund",
   * where the category header is followed straight by data rows). AMC is a
   * descriptive attribute, not the identity key — the AMFI scheme code is —
   * so a missing AMC label degrades the record, it does not void the price.
   */
  amcName: string | null;
  schemeStructure: SchemeStructure;
  /** The section header verbatim, e.g. "Open Ended Schemes(Equity Scheme - Large Cap Fund)". */
  categoryHeaderRaw: string;
  /** Left of the dash inside the parentheses, e.g. "Equity Scheme". Null when the header has no dash. */
  categoryGroup: string | null;
  /** Right of the dash, e.g. "Large Cap Fund". Falls back to the whole parenthetical. */
  subCategory: string;
  /** AMFI's Plan column verbatim — empty string when AMFI left it blank. */
  planRaw: string;
  planType: PlanType | null;
  /** AMFI's Option column verbatim. 350 distinct values exist; NEVER discarded. */
  optionRaw: string;
  optionType: OptionType | null;
  isinGrowthOrPayout: string | null;
  isinReinvestment: string | null;
  /** NAV as the exact source string. Never float-rounded on the way to the DB. */
  navRaw: string;
  /** Convenience numeric. Use navRaw for persistence. */
  nav: number;
  /** ISO yyyy-mm-dd. */
  navDate: string;
  /** 1-based line number in the source file, for rejection traceability. */
  sourceLine: number;
  /** Per-record content hash — the unit of idempotency (N.4/N.5). */
  recordChecksum: string;
  /** Field-level problems that did NOT invalidate the record. */
  fieldWarnings: FieldWarning[];
}

export type RejectionReason =
  | 'ORPHAN_ROW_NO_SECTION'
  | 'FIELD_COUNT'
  | 'INVALID_SCHEME_CODE'
  | 'EMPTY_SCHEME_NAME'
  | 'MALFORMED_NAV'
  | 'NEGATIVE_NAV'
  | 'NAV_PRECISION_EXCEEDED'
  | 'INVALID_DATE'
  | 'FUTURE_DATE'
  | 'DUPLICATE_CONFLICTING';

export interface Rejection {
  sourceLine: number;
  reason: RejectionReason;
  detail: string;
  /** The offending line, truncated. Reference data only — contains no user data. */
  rawExcerpt: string;
}

export type FieldWarningReason =
  | 'INVALID_ISIN_DROPPED'
  | 'UNMAPPED_OPTION'
  | 'UNMAPPED_PLAN'
  | 'AMC_HEADER_MISSING'
  | 'DUPLICATE_IDENTICAL';

export interface FieldWarning {
  field: string;
  reason: FieldWarningReason;
  detail: string;
}

export interface SourceFingerprint {
  byteLength: number;
  sha256: string;
  /** When this process retrieved the bytes. */
  retrievedAt: string;
}

export interface AmfiParseResult {
  records: AmfiSchemeNavRecord[];
  rejections: Rejection[];
  fingerprint: SourceFingerprint;
  parserVersion: string;
  /** Distinct category headers seen, for scheme-master governance review. */
  sectionHeaders: string[];
  /** Distinct AMCs seen. */
  amcNames: string[];
  /** Earliest and latest NAV date across accepted records. */
  navDateMin: string | null;
  navDateMax: string | null;
  counts: {
    totalLines: number;
    dataLines: number;
    accepted: number;
    rejected: number;
    duplicatesIdentical: number;
  };
}

export interface ParseOptions {
  /**
   * The ingestion as-of date, ISO yyyy-mm-dd. Any NAV dated after this is
   * rejected as FUTURE_DATE (N.5 "no future dates"). Required — there is no
   * default, because defaulting it to the machine clock is how a clock-skewed
   * box silently admits tomorrow's NAV.
   */
  asOfDate: string;
  retrievedAt?: string;
  /**
   * Max decimal places accepted for NAV.
   *
   * DEFAULT 10, NOT 6 — this is a real finding. `ii_prices_nav.price` was
   * created by migration 0033 as `numeric(20, 6)`, but AMFI publishes NAVs
   * with up to EIGHT decimal places: on 2026-09-15, 443 of 14,361 rows in
   * NAVAll.txt carried 7 or 8 dp (54 at 7 dp, 389 at 8 dp). At a cap of 6 the
   * importer would either reject 3.1% of the real universe or round it
   * silently. Migration 0155 widens the column to numeric(24, 10); this
   * default matches that scale.
   */
  maxNavDecimals?: number;
}

// ---------------------------------------------------------------------------
// Deterministic field helpers
// ---------------------------------------------------------------------------

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** AMFI prints `dd-MMM-yyyy`. Parsed by explicit table, never by Date.parse. */
export function parseAmfiDate(raw: string): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const mm = MONTHS[m[2].toLowerCase()];
  if (!mm) return null;
  const dd = m[1].padStart(2, '0');
  const iso = `${m[3]}-${mm}-${dd}`;
  // Reject impossible calendar dates (31-Feb etc.) by round-tripping.
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Strictly well-formed non-negative decimal. Deliberately rejects AMFI's real
 * `10.` (trailing-dot) value, which JavaScript's Number() would happily accept
 * as 10 — a lenient parse here is an invented fact.
 */
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

export function parseStrictDecimal(raw: string, maxDecimals: number): { ok: true; value: number; text: string } | { ok: false; reason: 'MALFORMED_NAV' | 'NAV_PRECISION_EXCEEDED' } {
  const t = raw.trim();
  const m = DECIMAL_RE.exec(t);
  if (!m) return { ok: false, reason: 'MALFORMED_NAV' };
  if ((m[2]?.length ?? 0) > maxDecimals) return { ok: false, reason: 'NAV_PRECISION_EXCEEDED' };
  return { ok: true, value: Number(t), text: t };
}

/**
 * AMFI's Plan column holds exactly three values in the real file:
 * 'Direct Plan', 'Regular Plan', and '' (older rows). An empty plan is
 * genuinely unknown, so it maps to null — NOT to 'not_applicable', which
 * would assert something AMFI never said.
 */
export function normalisePlan(raw: string): { planType: PlanType | null; warning?: FieldWarning } {
  const t = raw.trim().toLowerCase();
  if (t === '') return { planType: null };
  if (t.includes('direct')) return { planType: 'direct' };
  if (t.includes('regular')) return { planType: 'regular' };
  return {
    planType: null,
    warning: { field: 'plan', reason: 'UNMAPPED_PLAN', detail: `Unrecognised plan value '${raw.trim()}' — left unmapped rather than guessed.` },
  };
}

/**
 * AMFI's Option column carries 350 distinct spellings in the real file
 * (payout/reinvestment, monthly/quarterly/annual/periodic IDCW, legacy
 * "Dividend" wording, AMC-specific phrasings). N.3 forbids collapsing
 * economically distinct options.
 *
 * The contract here is therefore: the RAW string is always preserved on the
 * record and persisted verbatim into the scheme master; `optionType` is only
 * a COARSE filter dimension over the existing 0041 CHECK domain. Two schemes
 * that share an optionType are NOT thereby merged — each AMFI scheme code
 * remains its own row with its own NAV series.
 *
 * Ordering matters: reinvestment is tested before payout, and payout before
 * the generic IDCW bucket, so "Monthly IDCW Re-investment" cannot fall into
 * `dividend_payout`.
 */
export function normaliseOption(raw: string): { optionType: OptionType | null; warning?: FieldWarning } {
  const t = raw.trim().toLowerCase();
  if (t === '') return { optionType: null };
  if (/re-?invest/.test(t)) return { optionType: 'dividend_reinvestment' };
  if (/pay\s*-?out|payout/.test(t)) return { optionType: 'dividend_payout' };
  if (/growth|cumulative/.test(t)) return { optionType: 'growth' };
  if (/idcw|dividend|dcw/.test(t)) return { optionType: 'idcw' };
  if (/bonus/.test(t)) return { optionType: 'not_applicable' };
  return {
    optionType: null,
    warning: { field: 'option', reason: 'UNMAPPED_OPTION', detail: `Unrecognised option value '${raw.trim()}' — left unmapped rather than guessed. The raw value is preserved.` },
  };
}

const SECTION_RE = /^(Open Ended|Close Ended|Interval Fund)\s+Schemes?\s*\((.*)\)\s*$/i;

export interface SectionHeader {
  raw: string;
  structure: SchemeStructure;
  categoryGroup: string | null;
  subCategory: string;
}

/**
 * Parse a section header such as
 *   "Open Ended Schemes(Equity Scheme - Large Cap Fund)"
 *   "Close Ended Schemes(Income/Debt Oriented Schemes - Fixed Term Plan)"
 *   "Open Ended Schemes(Growth)"                      <- no dash
 *   "Open Ended Schemes(Exchange Traded Funds (ETFs) - Gold ETF)"  <- nested parens
 *
 * AMFI's own taxonomy contains near-duplicate spellings ("Equity Scheme -" vs
 * "Equity Schemes -", "Sectoral/ Thematic" vs "Sectoral Fund" + "Thematic
 * Fund"). These are NOT normalised together: 103 distinct headers were present
 * on 2026-09-15 and all 103 are preserved verbatim. Merging AMFI's own
 * categories would be PC6 inventing a taxonomy AMFI did not publish.
 */
export function parseSectionHeader(line: string): SectionHeader | null {
  const m = SECTION_RE.exec(line.trim());
  if (!m) return null;
  const structureWord = m[1].toLowerCase();
  const structure: SchemeStructure =
    structureWord === 'open ended' ? 'open_ended' : structureWord === 'close ended' ? 'close_ended' : 'interval';
  const inner = m[2].trim();
  // Split on the LAST " - " so nested parentheses like "(ETFs)" stay intact.
  const idx = inner.lastIndexOf(' - ');
  if (idx === -1) return { raw: line.trim(), structure, categoryGroup: null, subCategory: inner };
  return {
    raw: line.trim(),
    structure,
    categoryGroup: inner.slice(0, idx).trim(),
    subCategory: inner.slice(idx + 3).trim(),
  };
}

function normaliseIsin(raw: string, field: string, warnings: FieldWarning[]): string | null {
  const t = raw.trim();
  if (t === '' || t === '-') return null;
  const v = validateIsin(t);
  if (!v.ok) {
    warnings.push({
      field,
      reason: 'INVALID_ISIN_DROPPED',
      detail: `'${t}' failed ISO 6166 validation and was dropped. The NAV record itself is retained — a bad optional identifier must not delete a valid price fact.`,
    });
    return null;
  }
  return v.normalised ?? t.toUpperCase();
}

function checksumOf(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('')).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

interface ColumnLayout {
  schemeCode: number;
  isinGrowth: number;
  isinReinvest: number;
  schemeName: number;
  plan: number;
  option: number;
  nav: number;
  date: number;
  headerPrefix: string;
}

const NAVALL_LAYOUT: ColumnLayout = {
  schemeCode: 0, isinGrowth: 1, isinReinvest: 2, schemeName: 3,
  plan: 4, option: 5, nav: 6, date: 7,
  headerPrefix: 'Scheme Code;ISIN',
};

const NAVHISTORY_LAYOUT: ColumnLayout = {
  schemeCode: 0, schemeName: 1, plan: 2, option: 3,
  isinGrowth: 4, isinReinvest: 5, nav: 6, date: 7,
  headerPrefix: 'Scheme Code;NAV Name',
};

function parseWithLayout(text: string, fingerprint: SourceFingerprint, layout: ColumnLayout, opts: ParseOptions): AmfiParseResult {
  const maxNavDecimals = opts.maxNavDecimals ?? 10;
  const asOf = opts.asOfDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`PC6: asOfDate must be ISO yyyy-mm-dd, got '${asOf}'`);

  const lines = text.split(/\r?\n/);
  const records: AmfiSchemeNavRecord[] = [];
  const rejections: Rejection[] = [];
  const sectionHeaders: string[] = [];
  const amcNames: string[] = [];
  const seenHeaders = new Set<string>();
  const seenAmcs = new Set<string>();
  /** (schemeCode|date) -> checksum, for in-file duplicate detection. */
  const seenKeys = new Map<string, string>();

  let section: SectionHeader | null = null;
  let amc: string | null = null;
  let dataLines = 0;
  let duplicatesIdentical = 0;
  let navDateMin: string | null = null;
  let navDateMax: string | null = null;

  const reject = (sourceLine: number, reason: RejectionReason, detail: string, raw: string) => {
    rejections.push({ sourceLine, reason, detail, rawExcerpt: raw.slice(0, 200) });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sourceLine = i + 1;
    const trimmed = line.trim();
    if (trimmed === '') continue;

    if (!line.includes(';')) {
      const header = parseSectionHeader(trimmed);
      if (header) {
        section = header;
        // A new section resets the AMC — AMC sub-headers are scoped to their section.
        amc = null;
        if (!seenHeaders.has(header.raw)) {
          seenHeaders.add(header.raw);
          sectionHeaders.push(header.raw);
        }
      } else {
        // Anything else without a semicolon is an AMC sub-header.
        amc = trimmed;
        if (!seenAmcs.has(amc)) {
          seenAmcs.add(amc);
          amcNames.push(amc);
        }
      }
      continue;
    }

    if (trimmed.startsWith(layout.headerPrefix)) continue; // the column header
    dataLines++;

    const f = line.split(';');
    if (f.length !== 8) {
      reject(sourceLine, 'FIELD_COUNT', `Expected 8 semicolon-delimited fields, found ${f.length}.`, line);
      continue;
    }
    if (!section) {
      reject(sourceLine, 'ORPHAN_ROW_NO_SECTION', 'Data row appeared before any scheme-structure section header.', line);
      continue;
    }
    const schemeCode = f[layout.schemeCode].trim();
    if (!/^\d{1,12}$/.test(schemeCode)) {
      reject(sourceLine, 'INVALID_SCHEME_CODE', `Scheme code '${schemeCode}' is not a plain numeric AMFI code.`, line);
      continue;
    }

    const schemeName = f[layout.schemeName].trim();
    if (schemeName === '') {
      reject(sourceLine, 'EMPTY_SCHEME_NAME', 'Scheme name is empty.', line);
      continue;
    }

    const navParsed = parseStrictDecimal(f[layout.nav], maxNavDecimals);
    if (!navParsed.ok) {
      reject(
        sourceLine,
        navParsed.reason,
        navParsed.reason === 'MALFORMED_NAV'
          ? `NAV value '${f[layout.nav].trim()}' is not a well-formed non-negative decimal.`
          : `NAV value '${f[layout.nav].trim()}' carries more than ${maxNavDecimals} decimal places and cannot be stored without silent rounding.`,
        line
      );
      continue;
    }
    // DECIMAL_RE cannot match a leading '-', so a negative NAV arrives as
    // MALFORMED_NAV above. This branch is the belt-and-braces guard for any
    // future loosening of the regex, and is asserted by its own unit test.
    if (navParsed.value < 0) {
      reject(sourceLine, 'NEGATIVE_NAV', `NAV value '${navParsed.text}' is negative.`, line);
      continue;
    }

    const navDate = parseAmfiDate(f[layout.date]);
    if (!navDate) {
      reject(sourceLine, 'INVALID_DATE', `Date '${f[layout.date].trim()}' is not a valid dd-MMM-yyyy calendar date.`, line);
      continue;
    }
    if (navDate > asOf) {
      reject(sourceLine, 'FUTURE_DATE', `NAV date ${navDate} is after the ingestion as-of date ${asOf}.`, line);
      continue;
    }

    const fieldWarnings: FieldWarning[] = [];
    if (!amc) {
      fieldWarnings.push({
        field: 'amc_name',
        reason: 'AMC_HEADER_MISSING',
        detail: `AMFI published no AMC sub-header between the section header and this row, so the AMC is recorded as unknown rather than inherited from the previous section.`,
      });
    }
    const isinGrowthOrPayout = normaliseIsin(f[layout.isinGrowth], 'isin_growth_or_payout', fieldWarnings);
    const isinReinvestment = normaliseIsin(f[layout.isinReinvest], 'isin_reinvestment', fieldWarnings);
    const planRaw = f[layout.plan].trim();
    const optionRaw = f[layout.option].trim();
    const plan = normalisePlan(planRaw);
    if (plan.warning) fieldWarnings.push(plan.warning);
    const option = normaliseOption(optionRaw);
    if (option.warning) fieldWarnings.push(option.warning);

    const recordChecksum = checksumOf([
      schemeCode, schemeName, amc ?? '', section.raw, planRaw, optionRaw,
      isinGrowthOrPayout ?? '', isinReinvestment ?? '', navParsed.text, navDate,
    ]);

    const key = `${schemeCode}|${navDate}`;
    const prior = seenKeys.get(key);
    if (prior !== undefined) {
      if (prior === recordChecksum) {
        duplicatesIdentical++;
        continue; // byte-identical repeat — idempotent, silently collapsed
      }
      reject(
        sourceLine,
        'DUPLICATE_CONFLICTING',
        `Scheme ${schemeCode} appears twice for ${navDate} with DIFFERENT content. The first occurrence is kept; this one is rejected rather than overwriting it.`,
        line
      );
      continue;
    }
    seenKeys.set(key, recordChecksum);

    if (navDateMin === null || navDate < navDateMin) navDateMin = navDate;
    if (navDateMax === null || navDate > navDateMax) navDateMax = navDate;

    records.push({
      amfiSchemeCode: schemeCode,
      schemeName,
      amcName: amc,
      schemeStructure: section.structure,
      categoryHeaderRaw: section.raw,
      categoryGroup: section.categoryGroup,
      subCategory: section.subCategory,
      planRaw,
      planType: plan.planType,
      optionRaw,
      optionType: option.optionType,
      isinGrowthOrPayout,
      isinReinvestment,
      navRaw: navParsed.text,
      nav: navParsed.value,
      navDate,
      sourceLine,
      recordChecksum,
      fieldWarnings,
    });
  }

  return {
    records,
    rejections,
    fingerprint,
    parserVersion: AMFI_PARSER_VERSION,
    sectionHeaders,
    amcNames,
    navDateMin,
    navDateMax,
    counts: {
      totalLines: lines.length,
      dataLines,
      accepted: records.length,
      rejected: rejections.length,
      duplicatesIdentical,
    },
  };
}

export function fingerprintBytes(bytes: Uint8Array, retrievedAt?: string): SourceFingerprint {
  return {
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    retrievedAt: retrievedAt ?? new Date().toISOString(),
  };
}

/** Parse AMFI's NAVAll.txt (latest NAV per scheme). */
export function parseNavAll(bytes: Uint8Array, opts: ParseOptions): AmfiParseResult {
  const fp = fingerprintBytes(bytes, opts.retrievedAt);
  return parseWithLayout(Buffer.from(bytes).toString('utf8'), fp, NAVALL_LAYOUT, opts);
}

/** Parse AMFI's NAV history report (a date window, many rows per scheme). */
export function parseNavHistory(bytes: Uint8Array, opts: ParseOptions): AmfiParseResult {
  const fp = fingerprintBytes(bytes, opts.retrievedAt);
  return parseWithLayout(Buffer.from(bytes).toString('utf8'), fp, NAVHISTORY_LAYOUT, opts);
}
