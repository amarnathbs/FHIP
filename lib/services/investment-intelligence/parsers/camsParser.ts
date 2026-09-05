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
//
// II-PC3 Gate A addition (docs/investment-intelligence/
// II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md): a genuine SECOND real-world
// CAMS layout variant exists, alongside the "detailed_v1" grammar above
// (never replacing it — every ALT_* construct below is additive):
//
//   <tracking/version-stamp line containing "CAMS" only as a substring>
//   Consolidated Account Statement
//   Statement Period : DD-MMM-YYYY To DD-MMM-YYYY
//
//   Folio No: <folio>
//   PAN: <pan-or-masked-pan>
//   (no Name:/Holding Mode: lines — genuinely absent in this layout)
//
//   <scheme name incl. plan/option> - ISIN: <isin-or-blank>(Advisor: <code>) Registrar : CAMS
//
//   Date          Amount           Price        Units       Transaction Type   Unit Balance
//   DD-MMM-YYYY   <amount>         <price>      <units>     <description>      <balance>   [Ref: <ref>]
//   ...
//   OR, for a folio/scheme with zero activity this period:
//   No transactions during this statement period.
//
//   Closing Unit Balance: <units> Total Cost Value: Rs. <value>
//
// This variant is detected/parsed alongside "detailed_v1" (never gating
// it out) — see every ALT_* regex/branch below, each traced directly to
// the numbered finding in II_PC3_GATE_A_REAL_STRUCTURAL_COMPARISON.md it
// closes. Built entirely from that document's own already-abstracted
// structural facts (zero real values) — see
// lib/fixtures/investment-intelligence/pc3-cams/pc3-q11-alternate-cams-layout.*
// for the synthetic fixture this was verified against.
//
// Deliberately OUT OF SCOPE for this fix (disclosed, not silently
// dropped): AMC/fund-house identity is not derivable from a labelled line
// in this layout at all (Gate A finding #3) — it only appears in a
// page-1 portfolio-summary table this narrow fix does not attempt to
// cross-reference. `amcName` for an ALT-layout scheme therefore remains
// `''`, the same default every scheme already carries before its first
// "AMC Name:" line under the original grammar — this is an honest,
// pre-existing "unknown" value, not a new miscategorisation.

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

// --- II-PC3 Gate A: alternate CAMS layout variant (additive only) -------
// See the file-header comment above for the full grammar this closes.

// Finding #1: title fragments on separate, non-adjacent lines — a
// standalone "Consolidated Account Statement" line, with "CAMS" appearing
// only as a substring elsewhere (a tracking/version-stamp line, or the
// alt-layout registrar occurrence below), never immediately adjacent.
const TITLE_ALT_LINE_RE = /^\s*Consolidated Account Statement\s*$/im;

// Finding #5 (registrar half): "Registrar : CAMS" occurs folded into the
// combined scheme-heading line (see ALT_SCHEME_LINE_RE), not as its own
// standalone line — REGISTRAR_RE's `^...$` anchoring cannot match that.
const ALT_REGISTRAR_RE = /Registrar\s*:\s*CAMS\b/i;

// Finding #5: scheme/plan/option text, ISIN, and an "Advisor" (distributor/
// ARN) code — NOT an AMFI scheme code, genuinely absent in this layout —
// folded onto one free-text line together with the registrar, e.g.:
//   "<scheme name incl. plan/option> - ISIN: <isin-or-blank>(Advisor: <code>) Registrar : CAMS"
const ALT_SCHEME_LINE_RE =
  /^(.+?)\s*-\s*ISIN\s*:\s*([A-Z0-9]*)\s*\(\s*Advisor\s*:\s*([^)]*)\)\s*Registrar\s*:\s*CAMS\s*$/i;

// Finding #6: alternate transaction-table header — column order
// Date/Amount/Price/Units/Transaction-type, no separate Description column.
const ALT_TXN_HEADER_RE = /^Date\s+Amount\s+Price\s*Units?\s*Transaction/i;

// Finding #6: alternate transaction-row grammar matching the header above.
// "Price" occupies this layout's NAV-equivalent slot; the trailing numeric
// field is this layout's running Unit Balance (Gate A's literal header
// extraction showed a truncated "...Unit" column after "Transaction").
const ALT_TXN_ROW_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

