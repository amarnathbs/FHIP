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
import { splitLines, normaliseSchemeName, detectPlanType, detectOptionType, extractLabelledField, maskPan, redactPanFromLine, matchAcrossLines } from './textUtils';
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
//
// Post-Gate-A production finding (2026-09-06, a genuine real consolidated
// statement -- NOT one of the Gate-A comparison doc's own numbered
// findings above; this surfaced later, from a different real document,
// during live production incident triage):
// - The registrar on this line is not always CAMS -- a single CAS spans
//   both India RTAs (CAMS and KFintech both service schemes on one
//   statement), so KFINTECH is matched here too, not just CAMS.
// - This whole header routinely wraps across two or even three physical
//   lines depending on where the PDF's page/column layout happens to
//   break it (never at a fixed point -- one real example split a scheme
//   name and its own hyphen apart: "...(Non" / "-Demat)..."; another
//   split "Registrar :" from its own registrar name: ".../...Registrar
//   :" / "KFINTECH"). This regex still only matches a single already-
//   joined logical line -- callers must run it through
//   textUtils.ts's matchAcrossLines() rather than exec() it directly
//   against one physical line, or every wrapped header on a real
//   document like this one is silently missed (found live: this was
//   exactly why a real statement's holdings and some of its transactions'
//   scheme attribution came back empty/wrong despite parsing "succeeding"
//   overall).
const ALT_SCHEME_LINE_RE =
  /^(.+?)\s*-\s*ISIN\s*:\s*([A-Z0-9]*)\s*\(\s*Advisor\s*:\s*([^)]*)\)\s*Registrar\s*:\s*(?:CAMS|KFINTECH)\s*$/i;

// Guards matchAcrossLines()'s lookahead for ALT_SCHEME_LINE_RE specifically:
// a continuation line (or valid starting line -- see matchAcrossLines()'s
// own doc comment for why both ends need this) is anything non-blank that
// is NOT itself one of this layout's other genuinely distinct line
// shapes. Deliberately does NOT exclude "Registrar : ..." -- that phrase
// is part of the scheme header itself (sometimes its own trailing
// continuation line, e.g. a registrar name wrapping alone onto the next
// line), never a separate field in this layout.
//
// Two real regressions, both caught by this codebase's own existing
// suite before ever shipping, shaped this list:
// 1. A same-shaped-but-permissive default guard (matchAcrossLines()'s own
//    fallback, meant for other future callers) treated "Registrar : CAMS"
//    as a stopper too, since it reads exactly like *any* "Label: value"
//    line in isolation -- fixed by listing only the specific OTHER field
//    labels this layout actually uses, not a generic "any Label:" shape.
// 2. Excluding only those labelled fields still let a genuine transaction
//    row ("01-Jun-2025 ... Switch Out ... [Ref: ...]") get treated as a
//    valid 3-line scheme-header start when the very next real scheme's
//    header happened to fall within the lookahead window -- the
//    transaction row and its scheme's own "Closing Unit Balance: ..."
//    line silently vanished into the captured (wrong) scheme name, with
//    NO warning raised (the match "succeeded"), while the transaction
//    itself was never recorded at all. Transaction rows and closing-
//    balance lines are now excluded explicitly, the same way the
//    labelled fields already were.
function canContinueSchemeHeader(line: string): boolean {
  const t = line.trim();
  if (t.length === 0) return false;
  // A transaction row always starts with a date; a closing-balance line
  // (both grammars) and the transaction-table header row are fixed,
  // recognisable prefixes. None of these is ever a genuine fragment of a
  // wrapped free-text scheme header.
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}\b/.test(t)) return false;
  if (/^Closing Unit Balance\b/i.test(t)) return false;
  if (/^Date\s+(Description|Amount)\b/i.test(t)) return false;
  if (/^No transactions during this statement period\.?$/i.test(t)) return false;
  return (
    extractLabelledField(t, 'Folio No') === null &&
    extractLabelledField(t, 'PAN') === null &&
    extractLabelledField(t, 'Name') === null &&
    extractLabelledField(t, 'Holding Mode') === null &&
    extractLabelledField(t, 'AMC Name') === null &&
    extractLabelledField(t, 'Scheme Name') === null
  );
}

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
//
// Post-Gate-A production finding (2026-09-07, real CAS document): the
// "Rs."/"₹" currency marker before the Total Cost Value amount was
// required (non-optional) in this regex, but real RTA output for this
// layout prints the amount with NO currency marker at all —
// "Total Cost Value: 93,000.00", not "Total Cost Value: Rs. 93,000.00".
// Every existing synthetic fixture (pc3-q11-alternate-cams-layout,
// pc3-golden-real-variant) happened to include "Rs.", so this was never
// exercised against the real format and the regex silently matched ZERO
// closing-balance lines in the real document — `parseHoldings()` pushed
// no holdings for any of its 8 schemes (holdings_found: 0 despite
// schemes_found: 8, transactions_found: 300), and in `parseTransactions`
// the same failed match meant `inTable` never reset, so both the
// closing-balance line and the next scheme's AMC-name line were wrongly
// fed to the transaction-row grammar as spurious `unparseable_transaction_row`
// errors. The currency marker is now optional (still matched when
// present, so the existing "Rs."-bearing fixtures keep passing).
const ALT_CLOSING_RE =
  /^Closing Unit Balance\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*(?:Units)?\s+Total Cost Value\s*:\s*(?:(?:Rs\.?|₹)\s*)?(\(?-?[\d,]+\.\d+\)?)\s*$/i;

