// Investment Intelligence R2 — CAMS detailed mutual-fund CAS parser adapter.
//
// Target layout (documented exactly in R2_SUPPORTED_CAS_FORMATS.md and
// matched precisely by every CAMS-* golden fixture in
// lib/fixtures/investment-intelligence/r2-cas/cams/):
//
//   CAMS Consolidated Account Statement
//   Statement Period : DD-MMM-YYYY To DD-MMM-YYYY
//
//   Folio No: <folio>
//   PAN: <pan-or-masked-pan>
//   Name: <holder name>
//   Holding Mode: <SI|JO|AS>
//
//   AMC Name: <amc>
//   Scheme Name: <scheme name incl. plan/option>
//   ISIN: <isin-or-blank>
//   AMFI Code: <code-or-blank>
//   Registrar: CAMS
//
//   Date          Description                    Amount(Rs.)   Units    NAV(Rs.)   Unit Balance
//   DD-MMM-YYYY   <description>                   <amount>      <units>  <nav>      <balance>   [Ref: <ref>]
//   ...
//
//   Closing Unit Balance as on DD-MMM-YYYY : <units> Units   Valuation : Rs. <value>   NAV as on DD-MMM-YYYY : Rs. <nav>
//
// (Folio/AMC/Scheme blocks repeat for multi-folio, multi-AMC, multi-scheme
// statements — spec section 36 coverage.)

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

export const CAMS_PARSER_CODE = 'cams_detailed_v1' as const;
export const CAMS_PARSER_VERSION = '1.0.0';

const TITLE_RE = /CAMS\s+Consolidated\s+Account\s+Statement/i;
const REGISTRAR_RE = /^Registrar\s*:\s*CAMS\s*$/im;

const TXN_ROW_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

const CLOSING_RE =
  /^Closing Unit Balance as on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*Units\s+Valuation\s*:\s*(?:Rs\.?|₹)\s*(\(?-?[\d,]+\.\d+\)?)(?:\s+NAV as on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(?:Rs\.?|₹)\s*(\(?-?[\d,]+\.\d+\)?))?\s*$/;

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