// Finding #9: "Closing Unit Balance: X Total Cost Value: Y" — no "as on"/
// "Valuation"/"NAV as on" clause anywhere, and critically, NO DATE at all
// (unlike CLOSING_RE, which always captures an explicit as-of date).
const ALT_CLOSING_RE =
  /^Closing Unit Balance\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*(?:Units)?\s+Total Cost Value\s*:\s*(?:Rs\.?|₹)\s*(\(?-?[\d,]+\.\d+\)?)\s*$/i;

// II-PC3-C1 real-variant fingerprint, section 8/9
// (docs/investment-intelligence/II_PC3_REAL_CAMS_VARIANT_FINGERPRINT.md):
// Stamp Duty / STT rows are a materially SHORTER, standalone row shape —
// Date + Amount + a type label only. NO Price, Units, or trailing Unit
// Balance field exists on this row at all, unlike ALT_TXN_ROW_RE's full
// 6-field shape (confirmed by directly counting tokens against adjacent
// full economic rows sharing the same date in the real statement — 5
// tokens vs 10-11). The amount is sometimes immediately followed, with no
// separating space, by a non-numeric footnote/disclosure-note marker
// glyph, which `\S*` absorbs without treating it as part of the numeric
// value. Tried only after ALT_TXN_ROW_RE fails, never instead of it, so
// every other row shape is completely unaffected. STT itself was never
// observed as a materialized row in the real sample inspected (it appears
// exactly once, in disclosure/footer prose, not as transaction data) —
// this pattern is deliberately written to also recognise STT, on the
// disclosed INFERENCE (not direct observation) that a real STT row, if
// one is ever materialized, shares Stamp Duty's row grammar, since both
// are the same class of SEBI-mandated transaction-level charge described
// with the same "deducted at the date of transaction" framing in that
// statement's own footer text.
const ALT_FEE_ROW_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\S*\s+(Stamp\s+Duty|Securities\s+Transaction\s+Tax|STT)\b.*$/i;

