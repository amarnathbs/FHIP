// Investment Intelligence R2 — KFintech detailed mutual-fund CAS parser
// adapter. Deliberately NOT sharing regexes with camsParser.ts — KFintech's
// real-world statement layout differs from CAMS's (different labels,
// DD/MM/YYYY dates rather than DD-MMM-YYYY, different column headings) and
// this synthetic-but-structurally-faithful fixture format mirrors that
// (spec sections 39-40: "CAMS and KFintech formats are NOT identical —
// test both independently").
//
// Target layout (documented exactly in R2_SUPPORTED_CAS_FORMATS.md and
// matched precisely by every KFIN-* golden fixture in
// lib/fixtures/investment-intelligence/r2-cas/kfintech/):
//
//   KFINTECH Consolidated Account Statement
//   Period : DD/MM/YYYY to DD/MM/YYYY
//
//   Folio No : <folio>
//   PAN : <pan-or-masked-pan>
//   Investor Name : <holder name>
//   Mode of Holding : <Single|Joint|Anyone or Survivor>
//
//   AMC Name : <amc>
//   Scheme : <scheme name incl. plan/option>
//   ISIN : <isin-or-blank>
//   AMFI Code : <code-or-blank>
//   RTA : KFINTECH
//
//   Txn Date     Transaction Type            Amount        Units      Price(NAV)   Balance Units
//   DD/MM/YYYY   <description>                <amount>      <units>    <nav>        <balance>   [Ref: <ref>]
//   ...
//
//   Closing Balance : <units> units as on DD/MM/YYYY   Market Value : Rs <value>   NAV : Rs <nav>

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

export const KFINTECH_PARSER_CODE = 'kfintech_detailed_v1' as const;
export const KFINTECH_PARSER_VERSION = '1.0.0';

const TITLE_RE = /KFINTECH\s+Consolidated\s+Account\s+Statement/i;
const RTA_RE = /^RTA\s*:\s*KFINTECH\s*$/im;

const TXN_ROW_RE =
  /^(\d{1,2}\/\d{1,2}\/\d{4})\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

const CLOSING_RE =
  /^Closing Balance\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*units as on (\d{1,2}\/\d{1,2}\/\d{4})\s+Market Value\s*:\s*(?:Rs\.?|₹)\s*(\(?-?[\d,]+\.\d+\)?)(?:\s+NAV\s*:\s*(?:Rs\.?|₹)\s*(\(?-?[\d,]+\.\d+\)?))?\s*$/;

function requireScaled(raw: string, warnings: ParsedWarning[], code: string): bigint | null {
  const parsed = parseExactDecimal(raw);
  if (!parsed.ok) {
    warnings.push({ code, message: `Could not parse numeric value "${raw}": ${parsed.error}`, severity: 'error' });
    return null;
  }
  if (parsed.roundedFromHigherPrecision) {
    warnings.push({ code: `${code}_rounded`, message: `Value "${raw}" had more than 6 fractional digits and was rounded.`, severity: 'info' });
  }
  return parsed.scaled;
}