export const camsParser: InvestmentDocumentParser = {
  parserCode: CAMS_PARSER_CODE,
  parserVersion: CAMS_PARSER_VERSION,
  supportedSource: 'cams',
  supportedDocumentType: 'cas_statement',

  canHandle(text: string): SourceDetectionResult {
    const evidence: string[] = [];
    let confidence = 0;
    if (TITLE_RE.test(text)) {
      confidence += 0.55;
      evidence.push('Title line "CAMS Consolidated Account Statement" found');
    }
    const registrarMatches = text.match(new RegExp(REGISTRAR_RE, 'gim'));
    if (registrarMatches && registrarMatches.length > 0) {
      confidence += Math.min(0.44, 0.2 + registrarMatches.length * 0.05);
      evidence.push(`${registrarMatches.length} "Registrar: CAMS" line(s) found`);
    }
    confidence = Math.min(confidence, 0.99);
    return {
      sourceKey: confidence >= 0.5 ? 'cams' : null,
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
      const m = /^Statement Period\s*:\s*(\d{1,2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*$/i.exec(line.trim());
      if (m) {
        const s = parseStatementDate(m[1]);
        const e = parseStatementDate(m[2]);
        periodStart = s.ok ? s.iso : null;
        periodEnd = e.ok ? e.iso : null;
        break;
      }
    }
    return {
      sourceKey: 'cams',
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
          const n = extractLabelledField(lines[j], 'Name');
          if (n !== null) name = n;
          const hm = extractLabelledField(lines[j], 'Holding Mode');
          if (hm !== null) holdingMode = hm;
          j++;
        }
        accounts.push({
          folioNumber: folio,
          accountNumberMasked: null,
          amcName: '', // filled per-scheme, not per-folio, in CAMS's layout — accounts here represent the FOLIO shell; institution comes from each scheme block
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
      // Live-DEV closure finding (R11-FINAL round, 2026-08-25): "AMC Name:"
      // and "Scheme Name:" are always on SEPARATE lines in every real CAMS
      // statement (see the format documented at the top of this file) —
      // `amc` must be captured and applied to `lastKnownAmcName`
      // unconditionally, on its OWN line, not gated behind the SAME
      // iteration's `schemeName` check (which is null on the AMC-Name line
      // itself, and `amc` is null again on the Scheme-Name line by the time
      // that check runs) — the previous code silently left
      // `lastKnownAmcName` at its initial `''` for every real statement,
      // and no existing golden-fixture test caught it because none asserted
      // on parsed `scheme.amcName`/downstream `institution_name` for a
      // real multi-line statement. Confirmed live: this caused two
      // independently-derived accounts for the identical (institution,
      // folio) pair to resolve to different `ii_accounts` rows, breaking
      // R11 cross-source matching for anything that (correctly) supplies a
      // real institution name, e.g. a manual-source fixture.
      // II-PC3 finding (Q09 multi-page-continuation probe, 2026-09-04): an
      // `AMC Name:` line did NOT reset `inTable`, only `Folio No:`/
      // `Scheme Name:`/the closing-balance line did. Every scheme block
      // begins with `AMC Name:` BEFORE its own `Scheme Name:` line (this
      // file's own documented layout, top of file) — so any time a
      // PRECEDING scheme's transaction table had not yet been closed by a
      // `Closing Unit Balance` line when the next scheme's `AMC Name:` line
      // is reached (a real continuation-page header reprint before its
      // `Closing Unit Balance` line appears on the next page, OR a scheme
      // whose statement omits a closing-balance line entirely, e.g. a
      // fully-redeemed zero-balance holding some RTAs print without one),
      // `inTable` was still `true` and the `AMC Name:` line itself was
      // wrongly fed to `TXN_ROW_RE`, always failing it and raising a false
      // `unparseable_transaction_row` error for a perfectly valid document.
      // Reset here too, matching `Folio No:`/`Scheme Name:`'s existing
      // pattern exactly — an `AMC Name:` line can never itself be a
      // transaction row.
      const amc = extractLabelledField(line, 'AMC Name');
      if (amc) {
        lastKnownAmcName = amc;
        inTable = false;
        continue;
      }
      const schemeName = extractLabelledField(line, 'Scheme Name');
      if (schemeName !== null) {
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
      if (/^Date\s+Description\s+Amount/i.test(line)) {
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
      // Live-DEV closure finding (R11-FINAL round, 2026-08-25): "AMC Name:"
      // and "Scheme Name:" are always on SEPARATE lines in every real CAMS
      // statement (see the format documented at the top of this file) —
      // `amc` must be captured and applied to `lastKnownAmcName`
      // unconditionally, on its OWN line, not gated behind the SAME
      // iteration's `schemeName` check (which is null on the AMC-Name line
      // itself, and `amc` is null again on the Scheme-Name line by the time
      // that check runs) — the previous code silently left
      // `lastKnownAmcName` at its initial `''` for every real statement,
      // and no existing golden-fixture test caught it because none asserted
      // on parsed `scheme.amcName`/downstream `institution_name` for a
      // real multi-line statement. Confirmed live: this caused two
      // independently-derived accounts for the identical (institution,
      // folio) pair to resolve to different `ii_accounts` rows, breaking
      // R11 cross-source matching for anything that (correctly) supplies a
      // real institution name, e.g. a manual-source fixture.
      const amc = extractLabelledField(line, 'AMC Name');
      if (amc) lastKnownAmcName = amc;
      const schemeName = extractLabelledField(line, 'Scheme Name');
      if (schemeName !== null) {
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
        const [, asOfRaw, unitsRaw, valueRaw, navAsOfRaw, navRaw] = m;
        const asOf = parseStatementDate(asOfRaw);
        if (!asOf.ok) {
          warnings.push({ code: 'unparseable_closing_date', message: asOf.error, severity: 'error', lineHint: idx });
          continue;
        }
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_closing_units');
        if (unitsScaled === null) continue;
        const valueScaled = valueRaw ? requireScaled(valueRaw, warnings, 'unparseable_closing_value') : null;
        const navScaled = navRaw ? requireScaled(navRaw, warnings, 'unparseable_closing_nav') : null;
        void navAsOfRaw;
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