// Finding #12: a fixed placeholder sentence in place of a transaction
// table for a folio/scheme with zero activity this period. The exact real
// wording was never captured (Gate A's own zero-real-value discipline) —
// this is a deliberately conservative structural pattern: it must parse
// as "this scheme had zero transactions," never a parse error.
const NO_ACTIVITY_RE = /^No transactions? (?:for|during|in) (?:the|this) (?:statement )?period\.?\s*$/i;

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
    let isAltLayout = false;
    if (TITLE_RE.test(text)) {
      confidence += 0.55;
      evidence.push('Title line "CAMS Consolidated Account Statement" found');
    } else if (TITLE_ALT_LINE_RE.test(text) && /CAMS/i.test(text)) {
      // II-PC3 Gate A finding #1: the two title fragments are never
      // adjacent in this layout — a standalone "Consolidated Account
      // Statement" line, corroborated by a "CAMS" occurrence elsewhere in
      // the document (a tracking-code substring and/or the alt-layout
      // registrar occurrence below), rather than one exact phrase.
      isAltLayout = true;
      confidence += 0.5;
      evidence.push('Alternate title layout: standalone "Consolidated Account Statement" line, corroborated by a "CAMS" occurrence elsewhere in the document');
    }
    const registrarMatches = text.match(new RegExp(REGISTRAR_RE, 'gim'));
    if (registrarMatches && registrarMatches.length > 0) {
      confidence += Math.min(0.44, 0.2 + registrarMatches.length * 0.05);
      evidence.push(`${registrarMatches.length} "Registrar: CAMS" line(s) found`);
    } else {
      const altRegistrarMatches = text.match(new RegExp(ALT_REGISTRAR_RE, 'gi'));
      if (altRegistrarMatches && altRegistrarMatches.length > 0) {
        isAltLayout = true;
        confidence += Math.min(0.44, 0.2 + altRegistrarMatches.length * 0.05);
        evidence.push(`${altRegistrarMatches.length} alternate-layout "Registrar : CAMS" occurrence(s) found (folded into the scheme-heading line)`);
      }
    }
    confidence = Math.min(confidence, 0.99);
    const detected = confidence >= 0.5;
    return {
      sourceKey: detected ? 'cams' : null,
      confidence,
      documentTypeDetected: detected ? 'cas_statement' : null,
      formatVersionDetected: detected ? (isAltLayout ? 'detailed_v1_alt_layout' : 'detailed_v1') : null,
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
    const detection = this.canHandle(text);
    return {
      sourceKey: 'cams',
      sourceConfidence: detection.confidence,
      documentTypeDetected: 'cas_statement',
      formatVersionDetected: detection.formatVersionDetected ?? 'detailed_v1',
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
      // II-PC3 Gate A finding #5: no "Scheme Name:"/"AMFI Code:" labels
      // exist in the alternate layout at all — scheme name, ISIN, and an
      // "Advisor" (distributor) code are folded onto one free-text line
      // instead. `amfiSchemeCode` is deliberately left `null` here, not a
      // silent drop: the Advisor code is a genuinely different field
      // (distributor/ARN, not an AMFI scheme code) that this parser's
      // output contract has no matching column for — see the file-header
      // comment's "deliberately out of scope" note for `amcName` for the
      // same disclosed-gap discipline applied to this parenthetical.
      const altScheme = ALT_SCHEME_LINE_RE.exec(line);
      if (altScheme) {
        const rawName = altScheme[1].trim();
        const isinValue = altScheme[2];
        currentScheme = {
          rawSchemeName: rawName,
          normalisedSchemeName: normaliseSchemeName(rawName),
          amcName: lastKnownAmcName,
          planType: detectPlanType(rawName),
          optionType: detectOptionType(rawName),
          isin: isinValue && isinValue.length > 0 ? isinValue : null,
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
      // II-PC3 Gate A finding #6: alternate table header — column order
      // Date/Amount/Price/Units/Transaction-type, no Description column.
      if (ALT_TXN_HEADER_RE.test(line)) {
        inTable = true;
        continue;
      }
      // II-PC3 Gate A finding #12: a "no activity this period" placeholder
      // — this scheme genuinely has zero transactions, never a parse
      // error. (Already a structural no-op today since no header line
      // preceded it to set `inTable`, but matched explicitly, defensively,
      // and documented — the same discipline as the Folio No:/Scheme
      // Name:/AMC Name: resets above, per this file's own prior
      // R11-FINAL/Q09 `inTable`-reset defects.)
      if (NO_ACTIVITY_RE.test(line)) {
        inTable = false;
        continue;
      }
      if (CLOSING_RE.test(line) || ALT_CLOSING_RE.test(line)) {
        inTable = false;
        continue;
      }
      if (inTable && line.length > 0 && currentScheme) {
        const m = TXN_ROW_RE.exec(line);
        if (m) {
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
          continue;
        }
        // II-PC3 Gate A finding #6 (alternate row grammar): Date, Amount,
        // Price, Units, Transaction-type/description, trailing Unit
        // Balance — no Description column. Attempted only after the
        // primary TXN_ROW_RE fails, never instead of it, so Q01-Q10's
        // grammar is completely unaffected.
        const am = ALT_TXN_ROW_RE.exec(line);
        if (!am) {
          // II-PC3-C1 real-variant fingerprint section 8/9: a real Stamp
          // Duty/STT row structurally lacks the Price/Units/Balance fields
          // ALT_TXN_ROW_RE requires — attempted only after that full-row
          // grammar fails, never instead of it.
          const feeMatch = ALT_FEE_ROW_RE.exec(line);
          if (feeMatch) {
            const [, feeDateRaw, feeAmountRaw, feeTypeLabel] = feeMatch;
            const feeDateParsed = parseStatementDate(feeDateRaw);
            if (!feeDateParsed.ok) {
              warnings.push({ code: 'unparseable_date', message: feeDateParsed.error, severity: 'error', lineHint: idx });
              continue;
            }
            const feeAmountScaled = requireScaled(feeAmountRaw, warnings, 'unparseable_amount');
            if (feeAmountScaled === null) continue;
            const feeClassification = classifyTransactionType(feeTypeLabel.trim());
            if (feeClassification.canonicalType === 'unclassified') {
              warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${feeTypeLabel.trim()}"`, severity: 'warning', lineHint: idx });
            }
            transactions.push({
              folioNumber: currentFolio,
              scheme: currentScheme,
              transactionDateIso: feeDateParsed.iso,
              rawTransactionTypeText: feeTypeLabel.trim(),
              canonicalType: feeClassification.canonicalType,
              classificationConfidence: feeClassification.confidence,
              amountScaled: feeAmountScaled,
              unitsScaled: BigInt(0), // this row shape never carries units — a real, structural fact (fee/tax rows have no unit impact), never an unparsed/missing value
              navScaled: null, // no Price field exists on this row shape at all — never fabricated as 0 or guessed
              balanceUnitsAfterScaled: null, // this row shape prints no running balance — never carried forward/fabricated from a prior row
              sourceReference: null,
              sourceDescription: line.slice(0, 500),
            });
            continue;
          }
          warnings.push({ code: 'unparseable_transaction_row', message: `Could not parse transaction row: "${line}"`, severity: 'error', lineHint: idx });
          continue;
        }
        const [, dateRaw, amountRaw, priceRaw, unitsRaw, descRaw, balanceRaw, ref] = am;
        const dateParsed = parseStatementDate(dateRaw);
        if (!dateParsed.ok) {
          warnings.push({ code: 'unparseable_date', message: dateParsed.error, severity: 'error', lineHint: idx });
          continue;
        }
        const amountScaled = requireScaled(amountRaw, warnings, 'unparseable_amount');
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_units');
        const navScaled = requireScaled(priceRaw, warnings, 'unparseable_nav'); // this layout's "Price" column is the NAV-equivalent slot
        const balanceScaled = requireScaled(balanceRaw, warnings, 'unparseable_balance');
        if (amountScaled === null) continue;
        // II-PC3 Gate A finding #7: two real transaction-cost categories
        // (stamp duty, STT) — already classified correctly as 'fee'/'tax'
        // (debt/transaction COSTS, never a transfer/repayment) by the
        // EXISTING, unmodified transactionTypeMapping.ts rules
        // (`\bstamp duty\b` -> fee, `\bstt\b` -> tax) — no change needed
        // there; this alternate row grammar just needed to reach that
        // classifier at all, which it now does.
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
    // II-PC3 Gate A finding #9: the alternate closing-balance grammar
    // prints NO date at all ("Closing Unit Balance: X Total Cost Value:
    // Y") — computed once, used only as that grammar's as-of-date
    // fallback (the statement's own period end), never for the primary
    // CLOSING_RE grammar, which always carries its own explicit date.
    const altClosingFallbackAsOfIso = this.extractMetadata(text).statementPeriodEndIso;

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
      // II-PC3 Gate A finding #5 (see the matching block in
      // parseTransactions for the full rationale).
      const altScheme = ALT_SCHEME_LINE_RE.exec(line);
      if (altScheme) {
        const rawName = altScheme[1].trim();
        const isinValue = altScheme[2];
        currentScheme = {
          rawSchemeName: rawName,
          normalisedSchemeName: normaliseSchemeName(rawName),
          amcName: lastKnownAmcName,
          planType: detectPlanType(rawName),
          optionType: detectOptionType(rawName),
          isin: isinValue && isinValue.length > 0 ? isinValue : null,
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
        continue;
      }
      // II-PC3 Gate A finding #9: alternate closing-balance grammar, no
      // date on the line at all — falls back to the statement's own
      // period-end date (never fabricated from nothing; if that is also
      // unavailable, this is reported as an error, never silently
      // guessed).
      const altClosing = ALT_CLOSING_RE.exec(line);
      if (altClosing && currentScheme) {
        const [, unitsRaw, valueRaw] = altClosing;
        if (!altClosingFallbackAsOfIso) {
          warnings.push({ code: 'unparseable_closing_date', message: 'Alternate-layout closing balance line has no explicit date, and the statement period end could not be determined either.', severity: 'error', lineHint: idx });
          continue;
        }
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_closing_units');
        if (unitsScaled === null) continue;
        const valueScaled = valueRaw ? requireScaled(valueRaw, warnings, 'unparseable_closing_value') : null;
        holdings.push({
          folioNumber: currentFolio,
          scheme: currentScheme,
          asOfDateIso: altClosingFallbackAsOfIso,
          unitsScaled,
          valueScaled,
          navScaled: null, // no "NAV as on" clause exists in this layout (Gate A finding #9)
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