// Post-Gate-A production finding #2 (2026-09-07, same real CAS document as
// the ALT_CLOSING_RE fix above): the AMC/fund-house name also appears as a
// bare, unlabelled line with no "AMC Name:" prefix at all — just the fund
// house's own name immediately followed by the literal words "Mutual
// Fund" ("HDFC Mutual Fund", "SBI Mutual Fund", "Nippon India Mutual
// Fund", ...), always positioned directly after the PRECEDING scheme's
// closing-balance line and directly before the NEXT scheme's PAN/KYC
// line. Never documented in either the "detailed_v1" or
// "detailed_v1_alt_layout" grammars above — a third real-world header
// shape. Without recognising it, `lastKnownAmcName` stays stale at the
// previous scheme's AMC for every scheme that follows one of these bare
// headers, silently misattributing fund-house identity — not caught by
// transaction/holdings counts, since scheme detection and closing-balance
// parsing both succeed regardless; only `scheme.amcName` is wrong.
const BARE_AMC_NAME_RE = /^[A-Z][A-Za-z&.'-]*(?:\s+[A-Za-z&.'-]+){0,4}\s+Mutual\s+Fund$/;

// Post-Gate-A production finding #3 (2026-09-07): a bare-AMC-shaped line
// ("<Name> Mutual Fund") is genuinely ambiguous on its own — it can be
// EITHER (a) line 1 of a 2-line wrapped scheme header, when the scheme's
// own name happens to end in the words "Mutual Fund" and the "- ISIN:
// ...Registrar : ..." clause wraps to the next physical line, OR (b) a
// completely standalone AMC/fund-house context line sitting immediately
// before an UNRELATED, independently-complete scheme header.
//
// Naively always trying the wrap match first (my first fix for finding #3
// itself) breaks case (b): matchAcrossLines' non-greedy ALT_SCHEME_LINE_RE
// group has no way to know the bare-AMC line isn't part of the sentence,
// so it happily merges "<AMC name>" + "<the NEXT, wholly separate scheme's
// own complete header>" into one garbage combined name — confirmed by this
// fix's own regression test failing after the naive reordering. The
// discriminator: a bare-AMC line is only NEEDED to complete a wrap if the
// line(s) after it do NOT already stand alone as a complete,
// independently-resolvable scheme header. If they do, the bare-AMC line
// was never a wrap fragment at all.
function bareAmcLineIsWrapStart(lines: string[], idx: number): boolean {
  if (!BARE_AMC_NAME_RE.test(lines[idx].trim())) return true; // not bare-AMC-shaped at all — no conflict, always eligible to be tried as a wrap start
  return matchAcrossLines(lines, idx + 1, ALT_SCHEME_LINE_RE, 3, canContinueSchemeHeader) === null;
}

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

