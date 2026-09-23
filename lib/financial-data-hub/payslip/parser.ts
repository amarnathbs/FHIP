/**
 * FDH-9 — payslip line parser.
 *
 * Turns the plain text of a payslip into a `PayrollExtraction`.
 *
 * WHAT THIS IS NOT. It is not a general PDF engine — getting text out of the
 * PDF is FDH-5's `bank-pdf/textExtraction.ts`, reused unchanged (spec section
 * 14). It is not an OCR engine — a scanned payslip is refused, not guessed at
 * (spec section 15). What IS new here, and legitimately so, is payslip LAYOUT
 * intelligence: which line is a component, which column is year-to-date, which
 * figure is the gross and which is the net.
 *
 * THE TWO-COLUMN PROBLEM. Most payslips print
 *
 *     Description        This Period      Year to Date
 *     Ordinary Hours        4,500.00         36,000.00
 *
 * A parser that takes "the last number on the line" reads a year-to-date
 * figure as this fortnight's pay and overstates income eightfold. So column
 * intent is DETECTED from a header line, and where it cannot be detected the
 * parser takes the FIRST amount (the current period, in every layout observed)
 * and records a warning rather than assuming. YTD is evidence, never another
 * payment (spec section 35).
 *
 * ---------------------------------------------------------------------------
 * 2026-09-24 — THE YTD-INTO-PERIOD DEFECT, AND WHY THE ORIGINAL RULE WAS NOT
 * ENOUGH.
 *
 * A real AU fortnightly payslip imported in production stored a YEAR-TO-DATE
 * figure as the period `base_pay` (out by a factor of ~26) and left
 * `gross_pay` null. Three independent structural weaknesses in the original
 * rule produce that, each reproducible from a synthetic AU payslip
 * (`tests/fixtures/fdh9/payslipColumnLayouts.ts`):
 *
 *   1. A STANDALONE "Year To Date" HEADING WAS READ AS A COLUMN HEADER.
 *      `detectColumnIntent` accepted ANY money-free line carrying a YTD
 *      marker as proof of a "current column then YTD column" layout. On the
 *      very common AU layout where "Year To Date" is a SECTION HEADING
 *      introducing a block of YTD-only rows, that conclusion is exactly
 *      inverted: every row beneath it is year-to-date, and the parser read
 *      each row's single amount as a CURRENT-period amount. A
 *      `Salary  75,217.63` row in that block became a current-period `base`
 *      component. This is the layout that reproduces the production row's
 *      full observable signature (gross null, base = the YTD figure,
 *      confidence 0.55, reconciliation `variance`) exactly.
 *
 *   2. COLUMN ORDER WAS DETECTED BUT NEVER USED. The original function tested
 *      `currentIdx < ytdIdx` and returned `current_first`; when that test
 *      FAILED (a `Year to Date | This Pay` header — YTD printed first) it
 *      returned `current_first` anyway. There was no `ytd_first` outcome at
 *      all, so the YTD column won.
 *
 *   3. `amounts[0]` IS POSITIONAL, NOT COLUMN-AWARE. `extractAmountTokens`
 *      treats `76.00` (hours) and `37.7632` (an hourly rate) as money-shaped,
 *      so on the standard `Qty | Rate | This Pay | Year to Date` row layout
 *      the QUANTITY became the period amount.
 *
 * THE RULE NOW. Column intent is a PLAN derived from the document's own
 * header row — the character order of the column markers it names, including
 * non-money columns (Qty/Rate/Units/Hours) — and amounts on a data row are
 * mapped to that plan by POSITION, not by "first one wins". A money-free line
 * carrying a YTD marker but NO current-column marker is a SECTION HEADING,
 * not a column header, and opens a year-to-date section in which every amount
 * is year-to-date. Where the document gives no readable header but does use
 * YTD somewhere, orientation is settled by the one invariant a year-to-date
 * column cannot break — YTD is cumulative, so it is never SMALLER than the
 * period figure on the same row — and the flip is only ever made in the
 * direction that the document's own figures prove is required. Everything
 * else records a warning and forces review rather than guessing.
 */

import {
  classifyPayslipLabel,
  isTotalLabel,
  looksYearToDate,
} from './labels';
import { isForbiddenPayrollLabel, safePayrollLabel } from './privacy';
import {
  extractAmountTokens,
  extractMoneyTokens,
  findDateInLine,
  normaliseEmployerName,
  moneyTokenPattern,
  normaliseLabel,
  parsePayslipDate,
} from './normalise';
import { inferPayFrequency } from './frequency';
import { fromMinorUnits, toMinorUnits } from '../domain/money';
import type {
  PayrollComponent,
  PayrollCountry,
  PayrollExtraction,
} from './types';

export const PAYSLIP_PARSER_NAME = 'fhip_payslip_generic';
export const PAYSLIP_PARSER_VERSION = '1.0.0';

// ---------------------------------------------------------------------------
// Country detection
// ---------------------------------------------------------------------------

/** Signals unique enough to identify the payroll jurisdiction. Deliberately
 * NOT filename-based and NOT user-declared-only: the document decides. */
