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
import type { IiTransactionType } from '../types';

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

// See this regex's own use-site comment (search OPENING_BALANCE_RE below)
// for the real production defect this closes: the column-header line
// isn't reliably reprinted before every scheme's rows, but this line is.
const OPENING_BALANCE_RE = /^Opening Unit Balance\s*:\s*(\(?-?[\d,]+\.\d+\)?)\s*$/i;

// Finding #6: alternate transaction-row grammar matching the header above.
// "Price" occupies this layout's NAV-equivalent slot; the trailing numeric
// field is this layout's running Unit Balance (Gate A's literal header
// extraction showed a truncated "...Unit" column after "Transaction").
const ALT_TXN_ROW_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(.+?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

// Real production defect (2026-09-07, real 19-page since-inception CAS):
// pdf-parse's column-gap heuristic sometimes omits the space between this
// layout's Price and Units columns when the source PDF's rendered gap is
// too narrow, producing a single glued numeric run with no separator at
// all -- e.g. a real Price of 12.51 and Units of 799.361 extracted as the
// literal text "12.51799.361". ALT_TXN_ROW_RE requires whitespace between
// every field, so every row shaped like this failed to match at all,
// silently dropping the row (or, once `currentScheme` context was lost,
// an entire scheme's transaction table) rather than raising a warning.
// Confirmed live: 9 of a real user's 17 schemes had ZERO transactions
// parsed despite parseHoldings() correctly identifying all 17 (proving
// the scheme-block boundaries themselves were never the problem).
//
// Same table header, only the middle Price+Units run is captured as ONE
// glued blob (exactly two decimal points, matching two concatenated
// numbers) rather than as two separately-delimited groups.
const ALT_TXN_ROW_GLUED_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+(?:\.[\d,]+){2}\)?)(.+?)\s+(\(?-?[\d,]+\.\d+\)?)(?:\s+\[Ref:\s*([^\]]+)\])?\s*$/;

