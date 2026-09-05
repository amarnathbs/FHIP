// Investment Intelligence FS1 — CAMS-serviced INDIVIDUAL FOLIO STATEMENT
// ("Folio Details") parser adapter.
//
// This is a DIFFERENT document type from the certified CAMS Consolidated
// Account Statement (camsParser.ts, 'cams_detailed_v1') and from KFintech
// (kfintechParser.ts). It must never be confused with either at detection
// time (spec sections 9-10) and must never weaken their certification
// (spec section 86). See docs/investment-intelligence/
// II_FS1_CAMS_FOLIO_STRUCTURE.md for the full privacy-safe structural
// reference this file is built from — that document also discloses every
// structural gap honestly; nowhere here is a real value fabricated to fill
// one.
//
// Target layout (built from the FS1 dispatch's own sections 0/8 field
// list, not from the real document itself — see the structure doc's
// provenance note):
//
//   FOLIO DETAILS
//   FOLIO NUMBER : <folio>
//   Name : <holder>
//   ... (investor / bank / compliance labelled fields — spec section 8)
//   Statement Date : DD-MMM-YYYY
//
//   SUMMARY OF HOLDINGS
//   <scheme name>   <cost of investment>   <unit balance>   <nav date>   <nav>   <market value>
//   ...
//
//   SIP REGISTRATION            <- registration only, never a cashflow (spec section 25)
//   ...
//   MULTIPLE BANK DETAILS       <- present structurally, not parsed into transactions/holdings
//   ...
//
//   FINANCIAL TRANSACTIONS
//   <scheme name> ISIN CODE : <isin>
//   DATE          TRANSACTION TYPE        Amount     NAV      PRICE     UNITS     BALANCE UNITS
//   DD-MMM-YYYY   Opening Balance                                                  <units>
//   DD-MMM-YYYY   <transaction description>  <amt>   <nav>    <price>   <units>   <balance>   [Ref: <ref>]
//   DD-MMM-YYYY   Stamp Duty Charges Levied   <amt>
//   ...
//
//   FINANCIAL TRANSACTION FORM   <- application-form LABELS, never transactions (spec section 20)
//   ...
//   TERMS AND CONDITIONS         <- prose, never transactions (spec section 21)
//   ...
//
// Section boundaries are tracked explicitly and are ONE-WAY: once a
// FINANCIAL TRANSACTION FORM or TERMS (AND|&) CONDITIONS heading is seen,
// the parser never re-enters transaction/holding extraction mode for the
// rest of the document, no matter how transaction-shaped later text looks
// (spec sections 20, 21; FS-Q11).
//
// AMC NAME — disclosed structural gap (see the structure doc's "known
// documentation gaps" section): an individual folio statement is
// inherently single-AMC, and no "AMC Name:"-style labelled field appears
// in the dispatch's own field list for this document type (unlike the CAS
// grammar, which needs one because a CAS spans multiple AMCs). `amcName`
// is therefore left `''` here — the SAME disclosed-honest-unknown default
// camsParser.ts's ALT layout already uses for a real, different structural
// reason (see that file's header comment) — never guessed from context.
// This does not block canonical account/instrument resolution: the folio
// number alone still resolves to exactly one canonical account, and ISIN
// (when present) resolves the instrument ahead of any AMC-name signal
// (schemeResolution.ts priority order).

import type {
  InvestmentDocumentParser,
  ParseMetadata,
  ParsedAccountRecord,
  ParsedDocumentOutput,
  ParsedHoldingRecord,
  ParsedInstrumentRecord,
  ParsedTransactionRecord,
  ParsedWarning,
  SourceDetectionResult,
  ValidationOutcome,
} from './types';
import { splitLines, normaliseSchemeName, detectPlanType, detectOptionType, extractLabelledField, maskPan, redactPanFromLine } from './textUtils';
import { parseExactDecimal } from '../decimal';
import { parseStatementDate } from '../dateNormalisation';
import { classifyTransactionType } from '../transactionTypeMapping';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '../openingBalanceMarker';

export const CAMS_FOLIO_STATEMENT_PARSER_CODE = 'cams_folio_details_v1' as const;
export const CAMS_FOLIO_STATEMENT_PARSER_VERSION = '1.0.0';