const AU_SIGNALS = [
  'payg', 'superannuation', 'super guarantee', 'tax file number', 'tfn', 'abn',
  'ordinary hours', 'salary sacrifice', 'fair work', 'ordinary time earnings', 'australian',
];
const IN_SIGNALS = [
  'provident fund', 'epf', 'uan', 'professional tax', 'tds', 'hra',
  'house rent allowance', 'dearness allowance', 'pan', 'esic', 'gratuity',
  'lta', 'ctc', 'inr', 'rupees',
];

export interface CountryDetection {
  country: PayrollCountry | null;
  currencyCode: string | null;
  auScore: number;
  inScore: number;
}

export function detectPayslipCountry(text: string): CountryDetection {
  const normalised = normaliseLabel(text);
  const hasWord = (term: string) =>
    term.length <= 4
      ? new RegExp(`(?:^|\\s)${term}(?:\\s|$)`).test(normalised)
      : normalised.includes(term);

  const auScore = AU_SIGNALS.filter(hasWord).length;
  const inScore = IN_SIGNALS.filter(hasWord).length;

  // Currency symbols are a strong, independent signal.
  const hasRupee = /₹|\bRs\.?\b|\bINR\b/i.test(text);
  const hasAud = /\bAUD\b|\bA\$/i.test(text);

  let country: PayrollCountry | null = null;
  if (inScore > auScore || (hasRupee && inScore >= auScore)) country = 'IN';
  else if (auScore > inScore || (hasAud && auScore >= inScore)) country = 'AU';
  else if (auScore > 0 && auScore === inScore) country = null; // genuinely ambiguous

  const currencyCode = country === 'IN' ? 'INR' : country === 'AU' ? 'AUD' : null;
  return { country, currencyCode, auScore, inScore };
}

// ---------------------------------------------------------------------------
// Header field extraction
// ---------------------------------------------------------------------------

const EMPLOYER_KEYS = [
  'employer', 'company name', 'company', 'organisation', 'organization', 'paid by',
];
const PERIOD_START_KEYS = ['pay period from', 'period from', 'from date', 'period start', 'pay period start'];
const PERIOD_END_KEYS = ['pay period to', 'period to', 'to date', 'period end', 'pay period end'];
const PERIOD_RANGE_KEYS = ['pay period', 'period', 'pay cycle'];
const PAYMENT_DATE_KEYS = ['payment date', 'pay date', 'date paid', 'paid on', 'credit date', 'date of payment'];

function valueAfterKey(line: string, keys: readonly string[]): string | null {
  const lower = line.toLowerCase();
  for (const key of keys) {
    const idx = lower.indexOf(key);
    if (idx === -1) continue;
    let rest = line.slice(idx + key.length);
    rest = rest.replace(/^\s*[:\-–]\s*/, '').trim();
    if (rest) return rest;
  }
  return null;
}

/**
 * Does this line name the employer with an explicit `Employer: X` separator?
 *
 * Found 2026-09-24 alongside the YTD defect: `EMPLOYER_KEYS` contains the
 * bare word `employer`, matched ANYWHERE in the line, so a perfectly ordinary
 * AU component line — `Employer Superannuation   8,650.00   330.05` — was
 * read as "the employer is called Superannuation", and that name then flowed
 * into the Income proposal's `source_name`. A line that carries a money
 * amount and does NOT separate the key from its value with `:`/`-` is a
 * component line, not a header field.
 */
function isKeyedEmployerLine(line: string, keys: readonly string[]): boolean {
  const lower = line.toLowerCase();
  for (const key of keys) {
    const idx = lower.indexOf(key);
    if (idx === -1) continue;
    if (/^\s*[:\-–]/.test(line.slice(idx + key.length))) return true;
  }
  return false;
}

function findEmployerName(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const value = valueAfterKey(line, EMPLOYER_KEYS);
    if (!value) continue;
    if (extractAmountTokens(line).length > 0 && !isKeyedEmployerLine(line, EMPLOYER_KEYS)) continue;
    if (isForbiddenPayrollLabel(value)) continue;
    // Strip any trailing "ABN 12 345..." noise.
    const cleaned = value.split(/\s{2,}|\bABN\b|\bACN\b|\bGSTIN\b/i)[0].trim();
    const safe = safePayrollLabel(cleaned);
    if (safe && safe.length >= 2) return safe;
  }
  return undefined;
}