// A glued "12.51799.361" blob has multiple syntactically-valid two-number
// splits (e.g. "12.5179"/"9.361" parses just as cleanly as "12.51"/
// "799.361") -- picking the wrong one would silently record a wrong price
// AND a wrong unit count, which is worse for a financial application than
// an honest parse failure. This disambiguates the same way
// reclassifyReversedPurchasePairs() proves its own pairing: from a fact
// the statement itself already prints, never a guess. A genuine (price,
// units) pair must multiply back to this row's own printed Amount, within
// the statement's own rounding tolerance -- every candidate split is
// tried, and the split is accepted ONLY when EXACTLY ONE candidate
// satisfies that check. Zero or multiple passing candidates is reported
// as an honest unparseable_transaction_row, never a guess.
function splitGluedPriceAndUnits(glued: string, amountAbs: number): { priceRaw: string; unitsRaw: string } | null {
  const cleaned = glued.replace(/^\(|\)$/g, '');
  const dotPositions: number[] = [];
  for (let i = 0; i < cleaned.length; i++) if (cleaned[i] === '.') dotPositions.push(i);
  if (dotPositions.length !== 2) return null; // not this defect's shape at all
  const [firstDot, secondDot] = dotPositions;
  const intPart = cleaned.slice(0, firstDot);
  const middle = cleaned.slice(firstDot + 1, secondDot); // price's frac digits + units' int digits, concatenated
  const fracPart = cleaned.slice(secondDot + 1);
  if (!/^\d+$/.test(intPart) || !/^\d+$/.test(fracPart) || middle.length < 2) return null;

  const candidates: { priceRaw: string; unitsRaw: string }[] = [];
  for (let k = 1; k < middle.length; k++) {
    const priceFrac = middle.slice(0, k); // never comma-grouped -- it's a fractional part
    const unitsInt = middle.slice(k); // may legitimately carry thousands commas
    if (!/^\d+$/.test(priceFrac) || !/^[\d,]+$/.test(unitsInt)) continue;
    const price = Number(priceFrac.length ? `${intPart}.${priceFrac}` : intPart);
    const units = Number(`${unitsInt.replace(/,/g, '')}.${fracPart}`);
    if (!Number.isFinite(price) || !Number.isFinite(units) || price <= 0 || units <= 0) continue;
    const tolerance = Math.max(0.02, amountAbs * 0.005); // statement rounds Amount/Price/Units independently
    if (Math.abs(price * units - amountAbs) <= tolerance) {
      candidates.push({ priceRaw: `${intPart}.${priceFrac}`, unitsRaw: `${unitsInt}.${fracPart}` });
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// CORRECTED, 2026-09-07 (superseding an earlier same-day fix that was
// diagnosed against a locally-saved copy of the real document's text which
// turned out to have silently lost the tab characters below -- caught only
// once compared against the *actual* production error text after
// reprocessing, which still showed the row failing after the earlier fix
// shipped). The real production text is
// "12.82\t(3,037.396)\tRedemption ..." -- Price and Units are separated by
// an actual TAB character, not glued with zero whitespace at all.
// ALT_TXN_ROW_RE's own `\s+` between fields already matches a tab, and its
// Units group `(\(?-?[\d,]+\.\d+\)?)` already accepts a parenthesized
// negative value -- there was never a "glued" defect in this shape to
// begin with. The ONLY real defect is that these specific rows'
// descriptions are long enough to wrap onto one or more further physical
// lines before the running Unit Balance finally appears (always alone on
// its own line once it does), so ALT_TXN_ROW_RE's own trailing-balance
// requirement never matches on the row's own first line. This general,
// sign-agnostic wrapped-start variant reuses ALT_TXN_ROW_RE's exact field
// structure (never a bespoke "glued" pattern) with only the trailing
// balance/Ref anchor removed. Confirmed live: recurs 60+ times in one real
// statement, across several schemes' redemptions, SIP rejections/
// reversals, and inter-scheme "Lateral Shift In"/"Lateral Shift Out"
// transfers (both signs -- a shift IN carries ordinary positive units) —
// among them the real redemption whose silent loss was making one
// scheme's reconstructed unit balance come out ~5x too high (its units
// were never subtracted, because the whole row was dropped as an honest
// but wrong unparseable_transaction_row). No balance is expected on THIS
// line, so none is captured here; the caller consumes continuation lines
// looking for it (see BARE_BALANCE_LINE_RE below).
const ALT_TXN_ROW_WRAPPED_START_RE =
  /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)\s+(\(?-?[\d,]+\.\d+\)?)(.+)$/;

// A bare running-balance line with nothing else on it — the unambiguous
// terminator for the wrapped-description continuation above. Never
// confused with a real transaction row (which always starts with a date)
// or a labelled fee row (which always carries its own label text).
const BARE_BALANCE_LINE_RE = /^\(?-?[\d,]+\.\d+\)?$/;

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

// PC4 section 3/5 finding (2026-09-07): the alt layout DOES print a real
// per-scheme NAV and market value — corrected from an earlier, wrong
// assumption in this file's history that it never does. It is a SEPARATE
// footer line from ALT_CLOSING_RE's "Closing Unit Balance ... Total Cost
// Value" line, not part of it — real example (as extracted by pdf-parse,
// one line): "NAV on 04-Sep-2026: INR 2,845.5584 Market Value on
// 04-Sep-2026: INR 38,682.52". Before this fix it was silently discarded
// as an `unparseable_transaction_row` warning in both parseTransactions
// and parseHoldings, dropping real, valuable per-scheme valuation data
// that genuinely exists in the source document. NAV and market-value
// dates are captured independently since nothing guarantees they are
// always identical, though they usually are.
const ALT_NAV_MARKET_VALUE_RE =
  /^NAV on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(?:INR|Rs\.?|₹)\s*([\d,]+\.\d+)\s+Market Value on (\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*(?:INR|Rs\.?|₹)\s*([\d,]+\.\d+)\s*$/i;

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

// Real production defect (2026-09-07): the SAME real document also prints
// most (not all) Stamp Duty/STT rows split across TWO lines instead of
// ALT_FEE_ROW_RE's one -- "<date> <amount>" alone on one line, immediately
// followed by "*** Stamp Duty ***"/"*** STT Paid ***" alone on the next.
// This was the single largest source of missed transactions in the real
// 19-page statement this closes, once the inTable/glued-number defects
// above were fixed (roughly 400 of ~450 remaining missed rows). The
// date+amount line's own regex requires end-of-line right after the
// amount, so it can never accidentally match a genuine full transaction
// row (which always has more fields following the amount).
const ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\(?-?[\d,]+\.\d+\)?)\s*$/;
const ALT_FEE_ROW_LABEL_ONLY_RE = /^\*+\s*(Stamp\s+Duty|Securities\s+Transaction\s+Tax|STT(?:\s+Paid)?)\s*\*+\s*$/i;

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

// Real production incident, 2026-09-07 (found during PC4's reconciliation
// gate review): a real CAMS statement records a failed SIP-registration
// retry under the SAME wording as a normal instalment -- no "Rejection"/
// "Reversed" keyword anywhere (e.g. "Systematic Purchase (Continuous
// Offer)Registration Record is not available - Instalment No 1", "...
// Payment not received from investor banker - Instalment No 2"), so
// classifyTransactionType() has no keyword to catch it by -- and chasing
// every possible CAMS rejection-reason phrase is exactly the whack-a-mole
// its own comments already warn against (see the "Systematic Investment
// Rejection" incident above). The statement DOES still print these rows
// with a genuine negative (parenthesized) Units value, which structurally
// proves the row is a cancellation: a true purchase/SIP/switch-in/etc. can
// never subtract units by definition. reconciliation.ts's DIRECTION_TABLE
// forces an inflow-typed row's contribution to abs(units) regardless of
// the parsed sign (correct for the overwhelmingly common case where a
// source prints unsigned magnitudes and relies on the type name alone for
// direction) -- for these self-contradictory rows that silently flips the
// sign back to positive, double-counting a failed retry as a genuine
// extra contribution. Caught via exact arithmetic: Kotak Mid Cap Fund's
// reconciliation variance moved from +111.505 to +223.010 units once the
// wrapped-row fix above started recovering these previously-dropped rows
// at all; the phantom excess (2 x 37.956 + 2 x 36.713 units counted
// instead of the true net 0 + 36.713) accounts for the entire +111.505
// delta.
//
// Fixed here, per-row, rather than by weakening reconciliation.ts's
// DIRECTION_TABLE: the sign/type contradiction is a property of these
// specific rows, not a general reconciliation-engine change -- widening
// the fix there would silently change behaviour for every instrument and
// every source (including KFintech), unproven and out of this fix's
// scope. Unlike reclassifyReversedPurchasePairs() above, this needs no
// negation-pair partner and no balance-restoration proof: the sign alone,
// on a type that is inflow-only by the canonical taxonomy's own
// definition (spec section 19), is unambiguous.
const INFLOW_ONLY_TRANSACTION_TYPES = new Set<IiTransactionType>([
  'purchase', 'sip', 'switch_in', 'stp_in', 'transfer_in', 'reinvestment', 'bonus',
]);
function reclassifyNegativeSignedInflowRows(transactions: ParsedTransactionRecord[]): void {
  for (let i = 0; i < transactions.length; i++) {
    const t = transactions[i];
    if (!INFLOW_ONLY_TRANSACTION_TYPES.has(t.canonicalType)) continue;
    if (t.unitsScaled === null || t.unitsScaled >= BigInt(0)) continue; // only the structurally-impossible case
    transactions[i] = { ...t, canonicalType: 'reversal', classificationConfidence: 1 };
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
      // Real production defect (2026-09-07, real 19-page since-inception
      // CAS): the "Date Amount Price..."/"Date Description Amount..."
      // column-header line is NOT reliably reprinted before every scheme's
      // own transaction rows -- in a real multi-scheme statement it can be
      // a PAGE-level artifact, printed once at the top of a page and never
      // again for schemes whose blocks begin further down that same page.
      // Every AMC-Name/Scheme-Name/Folio-No line between that one header
      // reprint and a later scheme's actual rows resets `inTable = false`
      // (correctly, in the normal per-scheme-header case), and nothing
      // was re-enabling it for that later scheme -- silently dropping its
      // entire transaction table with no warning at all (inTable was
      // simply false, so the row-parsing branch below was never reached).
      // Confirmed live: 9 of a real user's 17 schemes had ZERO
      // transactions parsed this way; a 10th (Franklin India Mid Cap) kept
      // exactly the ONE row that happened to follow a page-break's
      // incidental header reprint mid-scheme, out of 14 real rows.
      // "Opening Unit Balance: <units>" is a genuinely per-scheme
      // structural marker -- every CAMS scheme block (both layout
      // variants) opens its own transaction section with exactly this
      // line, immediately before its first row. Treating it as ALSO
      // turning `inTable` on is safe and backward compatible: in a
      // document where the header line DOES immediately precede it
      // (the common case this file's other fixtures already cover), this
      // is a harmless redundant re-set of an already-true flag.
      if (OPENING_BALANCE_RE.test(line)) {
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
      // The NAV/market-value footer line (see ALT_NAV_MARKET_VALUE_RE's own
      // comment) carries no transaction data — this is a transactions-side
      // no-op purely to stop it being wrongly fed to the transaction-row
      // grammar as a spurious unparseable_transaction_row error. Actual
      // extraction happens in parseHoldings().
      if (ALT_NAV_MARKET_VALUE_RE.test(line)) {
        continue;
      }
      if (inTable && line.length > 0 && currentScheme) {
        // Real production defect (2026-09-07): ALT_FEE_ROW_RE already
        // handles a Stamp Duty/STT row printed on ONE line ("<date>
        // <amount>*** Stamp Duty ***"), but the SAME real document prints
        // most of these rows split across TWO separate lines instead --
        // "<date> <amount>" alone, then "*** Stamp Duty ***" alone on the
        // very next line. This was overwhelmingly the single largest
        // source of missed transactions once the inTable/glued-number
        // fixes above landed (roughly 400 of ~450 remaining missed rows
        // across the whole document, one warning each for the date/amount
        // line and the label line). Checked first, before TXN_ROW_RE, since
        // neither a genuine full transaction row nor a same-line fee row
        // can match ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE (it requires the line
        // to end immediately after the amount, with nothing else on it).
        const splitFeeDateAmount = ALT_FEE_ROW_SPLIT_DATE_AMOUNT_RE.exec(line);
        const nextLine = idx + 1 < lines.length ? lines[idx + 1].trim() : '';
        const splitFeeLabel = splitFeeDateAmount ? ALT_FEE_ROW_LABEL_ONLY_RE.exec(nextLine) : null;
        if (splitFeeDateAmount && splitFeeLabel) {
          const [, sfDateRaw, sfAmountRaw] = splitFeeDateAmount;
          const sfLabel = splitFeeLabel[1];
          const sfDateParsed = parseStatementDate(sfDateRaw);
          if (!sfDateParsed.ok) {
            warnings.push({ code: 'unparseable_date', message: sfDateParsed.error, severity: 'error', lineHint: idx });
            idx += 1; // still consume the label line -- it carries no data of its own
            continue;
          }
          const sfAmountScaled = requireScaled(sfAmountRaw, warnings, 'unparseable_amount');
          idx += 1; // consume the label line, it's part of this same row
          if (sfAmountScaled === null) continue;
          const sfClassification = classifyTransactionType(sfLabel.trim());
          if (sfClassification.canonicalType === 'unclassified') {
            warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${sfLabel.trim()}"`, severity: 'warning', lineHint: idx });
          }
          transactions.push({
            folioNumber: currentFolio,
            scheme: currentScheme,
            transactionDateIso: sfDateParsed.iso,
            rawTransactionTypeText: sfLabel.trim(),
            canonicalType: sfClassification.canonicalType,
            classificationConfidence: sfClassification.confidence,
            amountScaled: sfAmountScaled,
            unitsScaled: BigInt(0), // this row shape never carries units — a real, structural fact (fee/tax rows have no unit impact), never an unparsed/missing value
            navScaled: null, // no Price field exists on this row shape at all — never fabricated as 0 or guessed
            balanceUnitsAfterScaled: null, // this row shape prints no running balance — never carried forward/fabricated from a prior row
            sourceReference: null,
            sourceDescription: `${line} ${nextLine}`.slice(0, 500),
          });
          continue;
        }
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
          // Real production defect (2026-09-07, see ALT_TXN_ROW_GLUED_RE's
          // own comment): attempted only after the normal, unambiguous
          // whitespace-delimited grammar fails, never instead of it -- the
          // vast majority of rows in a real document DO have the space and
          // must keep matching ALT_TXN_ROW_RE exactly as before.
          const gluedMatch = ALT_TXN_ROW_GLUED_RE.exec(line);
          if (gluedMatch) {
            const [, gDateRaw, gAmountRaw, gGluedBlob, gDescRaw, gBalanceRaw, gRef] = gluedMatch;
            const gDateParsed = parseStatementDate(gDateRaw);
            if (!gDateParsed.ok) {
              warnings.push({ code: 'unparseable_date', message: gDateParsed.error, severity: 'error', lineHint: idx });
              continue;
            }
            const amountAbs = Math.abs(Number(gAmountRaw.replace(/[(),]/g, '')));
            const split = Number.isFinite(amountAbs) ? splitGluedPriceAndUnits(gGluedBlob, amountAbs) : null;
            if (split) {
              const gAmountScaled = requireScaled(gAmountRaw, warnings, 'unparseable_amount');
              const gUnitsScaled = requireScaled(split.unitsRaw, warnings, 'unparseable_units');
              const gNavScaled = requireScaled(split.priceRaw, warnings, 'unparseable_nav');
              const gBalanceScaled = requireScaled(gBalanceRaw, warnings, 'unparseable_balance');
              if (gAmountScaled !== null) {
                const gClassification = classifyTransactionType(gDescRaw.trim());
                if (gClassification.canonicalType === 'unclassified') {
                  warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${gDescRaw.trim()}"`, severity: 'warning', lineHint: idx });
                }
                transactions.push({
                  folioNumber: currentFolio,
                  scheme: currentScheme,
                  transactionDateIso: gDateParsed.iso,
                  rawTransactionTypeText: gDescRaw.trim(),
                  canonicalType: gClassification.canonicalType,
                  classificationConfidence: gClassification.confidence,
                  amountScaled: gAmountScaled,
                  unitsScaled: gUnitsScaled,
                  navScaled: gNavScaled,
                  balanceUnitsAfterScaled: gBalanceScaled,
                  sourceReference: gRef ? gRef.trim() : null,
                  sourceDescription: line.slice(0, 500),
                });
                continue;
              }
            }
            // Glued blob shape matched but the arithmetic proof did not
            // single out exactly one candidate split -- fall through to the
            // honest unparseable_transaction_row below rather than guess.
          }
          // See ALT_TXN_ROW_WRAPPED_START_RE's own comment above -- attempted
          // only after ALT_TXN_ROW_RE (which requires a trailing balance on
          // the SAME line) has already failed. Every real occurrence found
          // wraps its description across further physical lines, so this
          // regex never itself captures a balance -- the lookahead below
          // always has to go find one.
          const wrappedMatch = ALT_TXN_ROW_WRAPPED_START_RE.exec(line);
          if (wrappedMatch) {
            const [, wDateRaw, wAmountRaw, wPriceRaw, wUnitsRaw, wDescRawFirst] = wrappedMatch;
            let wDescRaw = wDescRawFirst;
            let wBalanceRaw: string | null = null;
            // Consume plain continuation text until the running balance
            // finally appears alone on its own line. Bounded, and stops the
            // instant a candidate line looks like the start of a real new
            // transaction row, so a genuine later row can never be
            // swallowed as if it were just more description text.
            const MAX_CONTINUATION_LINES = 5;
            let consumedCount = 0;
            let lookaheadIdx = idx + 1;
            while (lookaheadIdx < lines.length && consumedCount < MAX_CONTINUATION_LINES) {
              const candidate = lines[lookaheadIdx].trim();
              if (/^\d{1,2}-[A-Za-z]{3}-\d{4}/.test(candidate)) break;
              if (BARE_BALANCE_LINE_RE.test(candidate)) {
                wBalanceRaw = candidate;
                idx = lookaheadIdx; // consume every continuation line, including this balance line
                break;
              }
              wDescRaw = `${wDescRaw} ${candidate}`;
              lookaheadIdx += 1;
              consumedCount += 1;
            }
            if (wBalanceRaw !== null) {
              const wDateParsed = parseStatementDate(wDateRaw);
              if (!wDateParsed.ok) {
                warnings.push({ code: 'unparseable_date', message: wDateParsed.error, severity: 'error', lineHint: idx });
                continue;
              }
              const wAmountScaled = requireScaled(wAmountRaw, warnings, 'unparseable_amount');
              const wUnitsScaled = requireScaled(wUnitsRaw, warnings, 'unparseable_units');
              const wNavScaled = requireScaled(wPriceRaw, warnings, 'unparseable_nav');
              const wBalanceScaled = requireScaled(wBalanceRaw, warnings, 'unparseable_balance');
              if (wAmountScaled !== null) {
                const wClassification = classifyTransactionType(wDescRaw.trim());
                if (wClassification.canonicalType === 'unclassified') {
                  warnings.push({ code: 'unclassified_transaction', message: `Unrecognised transaction description: "${wDescRaw.trim()}"`, severity: 'warning', lineHint: idx });
                }
                transactions.push({
                  folioNumber: currentFolio,
                  scheme: currentScheme,
                  transactionDateIso: wDateParsed.iso,
                  rawTransactionTypeText: wDescRaw.trim(),
                  canonicalType: wClassification.canonicalType,
                  classificationConfidence: wClassification.confidence,
                  amountScaled: wAmountScaled,
                  unitsScaled: wUnitsScaled,
                  navScaled: wNavScaled,
                  balanceUnitsAfterScaled: wBalanceScaled,
                  sourceReference: null,
                  sourceDescription: wDescRaw.slice(0, 500),
                });
                continue;
              }
            }
            // Matched the wrapped-start shape but never found its balance
            // within the bounded lookahead -- fall through to the honest
            // unparseable_transaction_row below rather than guess.
          }
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
    reclassifyNegativeSignedInflowRows(transactions);
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
    // PC4 section 3/5: real per-scheme NAV/market-value from the
    // ALT_NAV_MARKET_VALUE_RE footer line, held until the SAME scheme's
    // subsequent "Closing Unit Balance" line is reached (the two are
    // always separate lines, closing-balance a few lines after). Cleared
    // on consumption and on every new scheme header, so a stray NAV line
    // with no following closing line for that scheme (or a scheme with no
    // NAV line at all) never leaks its value into a different scheme's
    // holding.
    let pendingAltNavMarketValue: { navScaled: bigint; valueScaled: bigint; asOfDateIso: string } | null = null;

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
        pendingAltNavMarketValue = null; // a new scheme starts — any unconsumed NAV/value belonged to the PREVIOUS scheme and must never leak forward
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
        pendingAltNavMarketValue = null; // same reasoning as the labelled-scheme-name branch above
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
      // PC4 section 3/5 finding (see ALT_NAV_MARKET_VALUE_RE's own comment):
      // captured here, ahead of the scheme's own "Closing Unit Balance"
      // line (which always follows a few lines later), and held in
      // `pendingAltNavMarketValue` until that line is reached.
      const navMarketMatch = ALT_NAV_MARKET_VALUE_RE.exec(line);
      if (navMarketMatch && currentScheme) {
        const [, navDateRaw, navRaw, valueDateRaw, valueRaw] = navMarketMatch;
        const navScaled = requireScaled(navRaw, warnings, 'unparseable_closing_nav');
        const valueScaled = requireScaled(valueRaw, warnings, 'unparseable_closing_value');
        // The market-value date is what a "value as of" holding record
        // should carry (it is the valuation date), not the NAV date --
        // real-world evidence shows they are normally identical, but the
        // market-value date is the semantically correct one to prefer if
        // they ever differ, since it is literally the date the printed
        // value is valid as of.
        const asOf = parseStatementDate(valueDateRaw);
        void navDateRaw;
        if (navScaled !== null && valueScaled !== null && asOf.ok) {
          pendingAltNavMarketValue = { navScaled, valueScaled, asOfDateIso: asOf.iso };
        }
        continue;
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
        const unitsScaled = requireScaled(unitsRaw, warnings, 'unparseable_closing_units');
        if (unitsScaled === null) {
          pendingAltNavMarketValue = null;
          continue;
        }
        // PC4 section 3/5 finding: when a real NAV/market-value line was
        // found for this scheme (ALT_NAV_MARKET_VALUE_RE, above), it takes
        // priority over both this line's own Total Cost Value (a genuinely
        // different, less useful figure — see that regex's own comment)
        // and the statement-period-end fallback date, since it is the
        // scheme's own real, printed valuation.
        if (pendingAltNavMarketValue) {
          holdings.push({
            folioNumber: currentFolio,
            scheme: currentScheme,
            asOfDateIso: pendingAltNavMarketValue.asOfDateIso,
            unitsScaled,
            valueScaled: pendingAltNavMarketValue.valueScaled,
            navScaled: pendingAltNavMarketValue.navScaled,
          });
          pendingAltNavMarketValue = null;
          continue;
        }
        if (!altClosingFallbackAsOfIso) {
          warnings.push({ code: 'unparseable_closing_date', message: 'Alternate-layout closing balance line has no explicit date, and the statement period end could not be determined either.', severity: 'error', lineHint: idx });
          continue;
        }
        const valueScaled = valueRaw ? requireScaled(valueRaw, warnings, 'unparseable_closing_value') : null;
        holdings.push({
          folioNumber: currentFolio,
          scheme: currentScheme,
          asOfDateIso: altClosingFallbackAsOfIso,
          unitsScaled,
          valueScaled,
          navScaled: null, // no ALT_NAV_MARKET_VALUE_RE line was found for this scheme -- genuinely absent, never guessed (Gate A finding #9's original fallback path)
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