// PC4 section 7/11 finding (2026-09-07, real user statement): classifying
// only the explicitly-worded rejection/reversal line as 'reversal' (the
// earlier transactionTypeMapping.ts fix) leaves its PAIRED purchase line
// still classified 'sip'/'purchase' — still counted in full toward "Total
// Contributed" even though zero net units and zero net cash actually
// moved for that instalment. Confirmed live: of 36 monthly SIP attempts
// for one real fund, 35 were purchase+rejection pairs (net zero, only one
// manual bank-transfer purchase with no matching reversal was genuine) —
// after only the rejection-line fix, the displayed total dropped from
// ~71,000 to ~35,000 (35 x 1,000, the unpaired purchase sides), still
// wrong. PC4 section 7 requires reusing certified cashflow classification
// rather than summing blindly, and section 11 forbids guessing recurring-
// contribution figures — this closes the gap with a DETERMINISTIC,
// mechanically-provable rule, never a guess from description text alone:
// a reversal transaction's own running Unit Balance (printed by the
// statement itself) exactly restores the balance to what it was BEFORE
// the immediately preceding transaction. When the preceding transaction
// is a same-date, same-folio, same-scheme, exact-negated-amount purchase-
// family transaction, that pairing is structurally proven by the
// statement's own numbers, not inferred from wording — so the paired
// purchase is reclassified to 'reversal' too. A transaction with no such
// pairing (no matching reversal, or a balance that doesn't cancel exactly)
// is left completely untouched, per the same never-guess discipline.
function reclassifyReversedPurchasePairs(transactions: ParsedTransactionRecord[]): void {
  for (let i = 1; i < transactions.length; i++) {
    const reversal = transactions[i];
    if (reversal.canonicalType !== 'reversal') continue;
    const prior = transactions[i - 1];
    if (prior.canonicalType === 'reversal') continue; // already correctly classified — nothing to fix
    if (prior.transactionDateIso !== reversal.transactionDateIso) continue;
    if (prior.folioNumber !== reversal.folioNumber) continue;
    if (prior.scheme.normalisedSchemeName !== reversal.scheme.normalisedSchemeName) continue;
    if (prior.unitsScaled === null || reversal.unitsScaled === null) continue;
    if (prior.unitsScaled !== -reversal.unitsScaled) continue; // exact unit negation
    if (prior.amountScaled !== -reversal.amountScaled) continue; // exact amount negation
    if (reversal.balanceUnitsAfterScaled === null) continue;
    const balanceBeforePrior = i >= 2 && transactions[i - 2].scheme.normalisedSchemeName === prior.scheme.normalisedSchemeName && transactions[i - 2].folioNumber === prior.folioNumber
      ? transactions[i - 2].balanceUnitsAfterScaled
      : BigInt(0); // first transaction for this scheme/folio — pre-purchase balance is genuinely zero, never guessed otherwise
    if (balanceBeforePrior === null) continue;
    if (reversal.balanceUnitsAfterScaled !== balanceBeforePrior) continue; // reversal must fully restore the pre-purchase balance, not just cancel units in isolation
    transactions[i - 1] = { ...prior, canonicalType: 'reversal', classificationConfidence: 1 };
  }
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
    // Post-Gate-A production finding #4 (2026-09-07): a real "since
    // inception" CAS request (spanning the account's entire history, not a
    // fixed period) prints its date range WITHOUT the "Statement Period :"
    // label at all — just a bare "01-Jan-1990 To 06-Sep-2026" line,
    // reprinted as a per-page tracking stamp alongside the version-stamp
    // line ("CAMSCASWS-<...> Version:V3.5 Live-<...>"), never labelled
    // anywhere in the real document. Without this fallback,
    // statementPeriodEndIso stayed null for the entire document, which
    // ALT_CLOSING_RE's holdings extraction depends on as its as-of-date
    // fallback (that grammar's closing-balance line carries no date of its
    // own) — so even after fixing ALT_CLOSING_RE's currency-marker bug,
    // holdings_found stayed 0 for every single scheme in the real
    // document, since every match hit the "no statement period end
    // available" guard instead. The leading date (a sentinel placeholder —
    // "01-Jan-1990" here — never a genuine informative start date for a
    // since-inception request) is deliberately NOT used as periodStart;
    // only the end date is what this fallback actually needs.
    if (!periodEnd) {
      for (const line of lines) {
        const m = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*$/.exec(line.trim());
        if (m) {
          const e = parseStatementDate(m[2]);
          if (e.ok) periodEnd = e.iso;
          break;
        }
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
      //
      // Real production incident, 2026-09-07: this wrap-match attempt must
      // run BEFORE the BARE_AMC_NAME_RE check below, not after. A bare
      // "<Name> Mutual Fund" line is sometimes itself line 1 of a 2-line
      // wrapped scheme header (line 2 carrying "<scheme> - ISIN: ...
      // Registrar : ..."), which matchAcrossLines can only detect by
      // starting its scan AT this line. My first version of the bare-AMC
      // fix put BARE_AMC_NAME_RE's `continue` first, so it always won that
      // race, swallowing line 1 as a plain AMC-name reset before
      // matchAcrossLines ever got a chance to try it as a wrap start —
      // causing matchAcrossLines to instead start fresh at line 2 alone,
      // which extracted an incomplete/different raw scheme name than the
      // correct 2-line join. On reprocess, that different normalised name
      // failed resolveScheme()'s exact-match step 4 against the
      // already-existing (correctly-named) instrument, creating a brand
      // new duplicate ii_instruments row and silently forking that fund's
      // transaction history across two instrument ids — confirmed live via
      // direct comparison of two parse runs against the same document.
      // bareAmcLineIsWrapStart() (see its own comment, above BARE_AMC_NAME_RE)
      // guards the OTHER direction of this same conflict: a bare-AMC line
      // that is genuinely standalone, immediately followed by a wholly
      // separate, already-complete scheme header, must NOT be merged into
      // that header's name.
      const altSchemeMatch = bareAmcLineIsWrapStart(lines, idx) ? matchAcrossLines(lines, idx, ALT_SCHEME_LINE_RE, 3, canContinueSchemeHeader) : null;
      if (altSchemeMatch) {
        const altScheme = altSchemeMatch.match;
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
        idx += altSchemeMatch.linesConsumed - 1;
        continue;
      }
      // Only a line that did NOT start a genuine wrapped scheme header
      // above is treated as a plain, standalone AMC-name context line.
      if (BARE_AMC_NAME_RE.test(line)) {
        lastKnownAmcName = line;
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
    reclassifyReversedPurchasePairs(transactions);
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
      if (amc) {
        lastKnownAmcName = amc;
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
        continue;
      }
      // II-PC3 Gate A finding #5 (see the matching block in
      // parseTransactions for the full rationale). bareAmcLineIsWrapStart()
      // (see its own comment, above BARE_AMC_NAME_RE) decides whether this
      // attempt is even eligible to consume a bare-AMC-shaped starting
      // line — keeps this function's scheme identity consistent with
      // parseTransactions' for the exact same document.
      const altSchemeMatch = bareAmcLineIsWrapStart(lines, idx) ? matchAcrossLines(lines, idx, ALT_SCHEME_LINE_RE, 3, canContinueSchemeHeader) : null;
      if (altSchemeMatch) {
        const altScheme = altSchemeMatch.match;
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
        idx += altSchemeMatch.linesConsumed - 1;
        continue;
      }
      if (BARE_AMC_NAME_RE.test(line)) {
        lastKnownAmcName = line;
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