/** Extract both ends of a range like "01/08/2026 - 14/08/2026". */
function findPeriodRange(lines: readonly string[]): { start?: string; end?: string } {
  for (const line of lines) {
    const value = valueAfterKey(line, PERIOD_RANGE_KEYS);
    if (!value) continue;
    const parts = value.split(/\s*(?:-|–|—|\bto\b)\s*/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const start = parsePayslipDate(parts[0]) ?? findDateInLine(parts[0]);
      const end = parsePayslipDate(parts[1]) ?? findDateInLine(parts[1]);
      if (start && end) return { start, end };
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Column-intent detection
// ---------------------------------------------------------------------------

/** What one value column on a payslip table means. */
export type PayslipColumnKind = 'current' | 'ytd' | 'other';

/**
 * Column markers, as employers actually print them.
 *
 * `other` exists so a Qty/Rate/Units column is RECOGNISED AND SKIPPED rather
 * than silently becoming the period amount — see defect 3 in this file's
 * header. Longest markers are matched first and their character span is
 * masked, so `this period` is never shredded into `period`, and `year to
 * date` is never shredded into `date`.
 */
const CURRENT_COLUMN_MARKERS = [
  'this period', 'current period', 'this pay period', 'this pay run', 'this pay',
  'current pay', 'this month', 'this fortnight', 'this week', 'period amount',
  'current', 'amount', 'this run',
];
const YTD_COLUMN_MARKERS = [
  'financial year to date', 'year to date', 'yr to date', 'year-to-date',
  'ytd amount', 'cumulative', 'ytd',
];
const OTHER_COLUMN_MARKERS = [
  'ordinary rate', 'hourly rate', 'unit price', 'quantity', 'units', 'unit',
  'hours', 'hrs', 'rate', 'qty', 'days', 'no of days', 'per cent', 'percent',
];

export interface PayslipColumnPlan {
  /**
   * Every VALUE column the header names, left to right (the leading
   * description column is not a value column and never appears here).
   */
  columns: PayslipColumnKind[];
  /** Only the money columns, left to right. */
  moneyColumns: PayslipColumnKind[];
  /**
   * `header` — a header row named BOTH a current and a YTD column, so
   * positional mapping is grounded in the document.
   * `ytd_present_no_header` — the document uses YTD somewhere, but no
   * readable two-column header row was found.
   * `current_only` — no YTD marker appears anywhere; every amount is current.
   */
  source: 'header' | 'ytd_present_no_header' | 'current_only';
  /**
   * Only meaningful for `ytd_present_no_header`, where there are no header
   * columns to order: whether a two-amount row should be read YTD-first.
   * Starts false (period first, the layout in every sample observed) and is
   * only ever set by the cumulative-YTD invariant proving it must be true.
   */
  ytdFirst?: boolean;
  /** The header line the plan came from, for diagnostics/tests. */
  headerLine?: string;
}

function isWordBoundary(text: string, start: number, length: number): boolean {
  const before = start === 0 ? '' : text[start - 1];
  const after = start + length >= text.length ? '' : text[start + length];
  return !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
}

/**
 * Read one line as a table header row.
 *
 * Returns the value columns it names, left to right, or `null` when the line
 * does not name at least one current column AND one YTD column — the only
 * shape that actually PROVES a two-column layout. A money-free line naming
 * only YTD is a section heading, and is handled as one (see
 * `isYtdSectionHeading`), which is precisely the inversion that produced the
 * production defect.
 */
export function parsePayslipColumnHeader(line: string): PayslipColumnKind[] | null {
  if (extractMoneyTokens(line).length > 0) return null;
  const lower = line.toLowerCase();
  const taken = new Array(lower.length).fill(false);
  const found: { start: number; kind: PayslipColumnKind }[] = [];

  const all: { marker: string; kind: PayslipColumnKind }[] = [
    ...YTD_COLUMN_MARKERS.map((marker) => ({ marker, kind: 'ytd' as const })),
    ...CURRENT_COLUMN_MARKERS.map((marker) => ({ marker, kind: 'current' as const })),
    ...OTHER_COLUMN_MARKERS.map((marker) => ({ marker, kind: 'other' as const })),
  ].sort((a, b) => b.marker.length - a.marker.length);

  for (const { marker, kind } of all) {
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(marker, from);
      if (idx === -1) break;
      from = idx + marker.length;
      if (!isWordBoundary(lower, idx, marker.length)) continue;
      let overlaps = false;
      for (let i = idx; i < idx + marker.length; i += 1) if (taken[i]) { overlaps = true; break; }
      if (overlaps) continue;
      for (let i = idx; i < idx + marker.length; i += 1) taken[i] = true;
      found.push({ start: idx, kind });
    }
  }

  if (!found.some((f) => f.kind === 'current') || !found.some((f) => f.kind === 'ytd')) return null;
  found.sort((a, b) => a.start - b.start);
  return found.map((f) => f.kind);
}

/**
 * A money-free line that carries a YTD marker and NO current-column marker.
 *
 * On a real AU payslip this is a SECTION HEADING ("Year To Date", "Year to
 * Date Summary") introducing a block of year-to-date rows — not a column
 * header. Reading it as a column header is defect 1 in this file's header,
 * and is what put a YTD figure into `base_pay` in production.
 */
export function isYtdSectionHeading(line: string): boolean {
  if (extractMoneyTokens(line).length > 0) return false;
  if (!looksYearToDate(line)) return false;
  return parsePayslipColumnHeader(line) === null;
}

/**
 * A money-free line with no YTD marker and few enough words to be a section
 * heading ("Deductions", "Superannuation", "Payments", "This Pay"). Used only
 * to CLOSE a year-to-date section, so a YTD block cannot swallow the rest of
 * the document.
 */
function isSectionBreak(line: string): boolean {
  if (extractMoneyTokens(line).length > 0) return false;
  if (looksYearToDate(line)) return false;
  const normalised = normaliseLabel(line);
  if (!normalised) return false;
  return normalised.split(' ').length <= 6;
}

/** Build the document's column plan. Never throws; never guesses silently. */
export function planPayslipColumns(lines: readonly string[]): PayslipColumnPlan {
  for (const line of lines) {
    const columns = parsePayslipColumnHeader(line);
    if (columns) {
      return {
        columns,
        moneyColumns: columns.filter((c) => c !== 'other'),
        source: 'header',
        headerLine: line,
      };
    }
  }
  const usesYtdAnywhere = lines.some((line) => looksYearToDate(line));
  return {
    columns: [],
    moneyColumns: [],
    source: usesYtdAnywhere ? 'ytd_present_no_header' : 'current_only',
  };
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export interface ParsePayslipOptions {
  /** Declared by the upload metadata; used ONLY when the document itself is
   * ambiguous, never to override document evidence. */
  declaredCountry?: PayrollCountry;
  declaredCurrency?: string;
  /** Prior payment dates for this employer, for frequency-from-history. */
  priorPaymentDates?: readonly string[];
}

export function parsePayslipText(
  text: string,
  options: ParsePayslipOptions = {},
): PayrollExtraction | { error: 'country_not_identified' | 'not_a_payslip' } {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  // A payslip must look like one. This is a cheap guard against a user
  // uploading a bank statement into the payslip flow.
  const looksLikePayslip = /pay\s?slip|payslip|salary\s+slip|pay\s+advice|earnings\s+statement|remittance\s+advice|pay\s+statement/i.test(text)
    || (/\bnet\s+pay\b|\bnet\s+salary\b/i.test(text) && /\bgross\b|\btotal\s+earnings\b/i.test(text));
  if (!looksLikePayslip) return { error: 'not_a_payslip' };

  const detection = detectPayslipCountry(text);
  const country = detection.country ?? options.declaredCountry ?? null;
  if (!country) return { error: 'country_not_identified' };
  const currencyCode = detection.currencyCode ?? options.declaredCurrency ?? (country === 'IN' ? 'INR' : 'AUD');

  const warnings: string[] = [];
  const basePlan = planPayslipColumns(rawLines);

  // --- Header fields --------------------------------------------------------
  const employerName = findEmployerName(rawLines);
  if (!employerName) warnings.push('employer_not_identified');

  let payPeriodStart: string | undefined;
  let payPeriodEnd: string | undefined;
  let paymentDate: string | undefined;

  for (const line of rawLines) {
    if (!payPeriodStart) {
      const v = valueAfterKey(line, PERIOD_START_KEYS);
      if (v) payPeriodStart = parsePayslipDate(v) ?? findDateInLine(v);
    }
    if (!payPeriodEnd) {
      const v = valueAfterKey(line, PERIOD_END_KEYS);
      if (v) payPeriodEnd = parsePayslipDate(v) ?? findDateInLine(v);
    }
    if (!paymentDate) {
      const v = valueAfterKey(line, PAYMENT_DATE_KEYS);
      if (v) paymentDate = parsePayslipDate(v) ?? findDateInLine(v);
    }
  }
  if (!payPeriodStart || !payPeriodEnd) {
    const range = findPeriodRange(rawLines);
    payPeriodStart ??= range.start;
    payPeriodEnd ??= range.end;
  }
  if (!paymentDate) warnings.push('payment_date_not_identified');

  // --- Component + total lines ---------------------------------------------
  //
  // Read TWICE at most: once under the plan the document's own header implies,
  // and — only when the first pass's own figures break the one invariant a
  // year-to-date column cannot break (YTD is cumulative, so it is never
  // SMALLER than the same row's period figure) — once more with the two money
  // columns swapped. The second pass is never speculative: it runs only when
  // the document has already proved the first orientation impossible.
  let pass = readDocumentLines(rawLines, basePlan, country);
  if (pass.orientationViolations > 0 && pass.orientationViolations >= pass.orientationAgreements) {
    const flipped = flipMoneyColumns(basePlan);
    if (flipped) {
      const second = readDocumentLines(rawLines, flipped, country);
      // Only adopt the flip if it actually RESOLVES the contradiction. If the
      // document is inconsistent both ways, keep the header's own answer and
      // say so, rather than shuffling figures until something looks tidy.
      if (second.orientationViolations < pass.orientationViolations) {
        pass = second;
        pass.warnings.push('column_orientation_corrected');
      } else {
        pass.warnings.push('column_orientation_unresolved');
      }
    }
  }

  const {
    components, grossPay: statedGrossPay, netPay, employeeDeductionsTotal,
    ytdGross, ytdNet, ytdTax,
  } = pass;
  for (const w of pass.warnings) if (!warnings.includes(w)) warnings.push(w);

  // --- Roll components up into the header totals ----------------------------
  const currentLines = components.filter((c) => !c.isYearToDate);
  const ytdLines = components.filter((c) => c.isYearToDate);

  const sumOf = (types: readonly string[], from: PayrollComponent[] = currentLines) => {
    const matching = from.filter((c) => types.includes(c.type));
    if (matching.length === 0) return undefined;
    return round4(matching.reduce((acc, c) => acc + c.amount, 0));
  };

  // --- Gross: stated, or derived ONLY where the document proves itself ------
  //
  // A payslip that does not state a gross figure under a label we recognise
  // used to leave `gross_pay` null with no explanation at all — the second
  // half of the production defect. `undefined` is still never coerced to
  // zero, and a gross is NEVER invented: derivation happens only when the
  // document's OWN current-period lines satisfy its OWN stated net exactly
  // (net = earnings - deductions, zero tolerance, integer minor units), which
  // means the derived figure is the payslip's own arithmetic rather than this
  // parser's opinion. Whichever way it went is recorded in `grossPaySource`
  // and persisted, so a derived gross can never be mistaken downstream for a
  // figure printed on the document.
  //
  // This deliberately CANNOT change the reconciliation outcome: the exact
  // identity required here is the same one `reconcileGrossToNet` has already
  // evaluated via its component path whenever derivation is possible at all,
  // so the gross-to-net safety net that caught this defect is untouched.
  let grossPay = statedGrossPay;
  let grossPaySource: PayrollExtraction['grossPaySource'];
  if (grossPay !== undefined) {
    grossPaySource = 'stated_on_document';
  } else {
    const derived = deriveGrossFromComponents(currentLines, netPay, currencyCode);
    if (derived !== undefined) {
      grossPay = derived;
      grossPaySource = 'derived_from_components';
      warnings.push('gross_derived_from_components');
    } else {
      warnings.push('gross_not_stated_on_document');
    }
  }

  const extraction: PayrollExtraction = {
    country,
    currencyCode,
    employerName,
    payPeriodStart,
    payPeriodEnd,
    paymentDate,

    payFrequency: 'unknown',
    payFrequencySource: 'unknown',

    grossPay,
    grossPaySource,
    basePay: sumOf(['base', 'basic']),
    overtimePay: sumOf(['overtime']),
    bonusPay: sumOf(['bonus']),
    commissionPay: sumOf(['commission']),
    allowancesTotal: sumOf(['allowance', 'hra', 'dearness_allowance', 'special_allowance', 'conveyance', 'lta']),
    reimbursementsTotal: sumOf(['reimbursement']),
    otherEarnings: sumOf(['other_earning', 'arrears']),

    taxWithheld: sumOf(['income_tax_withheld']),
    employeeDeductionsTotal,
    salarySacrifice: sumOf(['salary_sacrifice']),
    professionalTax: sumOf(['professional_tax']),

    employerRetirementContribution: sumOf(['employer_retirement']),
    employeeRetirementContribution: sumOf(['employee_retirement']),
    employerNpsContribution: sumOf(['employer_nps']),
    employeeNpsContribution: sumOf(['employee_nps']),

    netPay,

    ytdGross,
    ytdTax,
    ytdNet,
    ytdEmployerRetirement: sumOf(['employer_retirement'], ytdLines),
    ytdEmployeeRetirement: sumOf(['employee_retirement'], ytdLines),

    components,

    parserName: PAYSLIP_PARSER_NAME,
    parserVersion: PAYSLIP_PARSER_VERSION,
    extractionConfidence: 0,
    warnings,
  };

  // --- Frequency ------------------------------------------------------------
  const frequency = inferPayFrequency({
    lines: rawLines,
    periodStart: payPeriodStart,
    periodEnd: payPeriodEnd,
    paymentDate,
    priorPaymentDates: options.priorPaymentDates,
  });
  extraction.payFrequency = frequency.frequency;
  extraction.payFrequencySource = frequency.source;
  if (frequency.frequency === 'unknown') warnings.push('frequency_uncertain');

  extraction.extractionConfidence = scoreExtractionConfidence(extraction);
  return extraction;
}

// ---------------------------------------------------------------------------
// One reading pass over the document's lines, under a given column plan
// ---------------------------------------------------------------------------

interface DocumentPass {
  components: PayrollComponent[];
  grossPay?: number;
  netPay?: number;
  employeeDeductionsTotal?: number;
  ytdGross?: number;
  ytdNet?: number;
  ytdTax?: number;
  warnings: string[];
  /** Rows where BOTH a period and a YTD figure were read, both positive, and
   * the period figure was LARGER — which a cumulative YTD column cannot be. */
  orientationViolations: number;
  /** Rows where both were read and the invariant held. */
  orientationAgreements: number;
}

/** Swap the meaning of the two money columns, preserving their positions. */
function flipMoneyColumns(plan: PayslipColumnPlan): PayslipColumnPlan | null {
  if (plan.source === 'current_only') return null;
  const swap = (k: PayslipColumnKind): PayslipColumnKind => (k === 'current' ? 'ytd' : k === 'ytd' ? 'current' : k);
  const columns = plan.columns.map(swap);
  return {
    ...plan,
    columns,
    moneyColumns: columns.filter((c) => c !== 'other'),
    ytdFirst: !plan.ytdFirst,
  };
}

/**
 * Choose which amount on a data row is the PERIOD figure and which is the
 * year-to-date one.
 *
 * Positional against the header the document itself printed — never "the
 * first number wins", which is what let a Qty column and a YTD column both
 * be read as this period's pay. When the row's amount count matches neither
 * the full column list nor the money-only column list, nothing is guessed:
 * the single-amount case is taken as the period figure (true in every layout
 * observed), and anything else is reported as ambiguous so the caller can
 * force review.
 */
function selectRowAmounts(
  amounts: readonly number[],
  plan: PayslipColumnPlan,
  inYtdSection: boolean,
  labelIsYtd: boolean,
): { current?: number; ytd?: number; ambiguous: boolean } {
  // A row inside a year-to-date SECTION, or a row whose own label says YTD,
  // carries year-to-date figures only — there is no period figure on it.
  if (inYtdSection || labelIsYtd) {
    if (amounts.length === 1) return { ytd: amounts[0], ambiguous: false };
    // Several figures in a YTD block: the money column is the rightmost in
    // every layout where Qty/Rate precede it. Recorded as ambiguous so the
    // uncertainty is visible rather than absorbed.
    return { ytd: amounts[amounts.length - 1], ambiguous: true };
  }

  if (plan.source === 'header') {
    if (amounts.length === plan.columns.length) return mapByColumns(amounts, plan.columns);
    if (plan.moneyColumns.length > 0 && amounts.length === plan.moneyColumns.length) {
      return mapByColumns(amounts, plan.moneyColumns);
    }
    if (amounts.length === 1) return { current: amounts[0], ambiguous: false };
    return { current: amounts[0], ambiguous: true };
  }

  if (plan.source === 'ytd_present_no_header') {
    if (amounts.length === 1) return { current: amounts[0], ambiguous: false };
    if (amounts.length === 2) {
      return plan.ytdFirst
        ? { ytd: amounts[0], current: amounts[1], ambiguous: false }
        : { current: amounts[0], ytd: amounts[1], ambiguous: false };
    }
    return { current: amounts[0], ambiguous: true };
  }

  // No YTD marker anywhere in the document: every amount is current period,
  // and nothing is ever filed as year-to-date.
  return { current: amounts[0], ambiguous: amounts.length > 1 };
}

function mapByColumns(
  amounts: readonly number[],
  columns: readonly PayslipColumnKind[],
): { current?: number; ytd?: number; ambiguous: boolean } {
  let current: number | undefined;
  let ytd: number | undefined;
  columns.forEach((kind, i) => {
    if (kind === 'current') current ??= amounts[i];
    else if (kind === 'ytd') ytd ??= amounts[i];
  });
  return { current, ytd, ambiguous: false };
}

function readDocumentLines(
  rawLines: readonly string[],
  plan: PayslipColumnPlan,
  country: PayrollCountry,
): DocumentPass {
  const out: DocumentPass = {
    components: [], warnings: [], orientationViolations: 0, orientationAgreements: 0,
  };
  let sawUnknownComponent = false;
  let sawAmbiguousRow = false;
  let inYtdSection = false;

  for (const line of rawLines) {
    // Section state FIRST: a "Year To Date" heading opens a YTD block; any
    // other short, money-free heading closes it. Without this, every row of
    // a YTD summary block was read as this period's pay.
    if (isYtdSectionHeading(line)) { inYtdSection = true; continue; }
    if (inYtdSection && isSectionBreak(line)) { inYtdSection = false; continue; }

    // Document METADATA lines (employer, period, payment date, identifiers)
    // are never component lines. Skipping them explicitly stops "Pay Period:
    // 03/08/2026" contributing a bogus component and stops an ABN/UAN digit
    // run being read as an amount.
    if (isMetadataLine(line)) continue;

    const amounts = extractAmountTokens(line);
    if (amounts.length === 0) continue;

    // The label is whatever precedes the first amount on the line.
    const label = labelPortion(line);
    if (!label) continue;
    if (isForbiddenPayrollLabel(label)) continue;

    // A line explicitly marked YTD carries ONLY year-to-date figures.
    const lineIsYtdOnly = looksYearToDate(label);

    const picked = selectRowAmounts(amounts, plan, inYtdSection, lineIsYtdOnly);
    if (picked.ambiguous) sawAmbiguousRow = true;
    const current = picked.current;
    const ytd = picked.ytd;

    // The cumulative-YTD invariant, counted per row. A year-to-date column
    // INCLUDES the current period, so it is never smaller than it. Equality
    // is legitimate (the first pay run of a financial year). Negative
    // figures are excluded: a retro reversal genuinely can exceed its own
    // year-to-date position.
    if (current !== undefined && ytd !== undefined && current > 0 && ytd > 0) {
      if (current > ytd) out.orientationViolations += 1;
      else out.orientationAgreements += 1;
    }

    // --- totals first: a total line is NOT a component --------------------
    if (isTotalLabel(label, 'net')) {
      if (current !== undefined) out.netPay ??= current;
      if (ytd !== undefined) out.ytdNet ??= ytd;
      continue;
    }
    if (isTotalLabel(label, 'gross')) {
      if (current !== undefined) out.grossPay ??= current;
      if (ytd !== undefined) out.ytdGross ??= ytd;
      continue;
    }
    if (isTotalLabel(label, 'totalDeductions')) {
      if (current !== undefined) out.employeeDeductionsTotal ??= current;
      continue;
    }

    // --- ordinary component line ------------------------------------------
    const classified = classifyPayslipLabel(label, country);
    const safeLabel = safePayrollLabel(label) ?? 'unknown';

    if (!classified) {
      sawUnknownComponent = true;
      if (current !== undefined) {
        out.components.push({
          side: 'informational', type: 'unknown', labelRaw: safeLabel,
          amount: current, isYearToDate: false,
        });
      }
      // An unrecognised YTD line is preserved as evidence too. It can never
      // enter current-period arithmetic (every consumer filters on
      // `isYearToDate`), and discarding it would lose the only record that
      // the document said anything at all on that row.
      if (ytd !== undefined) {
        out.components.push({
          side: 'informational', type: 'unknown', labelRaw: safeLabel,
          amount: ytd, isYearToDate: true,
        });
      }
      continue;
    }

    // A deduction-side amount is a MAGNITUDE by domain definition (every
    // deduction/tax/contribution column in `fdh_payroll_events` is `>= 0` —
    // there is no such thing as "negative tax withheld"). Several real
    // payslip templates (confirmed against 4 genuine payslips from the same
    // employer, all sharing this layout) print deduction/tax lines with a
    // leading "-" that lands in its own table cell, separated from the
    // digits by whitespace once the PDF's columns collapse to plain text
    // (e.g. "Full Income tax\t-\t1,498.00") — a running-total bookkeeping
    // convention ("this reduces net pay"), not a genuine negative quantity.
    // `extractAmountTokens` correctly reads that as -1498, which is right
    // for a signed running column but wrong for this field's own domain
    // meaning. Without normalising here, that raw negative value reaches
    // the database unchanged and the insert is rejected outright by the
    // column's own `>= 0` check — the entire payslip import fails, not just
    // this one figure. Earnings-side amounts are deliberately left signed:
    // a retro reversal (e.g. "Base Salary -22.5 hrs ... -1,711.70") must
    // stay negative so it correctly nets against its own correcting line.
    const normalise = (value: number) => (classified.side === 'deduction' ? Math.abs(value) : value);

    if (current !== undefined) {
      out.components.push({
        side: classified.side, type: classified.type, labelRaw: safeLabel,
        amount: normalise(current), isYearToDate: false,
      });
    }
    if (ytd !== undefined) {
      const normalisedYtd = normalise(ytd);
      out.components.push({
        side: classified.side, type: classified.type, labelRaw: safeLabel,
        amount: normalisedYtd, isYearToDate: true,
      });
      if (classified.type === 'income_tax_withheld') out.ytdTax ??= normalisedYtd;
    }
  }

  if (sawUnknownComponent) out.warnings.push('unknown_payroll_field');
  if (sawAmbiguousRow) out.warnings.push('column_mapping_ambiguous');
  if (plan.source === 'ytd_present_no_header') out.warnings.push('column_header_not_identified');
  return out;
}

/**
 * Derive the current-period gross from the document's own earning lines —
 * but ONLY when those lines, together with the document's own deduction lines,
 * reproduce its own stated net EXACTLY.
 *
 * Returns `undefined` otherwise. A gross that cannot be proved from the
 * document is left absent, never fabricated and never zeroed (this repo's
 * standing rule: missing is not zero).
 */
function deriveGrossFromComponents(
  currentLines: readonly PayrollComponent[],
  netPay: number | undefined,
  currency: string,
): number | undefined {
  if (netPay === undefined) return undefined;
  const earnings = currentLines.filter((c) => c.side === 'earning');
  const deductions = currentLines.filter((c) => c.side === 'deduction');
  if (earnings.length === 0 || deductions.length === 0) return undefined;

  const earningsMinor = earnings.reduce((acc, c) => acc + toMinorUnits(c.amount, currency), 0);
  const deductionsMinor = deductions.reduce((acc, c) => acc + toMinorUnits(c.amount, currency), 0);
  if (earningsMinor - deductionsMinor !== toMinorUnits(netPay, currency)) return undefined;

  // A payslip's stated GROSS conventionally excludes expense reimbursements
  // (a repayment, not remuneration) — the same exclusion
  // `checkGrossAgainstComponents` already applies.
  const grossMinor = earnings
    .filter((c) => c.type !== 'reimbursement')
    .reduce((acc, c) => acc + toMinorUnits(c.amount, currency), 0);
  if (grossMinor < 0) return undefined;
  return fromMinorUnits(grossMinor, currency);
}

/**
 * Lines that describe the DOCUMENT rather than a pay component.
 *
 * Kept as an explicit list rather than a heuristic: a payslip's metadata block
 * is small and predictable, whereas guessing risks discarding a real earning
 * line (which would understate income — the worst direction to be wrong in).
 */
const METADATA_KEYS = [
  // NOTE the deliberate absence of a bare 'employer' / 'employee' key. Those
  // words begin real component lines — "Employer Superannuation", "Employee
  // Provident Fund", "Employer NPS" — and listing them here silently discarded
  // every retirement contribution on both AU and India payslips. The
  // employer/employee NAME lines carry no money-shaped token, so they are
  // skipped by the amount scan anyway and need no key of their own.
  'pay period', 'period from', 'period to', 'period start', 'period end',
  'from date', 'to date', 'payment date', 'pay date', 'date paid', 'paid on',
  'credit date', 'date of payment', 'pay frequency', 'payment frequency',
  'pay basis', 'pay cycle', 'pay run',
  'abn', 'acn', 'gstin', 'uan', 'esic', 'pan', 'tfn', 'tax file number',
  'employee id', 'employee no', 'employee code', 'emp id', 'emp code',
  'address', 'bank account', 'account no', 'account number', 'ifsc', 'bsb',
  'date of birth', 'dob', 'designation', 'department', 'location', 'grade',
  'payslip for', 'salary slip for', 'invoice',
];

function isMetadataLine(line: string): boolean {
  const normalised = normaliseLabel(line);
  if (!normalised) return false;
  return METADATA_KEYS.some((key) =>
    normalised === key || normalised.startsWith(`${key} `) || normalised.includes(` ${key} `));
}

/**
 * The portion of a line before its first AMOUNT.
 *
 * Computed on the date-stripped line so a date cannot be mistaken for the
 * first amount and truncate the label.
 */
function labelPortion(line: string): string | null {
  const withoutDates = line.replace(
    /\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|\d{1,2}[\s-]+[A-Za-z]{3,9}[\s,-]+\d{2,4}/g,
    ' ',
  );
  const pattern = moneyTokenPattern();
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(withoutDates)) !== null) {
    const token = match[0].trim();
    const digitsOnly = token.replace(/[^\d]/g, '');
    const moneyShaped =
      /[$₹]|Rs\.?/i.test(token)
      || /\.\d{1,2}\b/.test(token)
      || /\d,\d/.test(token)
      || digitsOnly.length >= 3;
    if (!moneyShaped) continue;
    const label = withoutDates.slice(0, match.index).trim().replace(/[:\-–|]+$/, '').trim();
    return label || null;
  }
  return null;
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

/**
 * A structural confidence score. Deliberately built from WHAT WAS FOUND, not
 * from a model's self-assessment — every term is a fact about the document.
 */
export function scoreExtractionConfidence(extraction: PayrollExtraction): number {
  let score = 0;
  if (extraction.grossPay !== undefined) score += 0.25;
  if (extraction.netPay !== undefined) score += 0.25;
  if (extraction.employerName) score += 0.15;
  if (extraction.paymentDate) score += 0.1;
  if (extraction.payPeriodStart && extraction.payPeriodEnd) score += 0.1;
  if (extraction.taxWithheld !== undefined) score += 0.05;
  if (extraction.components.some((c) => c.side === 'earning')) score += 0.05;
  if (extraction.payFrequency !== 'unknown') score += 0.05;
  if (extraction.warnings.includes('unknown_payroll_field')) score -= 0.05;
  // Layout uncertainty is a fact about the document, so it belongs in this
  // structural score exactly like the others. A gross this parser worked out
  // from the component lines is genuine but weaker evidence than one the
  // employer printed, and scores accordingly.
  if (extraction.warnings.includes('column_mapping_ambiguous')) score -= 0.05;
  if (extraction.warnings.includes('column_header_not_identified')) score -= 0.05;
  if (extraction.warnings.includes('column_orientation_unresolved')) score -= 0.05;
  if (extraction.grossPaySource === 'derived_from_components') score -= 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

/**
 * Deterministic content fingerprint used to recognise the SAME payslip
 * uploaded twice (spec section 34).
 *
 * Built from employer + period + payment date + gross + net. A REVISED payslip
 * changes at least one of those, so it produces a different fingerprint and is
 * correctly treated as a revision to be superseded rather than a duplicate to
 * be blocked.
 */
export function payslipFingerprint(extraction: PayrollExtraction): string {
  return [
    normaliseEmployerName(extraction.employerName) ?? 'unknown_employer',
    extraction.payPeriodStart ?? 'no_start',
    extraction.payPeriodEnd ?? 'no_end',
    extraction.paymentDate ?? 'no_payment_date',
    extraction.grossPay !== undefined ? extraction.grossPay.toFixed(4) : 'no_gross',
    extraction.netPay !== undefined ? extraction.netPay.toFixed(4) : 'no_net',
    extraction.currencyCode,
  ].join('|');
}