// --- Section 9/10: multi-signal, fail-closed detection ---------------------
// No single marker is sufficient. Every signal below is drawn from the
// dispatch's own candidate list (section 9). A genuine CAS/KFintech document
// is never mistaken for this document type because it lacks BOTH the
// "FOLIO DETAILS" heading AND a "SUMMARY OF HOLDINGS" + "FINANCIAL
// TRANSACTIONS" heading pair that this scores on (a CAS/KFintech statement
// uses "Statement Period"/"Registrar: CAMS"/scheme-block grammar with none
// of these headings) — see iiFs1SourceDetection.test.ts for the explicit
// precedence adversarial cases (FS1-T01..T04, dispatch section 10).
const FOLIO_NUMBER_LABEL_RE = /^\s*FOLIO NUMBER\s*:/im;
const FOLIO_DETAILS_HEADING_RE = /^\s*FOLIO DETAILS\s*$/im;
const SUMMARY_OF_HOLDINGS_RE = /^\s*SUMMARY OF HOLDINGS\s*$/im;
const FINANCIAL_TRANSACTIONS_RE = /^\s*FINANCIAL TRANSACTIONS\s*$/im;
const ISIN_CODE_LABEL_RE = /ISIN CODE\s*:/i;
const STATEMENT_DATE_LABEL_RE = /^\s*Statement Date\s*:/im;
// A genuine CAS/KFintech document's own strong titles — used only as a
// NEGATIVE signal here (never to positively detect this document type),
// so an ambiguous document carrying BOTH sets of evidence is resolved by
// registry.ts's confidence comparison across all registered parsers
// (spec section 10), not by this parser silently yielding.
const CAS_TITLE_RE = /CAMS\s+Consolidated\s+Account\s+Statement|Statement Period\s*:/i;

const SECTION_HEADING_RE = {
  summaryOfHoldings: /^\s*SUMMARY OF HOLDINGS\s*$/i,
  sipRegistration: /^\s*SIP REGISTRATION\s*$/i,
  multipleBankDetails: /^\s*MULTIPLE BANK DETAILS\s*$/i,
  financialTransactions: /^\s*FINANCIAL TRANSACTIONS\s*$/i,
  financialTransactionForm: /^\s*FINANCIAL TRANSACTION FORM\s*$/i,
  termsAndConditions: /^\s*TERMS\s*(?:AND|&)\s*CONDITIONS\s*$/i,
};

const SCHEME_ISIN_HEADER_RE = /^(.+?)\s+ISIN CODE\s*:\s*([A-Z0-9]*)\s*$/i;

const OPENING_BALANCE_ROW_RE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+Opening Balance\s+(\(?-?[\d,]+\.\d+\)?)\s*(?:Units?)?\s*$/i;

// Full economic transaction row: DATE, TYPE (free text), Amount, NAV,
// PRICE, UNITS, BALANCE UNITS (spec section 18's exact column grammar —
// note this has ONE MORE numeric field than the certified CAS grammar,
// which has no separate NAV+PRICE pair; see the structure doc's disclosed
// gap about the NAV/PRICE relationship).
const FULL_TXN_ROW_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

// Stamp Duty / STT supplemental row — shorter shape, no NAV/PRICE/UNITS/
// BALANCE fields at all (spec section 22/23), mirroring the same
// structural fact already certified for CAS (camsParser.ts's
// ALT_FEE_ROW_RE) — attempted only after FULL_TXN_ROW_RE fails.
const FEE_ROW_RE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(Stamp\s+Duty[^0-9]*|Securities\s+Transaction\s+Tax[^0-9]*|STT\b[^0-9]*)\s+(\(?-?[\d,]+\.\d+\)?)\s*$/i;