export const kfintechParser: InvestmentDocumentParser = {
  parserCode: KFINTECH_PARSER_CODE,
  parserVersion: KFINTECH_PARSER_VERSION,
  supportedSource: 'kfintech',
  supportedDocumentType: 'cas_statement',

  canHandle(text: string): SourceDetectionResult {
    const evidence: string[] = [];
    let confidence = 0;
    if (TITLE_RE.test(text)) {
      confidence += 0.55;
      evidence.push('Title line "KFINTECH Consolidated Account Statement" found');
    }
    const rtaMatches = text.match(new RegExp(RTA_RE, 'gim'));
    if (rtaMatches && rtaMatches.length > 0) {
      confidence += Math.min(0.44, 0.2 + rtaMatches.length * 0.05);
      evidence.push(`${rtaMatches.length} "RTA : KFINTECH" line(s) found`);
    }
    confidence = Math.min(confidence, 0.99);
    return {
      sourceKey: confidence >= 0.5 ? 'kfintech' : null,
      confidence,
      documentTypeDetected: confidence >= 0.5 ? 'cas_statement' : null,
      formatVersionDetected: confidence >= 0.5 ? 'detailed_v1' : null,
      evidenceMatched: evidence,
    };
  },

  extractMetadata(text: string): ParseMetadata {
    const lines = splitLines(text);
    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    for (const line of lines) {
      const m = /^Period\s*:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})\s*$/i.exec(line.trim());
      if (m) {
        const s = parseStatementDate(m[1]);
        const e = parseStatementDate(m[2]);
        periodStart = s.ok ? s.iso : null;
        periodEnd = e.ok ? e.iso : null;
        break;
      }
    }
    return {
      sourceKey: 'kfintech',
      sourceConfidence: this.canHandle(text).confidence,
      documentTypeDetected: 'cas_statement',
      formatVersionDetected: 'detailed_v1',
      statementPeriodStartIso: periodStart,
      statementPeriodEndIso: periodEnd,
      statementAsOfDateIso: periodEnd,
      extractionMethod: 'pdf_text_native',
    };
  },

  parseAccounts(text: string): ParsedAccountRecord[] {
    const lines = splitLines(text);
    const accounts: ParsedAccountRecord[] = [];
    let i = 0;
    while (i < lines.length) {
      const folio = extractLabelledField(lines[i], 'Folio No');
      if (folio !== null) {
        const blockLines = [lines[i]];
        let pan: string | null = null;
        let name: string | null = null;
        let holdingMode: string | null = null;
        let j = i + 1;
        while (j < lines.length && !extractLabelledField(lines[j], 'Folio No') && !extractLabelledField(lines[j], 'AMC Name')) {
          // PAN redacted before retention (see textUtils.ts's
          // redactPanFromLine doc comment — spec sections 16/34).
          blockLines.push(redactPanFromLine(lines[j]));
          const p = extractLabelledField(lines[j], 'PAN');
          if (p !== null) pan = p;
          const n = extractLabelledField(lines[j], 'Investor Name');
          if (n !== null) name = n;
          const hm = extractLabelledField(lines[j], 'Mode of Holding');
          if (hm !== null) holdingMode = hm;
          j++;
        }
        accounts.push({
          folioNumber: folio,
          accountNumberMasked: null,
          amcName: '',
          holderName: name,
          panMasked: maskPan(pan),
          jointHolders: [],
          holdingModeRaw: holdingMode,
          raw: blockLines.join('\n'),
        });
      }
      i++;
    }
    return accounts;
  },

  parseTransactions(text: string, accounts: ParsedAccountRecord[]) {
    const lines = splitLines(text);
    const warnings: ParsedWarning[] = [];
    const transactions: ParsedTransactionRecord[] = [];

    let currentFolio: string | null = accounts[0]?.folioNumber ?? null;
    let currentScheme: ParsedInstrumentRecord | null = null;
    let lastKnownAmcName = '';
    let inTable = false;

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      const folio = extractLabelledField(line, 'Folio No');
      if (folio !== null) {
        currentFolio = folio;
        inTable = false;
        continue;
      }
      const amc = extractLabelledField(line, 'AMC Name');
      const schemeName = extractLabelledField(line, 'Scheme');
      if (schemeName !== null) {
        if (amc) lastKnownAmcName = amc;
        currentScheme = {
          rawSchemeName: schemeName,
          normalisedSchemeName: normaliseSchemeName(schemeName),
          amcName: lastKnownAmcName,
          planType: detectPlanType(schemeName),
          optionType: detectOptionType(schemeName),
          isin: null,
          amfiSchemeCode: null,
        };
        inTable = false;
        continue;
      }
      {
        const scheme: ParsedInstrumentRecord | null = currentScheme;
        if (scheme) {
          const isinValue = extractLabelledField(line, 'ISIN');
          if (isinValue !== null) {
            const updated: ParsedInstrumentRecord = { ...scheme, isin: isinValue.length > 0 ? isinValue : null };
            currentScheme = updated;
            continue;
          }
          const amfiValue = extractLabelledField(line, 'AMFI Code');
          if (amfiValue !== null) {
            const updated: ParsedInstrumentRecord = { ...scheme, amfiSchemeCode: amfiValue.length > 0 ? amfiValue : null };
            currentScheme = updated;
            continue;
          }
        }
      }
      if (/^Txn Date\s+Transaction Type\s+Amount/i.test(line)) {
        inTable = true;
        continue;
      }
      if (CLOSING_RE.test(line)) {
        inTable = false;
        continue;
      }
      if (inTable && line.length > 0 && currentScheme) {
        const m = TXN_ROW_RE.exec(line);
        if (!m) {
          warnings.push({ code: 'unparseable_transaction_row', message: `Could not parse transaction row: "${line}"`, severity: 'error', lineHint: idx });
          continue;
        }
        const [, dateRaw, descRaw, amountRaw, unitsRaw, navRaw, balanceRaw, ref] = m;
        const dateParsed = parseStatementDate(dateRaw);
        if (!dateParsed.ok) {
          warnings.push({ code: 'unparseable_date', message: dateParsed.error, severity: 'error', lineHint: idx });
          continue;
        }
        const amountScaled = requireScaled(amountRaw, warnings, 'unparseable_amount');
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_units');
        const navScaled = requireScaled(navRaw, warnings, 'unparseable_nav');
        const balanceScaled = requireScaled(balanceRaw, warnings, 'unparseable_balance');
        if (amountScaled === null) continue;
        const classification = classifyTransactionType(descRaw.trim());
        if (classification.canonicalType === 'unclassified') {
          warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${descRaw.trim()}"`, severity: 'warning', lineHint: idx });
        }
        transactions.push({
          folioNumber: currentFolio,
          scheme: currentScheme,
          transactionDateIso: dateParsed.iso,
          rawTransactionTypeText: descRaw.trim(),
          canonicalType: classification.canonicalType,
          classificationConfidence: classification.confidence,
          amountScaled,
          unitsScaled,
          navScaled,
          balanceUnitsAfterScaled: balanceScaled,
          sourceReference: ref ? ref.trim() : null,
          sourceDescription: line.slice(0, 500),
        });
      }
    }
    return { transactions, warnings };
  },

  parseHoldings(text: string, accounts: ParsedAccountRecord[]) {
    const lines = splitLines(text);
    const warnings: ParsedWarning[] = [];
    const holdings: ParsedHoldingRecord[] = [];

    let currentFolio: string | null = accounts[0]?.folioNumber ?? null;
    let currentScheme: ParsedInstrumentRecord | null = null;
    let lastKnownAmcName = '';

    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx].trim();
      const folio = extractLabelledField(line, 'Folio No');
      if (folio !== null) {
        currentFolio = folio;
        continue;
      }
      const amc = extractLabelledField(line, 'AMC Name');
      const schemeName = extractLabelledField(line, 'Scheme');
      if (schemeName !== null) {
        if (amc) lastKnownAmcName = amc;
        currentScheme = {
          rawSchemeName: schemeName,
          normalisedSchemeName: normaliseSchemeName(schemeName),
          amcName: lastKnownAmcName,
          planType: detectPlanType(schemeName),
          optionType: detectOptionType(schemeName),
          isin: null,
          amfiSchemeCode: null,
        };
        continue;
      }
      {
        const scheme: ParsedInstrumentRecord | null = currentScheme;
        if (scheme) {
          const isinValue = extractLabelledField(line, 'ISIN');
          if (isinValue !== null) {
            const updated: ParsedInstrumentRecord = { ...scheme, isin: isinValue.length > 0 ? isinValue : null };
            currentScheme = updated;
            continue;
          }
          const amfiValue = extractLabelledField(line, 'AMFI Code');
          if (amfiValue !== null) {
            const updated: ParsedInstrumentRecord = { ...scheme, amfiSchemeCode: amfiValue.length > 0 ? amfiValue : null };
            currentScheme = updated;
            continue;
          }
        }
      }
      const m = CLOSING_RE.exec(line);
      if (m && currentScheme) {
        const [, unitsRaw, asOfRaw, valueRaw, navRaw] = m;
        const asOf = parseStatementDate(asOfRaw);
        if (!asOf.ok) {
          warnings.push({ code: 'unparseable_closing_date', message: asOf.error, severity: 'error', lineHint: idx });
          continue;
        }
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_closing_units');
        if (unitsScaled === null) continue;
        const valueScaled = valueRaw ? requireScaled(valueRaw, warnings, 'unparseable_closing_value') : null;
        const navScaled = navRaw ? requireScaled(navRaw, warnings, 'unparseable_closing_nav') : null;
        holdings.push({
          folioNumber: currentFolio,
          scheme: currentScheme,
          asOfDateIso: asOf.iso,
          unitsScaled,
          valueScaled,
          navScaled,
        });
      }
    }
    return { holdings, warnings };
  },

  validateParsedOutput(output: ParsedDocumentOutput): ValidationOutcome {
    const errors: string[] = [];
    const warnings: string[] = [];
    if (output.accounts.length === 0) errors.push('No folio/account found in document.');
    if (output.holdings.length === 0) warnings.push('No closing holdings found in document.');
    if (output.metadata.statementPeriodStartIso && output.metadata.statementPeriodEndIso) {
      if (output.metadata.statementPeriodStartIso > output.metadata.statementPeriodEndIso) {
        errors.push('Statement period start is after statement period end.');
      }
    }
    for (const t of output.transactions) {
      if (!t.folioNumber) errors.push(`Transaction on ${t.transactionDateIso} has no resolvable folio.`);
    }
    return { ok: errors.length === 0, errors, warnings };
  },
};
