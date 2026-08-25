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
  normaliseLabel,
  parsePayslipDate,
} from './normalise';
import { inferPayFrequency } from './frequency';
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

function findEmployerName(lines: readonly string[]): string | undefined {
  for (const line of lines) {
    const value = valueAfterKey(line, EMPLOYER_KEYS);
    if (!value) continue;
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

export type ColumnIntent = 'current_first' | 'current_only' | 'unknown';

/**
 * Decide how to read multi-amount lines.
 *
 * `current_first` — a header line names both a current column and a YTD column,
 * in that order. This is by far the most common layout.
 * `current_only`  — no YTD column anywhere; every amount is current period.
 */
export function detectColumnIntent(lines: readonly string[]): ColumnIntent {
  for (const line of lines) {
    if (!looksYearToDate(line)) continue;
    const normalised = normaliseLabel(line);
    // A header row, not a data row: it should carry no money.
    if (extractMoneyTokens(line).length > 0) continue;
    const ytdIdx = Math.max(
      normalised.indexOf('ytd'),
      normalised.indexOf('year to date'),
      normalised.indexOf('cumulative'),
    );
    const currentIdx = Math.max(
      normalised.indexOf('this period'),
      normalised.indexOf('current'),
      normalised.indexOf('this pay'),
      normalised.indexOf('amount'),
    );
    if (ytdIdx !== -1 && currentIdx !== -1 && currentIdx < ytdIdx) return 'current_first';
    if (ytdIdx !== -1) return 'current_first';
  }
  return 'current_only';
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
  const columnIntent = detectColumnIntent(rawLines);
  if (columnIntent === 'unknown') warnings.push('column_intent_unknown');

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
  const components: PayrollComponent[] = [];
  let grossPay: number | undefined;
  let netPay: number | undefined;
  let employeeDeductionsTotal: number | undefined;
  let ytdGross: number | undefined;
  let ytdNet: number | undefined;
  let ytdTax: number | undefined;

  let sawUnknownComponent = false;

  for (const line of rawLines) {
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

    const current = lineIsYtdOnly ? undefined : amounts[0];
    const ytd = lineIsYtdOnly
      ? amounts[0]
      : columnIntent === 'current_first' && amounts.length > 1
        ? amounts[1]
        : undefined;

    // --- totals first: a total line is NOT a component --------------------
    if (isTotalLabel(label, 'net')) {
      if (current !== undefined) netPay ??= current;
      if (ytd !== undefined) ytdNet ??= ytd;
      continue;
    }
    if (isTotalLabel(label, 'gross')) {
      if (current !== undefined) grossPay ??= current;
      if (ytd !== undefined) ytdGross ??= ytd;
      continue;
    }
    if (isTotalLabel(label, 'totalDeductions')) {
      if (current !== undefined) employeeDeductionsTotal ??= current;
      continue;
    }

    // --- ordinary component line ------------------------------------------
    const classified = classifyPayslipLabel(label, country);
    const safeLabel = safePayrollLabel(label) ?? 'unknown';

    if (!classified) {
      sawUnknownComponent = true;
      if (current !== undefined) {
        components.push({
          side: 'informational', type: 'unknown', labelRaw: safeLabel,
          amount: current, isYearToDate: false,
        });
      }
      continue;
    }

    if (current !== undefined) {
      components.push({
        side: classified.side, type: classified.type, labelRaw: safeLabel,
        amount: current, isYearToDate: false,
      });
    }
    if (ytd !== undefined) {
      components.push({
        side: classified.side, type: classified.type, labelRaw: safeLabel,
        amount: ytd, isYearToDate: true,
      });
      if (classified.type === 'income_tax_withheld') ytdTax ??= ytd;
    }
  }

  if (sawUnknownComponent) warnings.push('unknown_payroll_field');

  // --- Roll components up into the header totals ----------------------------
  const currentLines = components.filter((c) => !c.isYearToDate);
  const ytdLines = components.filter((c) => c.isYearToDate);

  const sumOf = (types: readonly string[], from: PayrollComponent[] = currentLines) => {
    const matching = from.filter((c) => types.includes(c.type));
    if (matching.length === 0) return undefined;
    return round4(matching.reduce((acc, c) => acc + c.amount, 0));
  };

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
  const pattern = /\(?\s*(?:[$₹]|Rs\.?\s*)?-?\s*\d[\d, ]*(?:\.\d+)?\s*-?\)?/g;
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