// Summary-of-holdings row: Scheme Name, Cost of Investment, Unit Balance,
// NAV date, NAV, Market Value (spec section 15).
const HOLDING_ROW_RE =
  /^(.+?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s*$/;

function requireScaled(raw: string, warnings: ParsedWarning[], code: string, lineHint?: number): bigint | null {
  const parsed = parseExactDecimal(raw);
  if (!parsed.ok) {
    warnings.push({ code, message: `Could not parse numeric value "${raw}": ${parsed.error}`, severity: 'error', lineHint });
    return null;
  }
  if (parsed.roundedFromHigherPrecision) {
    warnings.push({ code: `${code}_rounded`, message: `Value "${raw}" had more than 6 fractional digits and was rounded.`, severity: 'info', lineHint });
  }
  return parsed.scaled;
}

// Re-exported for convenience/back-compat of anything importing it from
// this file — the canonical definition lives in openingBalanceMarker.ts
// (shared, provider-agnostic) so documentProcessing.ts does not need to
// import a specific parser module to know this sentinel.
export { OPENING_BALANCE_SOURCE_REFERENCE };

interface FolioSchemeContext {
  scheme: ParsedInstrumentRecord;
}

function buildScheme(rawName: string, isin: string | null): ParsedInstrumentRecord {
  return {
    rawSchemeName: rawName,
    normalisedSchemeName: normaliseSchemeName(rawName),
    amcName: '', // see file-header "AMC NAME" note — disclosed, honest default
    planType: detectPlanType(rawName),
    optionType: detectOptionType(rawName),
    isin: isin && isin.length > 0 ? isin : null,
    amfiSchemeCode: null,
  };
}

export const camsFolioStatementParser: InvestmentDocumentParser = {
  parserCode: CAMS_FOLIO_STATEMENT_PARSER_CODE,
  parserVersion: CAMS_FOLIO_STATEMENT_PARSER_VERSION,
  supportedSource: 'cams',
  supportedDocumentType: 'cams_folio_details',

  canHandle(text: string): SourceDetectionResult {
    const evidence: string[] = [];
    let confidence = 0;

    if (FOLIO_NUMBER_LABEL_RE.test(text)) {
      confidence += 0.2;
      evidence.push('"FOLIO NUMBER :" label found');
    }
    if (FOLIO_DETAILS_HEADING_RE.test(text)) {
      confidence += 0.2;
      evidence.push('"FOLIO DETAILS" heading found');
    }
    if (SUMMARY_OF_HOLDINGS_RE.test(text)) {
      confidence += 0.2;
      evidence.push('"SUMMARY OF HOLDINGS" heading found');
    }
    if (FINANCIAL_TRANSACTIONS_RE.test(text)) {
      confidence += 0.2;
      evidence.push('"FINANCIAL TRANSACTIONS" heading found');
    }
    if (ISIN_CODE_LABEL_RE.test(text)) {
      confidence += 0.15;
      evidence.push('"ISIN CODE :" scheme-header label found');
    }
    if (STATEMENT_DATE_LABEL_RE.test(text)) {
      confidence += 0.1;
      evidence.push('"Statement Date :" label found');
    }

    // Section 10 — document-kind precedence: a genuine CAS/KFintech
    // document's own strong evidence must never be outscored by a
    // coincidental single match here (e.g. the bare word "folio"
    // appearing somewhere in a CAS document's boilerplate). This parser
    // requires BOTH a folio-statement-specific heading (FOLIO DETAILS or
    // the labelled FOLIO NUMBER field) AND at least one of the two
    // structural section headings unique to this layout (SUMMARY OF
    // HOLDINGS / FINANCIAL TRANSACTIONS) before it will claim the
    // document at all — this floor is enforced independently of the
    // additive score above, not merely by the registry's 0.5 threshold,
    // so a document with only incidental/partial evidence never reaches
    // even a LOW confidence claim.
    const hasFolioIdentity = FOLIO_NUMBER_LABEL_RE.test(text) || FOLIO_DETAILS_HEADING_RE.test(text);
    const hasStructuralSection = SUMMARY_OF_HOLDINGS_RE.test(text) || FINANCIAL_TRANSACTIONS_RE.test(text);
    if (!hasFolioIdentity || !hasStructuralSection) {
      confidence = Math.min(confidence, 0.2);
    }
    // A genuine CAS/KFintech title is strong negative evidence against
    // this being a folio-details statement (the two document kinds are
    // never the same PDF) — dampens confidence rather than hard-zeroing,
    // so registry.ts's cross-parser comparison (spec section 10) is what
    // actually decides an ambiguous document, never a unilateral zero-out
    // here.
    if (CAS_TITLE_RE.test(text)) {
      confidence *= 0.3;
      evidence.push('(dampened: genuine CAS/KFintech title evidence also present)');
    }

    confidence = Math.min(confidence, 0.99);
    const detected = confidence >= 0.5;
    return {
      sourceKey: detected ? 'cams' : null,
      confidence,
      documentTypeDetected: detected ? 'cams_folio_details' : null,
      formatVersionDetected: detected ? 'folio_details_v1' : null,
      evidenceMatched: evidence,
    };
  },

  extractMetadata(text: string): ParseMetadata {
    const lines = splitLines(text);
    let statementDate: string | null = null;
    for (const line of lines) {
      const v = extractLabelledField(line.trim(), 'Statement Date');
      if (v !== null) {
        const parsed = parseStatementDate(v);
        statementDate = parsed.ok ? parsed.iso : null;
        break;
      }
    }
    const detection = this.canHandle(text);
    return {
      sourceKey: 'cams',
      sourceConfidence: detection.confidence,
      documentTypeDetected: 'cams_folio_details',
      formatVersionDetected: detection.formatVersionDetected ?? 'folio_details_v1',
      // A folio statement prints ONE as-of statement date, not a period
      // (spec section 8) — start/end are both that same date when known.
      // This is deliberately NOT treated as proof of "complete history
      // from inception" anywhere downstream (reconciliation.ts's
      // `statementCoversFromInception` is derived from actual transaction/
      // opening-balance evidence, never from metadata dates alone).
      statementPeriodStartIso: statementDate,
      statementPeriodEndIso: statementDate,
      statementAsOfDateIso: statementDate,
      extractionMethod: 'pdf_text_native',
    };
  },

  parseAccounts(text: string): ParsedAccountRecord[] {
    const lines = splitLines(text);
    let folio: string | null = null;
    let name: string | null = null;
    let pan: string | null = null;
    const rawBlock: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const f = extractLabelledField(line, 'FOLIO NUMBER');
      if (f !== null) folio = f;
      const n = extractLabelledField(line, 'Name');
      if (n !== null && name === null) name = n;
      const p = extractLabelledField(line, 'PAN');
      if (p !== null) pan = p;
      rawBlock.push(redactPanFromLine(rawLine));
      // Stop scanning the investor/bank preamble once we reach the first
      // structural section heading — everything after this belongs to
      // holdings/SIP/bank/transactions, not the account identity block.
      if (SECTION_HEADING_RE.summaryOfHoldings.test(line) || SECTION_HEADING_RE.financialTransactions.test(line)) break;
    }

    if (folio === null) return [];
    return [
      {
        folioNumber: folio,
        accountNumberMasked: null,
        amcName: '',
        holderName: name,
        panMasked: maskPan(pan),
        jointHolders: [],
        holdingModeRaw: null,
        raw: rawBlock.join('\n'),
      },
    ];
  },

  parseTransactions(text: string, accounts: ParsedAccountRecord[]) {
    const lines = splitLines(text);
    const warnings: ParsedWarning[] = [];
    const transactions: ParsedTransactionRecord[] = [];
    const folioNumber = accounts[0]?.folioNumber ?? null;

    let inFinancialTransactionsSection = false;
    let contaminationReached = false; // one-way latch — spec sections 20/21
    let current: FolioSchemeContext | null = null;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      if (contaminationReached) continue;

      if (SECTION_HEADING_RE.financialTransactionForm.test(line) || SECTION_HEADING_RE.termsAndConditions.test(line)) {
        contaminationReached = true;
        inFinancialTransactionsSection = false;
        current = null;
        continue;
      }
      if (SECTION_HEADING_RE.financialTransactions.test(line)) {
        inFinancialTransactionsSection = true;
        current = null;
        continue;
      }
      if (!inFinancialTransactionsSection) continue;

      // A new scheme header line resets the current scheme AND clears any
      // stale "we're mid-table" assumption — matches camsParser.ts's own
      // discipline (never let one scheme's table leak into the next).
      const schemeHeader = SCHEME_ISIN_HEADER_RE.exec(line);
      if (schemeHeader) {
        current = { scheme: buildScheme(schemeHeader[1].trim(), schemeHeader[2]) };
        continue;
      }
      if (/^DATE\s+TRANSACTION TYPE/i.test(line)) continue; // table header — not data
      if (!current) continue;

      // Opening Balance — NEVER a transaction/purchase (spec section 17).
      // Represented as canonical type 'adjustment' with the sentinel
      // source_reference above, purely so the EXISTING reconciliation
      // engine can sum a known starting position — never consumed as an
      // acquisition by R6 (taxRepository.ts's ACQUISITION_TYPE_MAP
      // excludes 'adjustment' entirely, unchanged by FS1).
      const openingMatch = OPENING_BALANCE_ROW_RE.exec(line);
      if (openingMatch) {
        const [, dateRaw, unitsRaw] = openingMatch;
        const dateParsed = parseStatementDate(dateRaw);
        if (!dateParsed.ok) {
          warnings.push({ code: 'unparseable_date', message: dateParsed.error, severity: 'error', lineHint: idx });
          continue;
        }
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_opening_balance_units', idx);
        if (unitsScaled === null) continue;
        transactions.push({
          folioNumber,
          scheme: current.scheme,
          transactionDateIso: dateParsed.iso,
          rawTransactionTypeText: 'Opening Balance',
          canonicalType: 'adjustment',
          classificationConfidence: 1,
          amountScaled: BigInt(0),
          unitsScaled,
          navScaled: null,
          balanceUnitsAfterScaled: unitsScaled,
          sourceReference: OPENING_BALANCE_SOURCE_REFERENCE,
          sourceDescription: line.slice(0, 500),
        });
        continue;
      }

      const feeMatch = FEE_ROW_RE.exec(line);
      const fullMatch = feeMatch ? null : FULL_TXN_ROW_RE.exec(line);

      if (fullMatch) {
        const [, dateRaw, descRaw, amountRaw, navRaw, priceRaw, unitsRaw, balanceRaw, ref] = fullMatch;
        const dateParsed = parseStatementDate(dateRaw);
        if (!dateParsed.ok) {
          warnings.push({ code: 'unparseable_date', message: dateParsed.error, severity: 'error', lineHint: idx });
          continue;
        }
        const amountScaled = requireScaled(amountRaw, warnings, 'unparseable_amount', idx);
        // NAV and PRICE are both structurally present in this grammar
        // (spec section 18) — PRICE is treated as the authoritative
        // per-unit transaction price (matches the CAS alt-layout's "Price"
        // slot precedent); NAV is retained only informationally and is
        // NOT separately persisted (ParsedTransactionRecord has one
        // navScaled slot) — using PRICE here, never silently averaging or
        // discarding either without a warning if they materially differ.
        const navScaled = requireScaled(navRaw, warnings, 'unparseable_nav', idx);
        const priceScaled = requireScaled(priceRaw, warnings, 'unparseable_price', idx);
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_units', idx);
        const balanceScaled = requireScaled(balanceRaw, warnings, 'unparseable_balance', idx);
        if (amountScaled === null) continue;
        if (navScaled !== null && priceScaled !== null && navScaled !== priceScaled) {
          warnings.push({
            code: 'nav_price_mismatch',
            message: `NAV ("${navRaw}") and PRICE ("${priceRaw}") differ on this row; PRICE is used as the transaction's per-unit value.`,
            severity: 'info',
            lineHint: idx,
          });
        }
        const classification = classifyTransactionType(descRaw.trim());
        if (classification.canonicalType === 'unclassified') {
          warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${descRaw.trim()}"`, severity: 'warning', lineHint: idx });
        }
        transactions.push({
          folioNumber,
          scheme: current.scheme,
          transactionDateIso: dateParsed.iso,
          rawTransactionTypeText: descRaw.trim(),
          canonicalType: classification.canonicalType,
          classificationConfidence: classification.confidence,
          amountScaled,
          unitsScaled,
          navScaled: priceScaled ?? navScaled,
          balanceUnitsAfterScaled: balanceScaled,
          sourceReference: ref ? ref.trim() : null,
          sourceDescription: line.slice(0, 500),
        });
        continue;
      }

      if (feeMatch) {
        const [, dateRaw, feeLabelRaw, amountRaw] = feeMatch;
        const dateParsed = parseStatementDate(dateRaw);
        if (!dateParsed.ok) {
          warnings.push({ code: 'unparseable_date', message: dateParsed.error, severity: 'error', lineHint: idx });
          continue;
        }
        const amountScaled = requireScaled(amountRaw, warnings, 'unparseable_amount', idx);
        if (amountScaled === null) continue;
        const classification = classifyTransactionType(feeLabelRaw.trim());
        if (classification.canonicalType === 'unclassified') {
          warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${feeLabelRaw.trim()}"`, severity: 'warning', lineHint: idx });
        }
        transactions.push({
          folioNumber,
          scheme: current.scheme,
          transactionDateIso: dateParsed.iso,
          rawTransactionTypeText: feeLabelRaw.trim(),
          canonicalType: classification.canonicalType,
          classificationConfidence: classification.confidence,
          amountScaled,
          unitsScaled: BigInt(0), // this row shape never carries units — a structural fact, never an unparsed/missing value (matches camsParser.ts's certified ALT_FEE_ROW_RE precedent)
          navScaled: null,
          balanceUnitsAfterScaled: null,
          sourceReference: null,
          sourceDescription: line.slice(0, 500),
        });
        continue;
      }

      if (line.length === 0) continue;
      // A closing/no-activity/footer line for this scheme's table, or
      // genuinely unparseable row — never silently dropped.
      if (/^(Closing|Total|No transactions?)/i.test(line)) continue;
      warnings.push({ code: 'unparseable_transaction_row', message: `Could not parse transaction row: "${line}"`, severity: 'error', lineHint: idx });
    }
    return { transactions, warnings };
  },

  parseHoldings(text: string, accounts: ParsedAccountRecord[]) {
    const lines = splitLines(text);
    const warnings: ParsedWarning[] = [];
    const holdings: ParsedHoldingRecord[] = [];
    const folioNumber = accounts[0]?.folioNumber ?? null;

    let inSummarySection = false;
    let contaminationReached = false;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      if (contaminationReached) continue;

      if (SECTION_HEADING_RE.financialTransactionForm.test(line) || SECTION_HEADING_RE.termsAndConditions.test(line)) {
        contaminationReached = true;
        inSummarySection = false;
        continue;
      }
      if (SECTION_HEADING_RE.summaryOfHoldings.test(line)) {
        inSummarySection = true;
        continue;
      }
      if (SECTION_HEADING_RE.sipRegistration.test(line) || SECTION_HEADING_RE.multipleBankDetails.test(line) || SECTION_HEADING_RE.financialTransactions.test(line)) {
        inSummarySection = false;
        continue;
      }
      if (!inSummarySection) continue;
      if (/^Scheme Name\s+Cost/i.test(line)) continue; // table header

      const m = HOLDING_ROW_RE.exec(line);
      if (!m) {
        if (line.length === 0) continue;
        warnings.push({ code: 'unparseable_holding_row', message: `Could not parse Summary of Holdings row: "${line}"`, severity: 'error', lineHint: idx });
        continue;
      }
      const [, schemeNameRaw, , unitsRaw, navDateRaw, navRaw, valueRaw] = m;
      const navDateParsed = parseStatementDate(navDateRaw);
      if (!navDateParsed.ok) {
        warnings.push({ code: 'unparseable_closing_date', message: navDateParsed.error, severity: 'error', lineHint: idx });
        continue;
      }
      const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_closing_units', idx);
      if (unitsScaled === null) continue;
      const valueScaled = requireScaled(valueRaw, warnings, 'unparseable_closing_value', idx);
      const navScaled = requireScaled(navRaw, warnings, 'unparseable_closing_nav', idx);

      holdings.push({
        folioNumber,
        scheme: buildScheme(schemeNameRaw.trim(), null), // ISIN comes from the Financial Transactions section header, not here — schemeResolution.ts still resolves this scheme by normalised name/AMC when the two blocks describe the same scheme (spec section 15); an ISIN-bearing transaction for the same normalised name/plan/option resolves to the identical instrument
        asOfDateIso: navDateParsed.iso,
        unitsScaled,
        valueScaled,
        navScaled,
      });
    }
    return { holdings, warnings };
  },

  validateParsedOutput(output: ParsedDocumentOutput): ValidationOutcome {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (output.accounts.length === 0) errors.push('No folio/account found in document.');
    if (output.holdings.length === 0) warnings.push('No Summary of Holdings entries found in document.');
    for (const t of output.transactions) {
      if (!t.folioNumber) errors.push(`Transaction on ${t.transactionDateIso} has no resolvable folio.`);
    }
    return { ok: errors.length === 0, errors, warnings };
  },
};
