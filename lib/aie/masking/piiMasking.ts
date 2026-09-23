/**
 * AIE-1.1 — local/private PII detection & masking (PII-01..12).
 *
 * REUSE DECISION. Discovery found two independent, domain-local masking
 * implementations already in this codebase:
 *   - `lib/financial-data-hub/payslip/privacy.ts` (FDH-9) — `SENSITIVE_PATTERNS`
 *     (AU TFN, India PAN, AU BSB+account, long digit runs, email) and
 *     `FORBIDDEN_LABEL_TERMS` (a denylist of field labels whose whole value
 *     is dropped).
 *   - `lib/services/investment-intelligence/parsers/textUtils.ts` (R2) —
 *     `maskPan` (first-5/last-1 visible PAN display convention).
 * Both are domain-scoped one-offs with duplicated PAN-shaped regex logic.
 * AIE-1.1 needs a genuinely generic, domain-agnostic masking engine any
 * future adapter (1.2, 1.3, 1.4) can call — that engine does not exist
 * anywhere in this codebase (confirmed by discovery), so it is built here,
 * NEW, as this phase's own net-new PII-masking core, but every individual
 * detection pattern below is carried over from (not reinvented instead of)
 * the two files above, plus the additional detector classes AIE-1.1's own
 * spec explicitly asks for (person/address/card/phone/employer — PII-01)
 * that neither existing file covers. `lib/financial-data-hub/payslip/privacy.ts`
 * and `lib/services/investment-intelligence/parsers/textUtils.ts` are left
 * exactly as they are — this module does not replace them (that migration is
 * out of scope for AIE-1.1, which owns the SHARED gateway, not FDH-9/R2's
 * existing call sites) and is recorded as a follow-up in
 * AIE_1_1_IMPLEMENTATION.md's deferred-work section.
 *
 * PLACEMENT IN THE PIPELINE (non-negotiable, PII-01): masking runs AFTER
 * local/deterministic extraction and BEFORE any AI payload is constructed
 * (see `lib/aie/provider/gateway.ts`, which refuses to build a payload from
 * anything that has not been through `maskText()` first).
 *
 * M3 (Phase 4) — TOKENISATION SCHEME CHANGED BY PRODUCT-OWNER DECISION.
 * Every identifier category below is now replaced by a KEYED ONE-WAY HMAC
 * pseudonym (`lib/aie/masking/identifierToken.ts`), not by an opaque
 * per-call counter token backed by a reversible encrypted escrow map. The
 * `reversibleTokenMap` this function used to return is GONE, along with the
 * `aie_mask_token_map` write path and the evidence-reveal capability that
 * consumed it — see `lib/aie/review/reveal.ts`. The Product Owner made this
 * call knowing and accepting that a user can no longer see their own
 * original folio / PAN / account / holder-name value at any point,
 * including during their own document review.
 *
 * Consequence worth stating plainly, because it is a genuine improvement
 * rather than only a cost: tokens are now STABLE per (tenant, type, value).
 * The same folio in January's and February's statements yields the same
 * token, which is exactly the "account/folio stable token" the M3 AI
 * investment JSON contract needs and which the per-call counter scheme could
 * not express at all.
 *
 * WHAT IS NOT MASKED, AND WHY THAT IS CORRECT. Financial VALUES — amounts,
 * units, NAV, closing balances, statement market value — are deliberately
 * not a masked category and are unaffected by the decision above. They are
 * not identifiers, they are the evidence the adapter exists to read, and
 * H.9's own text preserves them ("financial values needed for extraction may
 * remain"). Masking them would not protect a user; it would simply make the
 * feature impossible.
 */

import { deriveIdentifierToken } from './identifierToken';

export type AiePiiType =
  | 'tax_id' // AU TFN / India PAN
  | 'aadhaar' // M2 (H.9)
  | 'bank_account'
  | 'ifsc' // M2 (H.9)
  | 'folio_number' // M2 (H.9)
  | 'policy_number' // M12B (M12B-F1)
  // AIE unified document fallback (2026-09-23). Three identifier classes with
  // NO rule of any kind before this phase, each found by building a capturing
  // test provider for the bank-statement / retirement / liability /
  // investment AI-fallback adapters and reading what actually egressed. See
  // each rule's own header in `PII_PATTERNS` for the evidence.
  | 'holder_identification_number' // AU HIN/SRN (share registry / broker)
  | 'account_reference' // member no, customer/client no, loan account, CRN
  | 'date_of_birth'
  | 'card_number'
  | 'email'
  | 'phone'
  | 'person_name_label'
  | 'address_label'
  | 'long_digit_run';

interface PiiPattern {
  type: AiePiiType;
  pattern: RegExp;
  /**
   * M2 (H.9). When set, only THIS capture group is replaced by a token and
   * the rest of the match is written back unchanged. Needed for
   * label-anchored rules, where the label is the only reliable way to
   * recognise the value but the label itself is not sensitive and is worth
   * keeping — a downstream adapter still needs to see that the document had
   * a "Folio No:" field even though the number itself must not egress.
   * Omitted means the whole match is tokenised, which stays the default.
   */
  valueGroup?: number;
  /**
   * M2 (H.9). Optional extra predicate the captured value must satisfy for
   * the match to count. Needed where the LABEL has to be matched
   * case-insensitively (statement labels appear as `Investor:`, `INVESTOR:`
   * and `investor:` interchangeably) but the VALUE still needs a
   * case-sensitive guard — under the `i` flag a `[A-Z]` class silently
   * matches lowercase too, so the guard has to live outside the pattern.
   */
  valuePredicate?: (value: string) => boolean;
}

/** Field LABELS whose entire value must be dropped rather than redacted —
 * carried over verbatim in substance from `FORBIDDEN_LABEL_TERMS`, extended
 * with person/address terms AIE-1.1's own spec calls for.
 *
 * M12C: this declaration MOVED UP from below `PII_PATTERNS` (it used to sit
 * next to `isForbiddenLabel`, which is a hoisted function declaration and so
 * is unaffected). The move is mechanical — the array is a plain literal with
 * no dependencies — and is required because `ADDRESS_STOP_TERMS` below reads
 * it while building the address rule's stop-vocabulary, and a module-level
 * `const` read before its own initialiser is a TDZ `ReferenceError`, not a
 * silent `undefined`. Reusing this list rather than inventing a second one is
 * deliberate: it is the vocabulary this module already treats as
 * "value-bearing field label", which is exactly the question the address
 * continuation has to ask of each candidate line. */
const FORBIDDEN_LABEL_TERMS = [
  'tax file number', 'tfn', 'pan number', 'pan no', 'aadhaar', 'aadhar',
  'bank account', 'account number', 'account no', 'a/c no', 'ifsc', 'bsb',
  'employee id', 'employee no', 'employee code', 'emp id', 'emp code',
  'address', 'date of birth', 'dob', 'uan', 'esic', 'passport',
  'next of kin', 'emergency contact', 'phone', 'mobile',
  'name', 'account holder', 'card number', 'cvv',
];

// ---------------------------------------------------------------------------
// M12C (`M3-OPEN-2`) — BOUNDED MULTI-LINE ADDRESS CONTINUATION.
//
// The address rule below used to capture its label's own line and nothing
// else, and said so in place: "a postal address printed across several lines
// is masked on its FIRST line only ... Lines two and three of a wrapped
// address still reach the provider." The reason given for not extending it
// was that going across newlines "would run on and swallow the next labelled
// field" — the exact over-capture failure the folio rule had to be narrowed
// for during M2. THAT REASONING IS NOT OVERTURNED HERE. An unbounded newline
// capture is still wrong and is still not what this does.
//
// What M12C adds is the third option: a continuation that is bounded in BOTH
// directions — a hard cap on how many lines it may take AND on how long each
// of those lines may be — and that stops at the FIRST of several explicit
// structural signals. The whole mechanism lives inside the rule's ordinary
// `pattern` / `valueGroup` fields, which matters more than it looks: every
// consumer of `PII_PATTERNS` (`maskText` AND the independent pre-egress guard
// `firstResidualPiiType`) reads those two fields and nothing else, so the two
// paths cannot desynchronise. A continuation mechanism bolted on OUTSIDE the
// `PiiPattern` interface would have reintroduced M12B-F2 — a guard asking a
// different question from the masker — by construction.
//
// COUNTING DECISION, STATED EXPLICITLY BECAUSE IT IS A JUDGEMENT CALL:
// a wrapped address counts as **ONE** `address_label` in `coverageByType`,
// not one per line, and yields ONE token covering all of its lines. The
// alternative (one match per line) was rejected because `coverage_by_type` is
// privacy evidence answering "how many identifiers did this document
// contain?", and a household with one postal address printed over four lines
// does not have four addresses — reporting 4 would overstate the document's
// PII content just as surely as reporting 1 for four DIFFERENT addresses
// would understate it. The guard agrees automatically: it shares the pattern,
// so it sees the same single match.
//
// VISIBLE SIDE EFFECT, DISCLOSED: because one token replaces a span that
// contained newlines, a 4-line address collapses to a single line in the
// masked text. Everything BELOW the address keeps its own line structure
// (the terminating newline is never consumed — the capture always ends at an
// end-of-line, never across one). Address tokens are not used as join keys
// anywhere (unlike folio/account tokens, whose stability the M3 contract
// depends on), so the fact that a differently-wrapped copy of the same
// address yields a different token costs nothing real. Stated rather than
// discovered later.
// ---------------------------------------------------------------------------

/** Hard cap on continuation lines. 3 continuation lines + the label's own line
 * = a 4-line address, which is the longest postal layout the AU/India
 * statements this repository parses actually print (recipient / street /
 * suburb-locality / state-postcode). A bigger number buys nothing real and
 * enlarges the blast radius of every stop-condition miss. */
const ADDRESS_MAX_CONTINUATION_LINES = 3;

/** Hard cap on the LENGTH of a continuation line. A line longer than this is
 * not consumed AT ALL — the capture requires the whole line (`(?=\r?\n|$)`)
 * rather than a 120-character prefix of it. Taking a prefix would be strictly
 * worse than taking nothing: it would leave the tail of the line in the text
 * while destroying its head, which neither protects the user nor preserves
 * structure. A wrapped postal line is short by construction; a 400-character
 * paragraph after `Address:` is prose, not an address. */
const ADDRESS_MAX_CONTINUATION_LINE_CHARS = 120;

/** Terms that, at the start of a line, mean "this is the next FIELD, not more
 * address". `FORBIDDEN_LABEL_TERMS` supplies the PII half for free; the rest
 * is the financial/statement vocabulary this module sees in CAS, bank and
 * insurance documents. Terms that are plausible as the first word of a real
 * street line are deliberately ABSENT (`unit`, `block`, `branch`, `road`,
 * `street`, `floor`, `plot`, `house`) — a stop-term that fires on a genuine
 * address line under-captures, which is a leak. Two known imperfect entries
 * are kept and disclosed rather than hidden: `mobile` (Mobile, Alabama) and
 * `pan` (Pan Bazaar, Guwahati) can each begin a real address line somewhere
 * in the world, but both are overwhelmingly field labels in the AU/India
 * documents this module actually sees, and the cost of the rare miss is one
 * unmasked line rather than a destroyed financial field. */
const ADDRESS_STOP_TERMS: readonly string[] = [
  ...FORBIDDEN_LABEL_TERMS,
  'pan', 'folio', 'policy', 'certificate', 'premium', 'sum insured', 'sum assured',
  'insurer', 'insured', 'nominee', 'investor', 'beneficiary', 'applicant', 'proposer',
  'holder', 'scheme', 'fund', 'isin', 'arn', 'nav', 'units', 'balance', 'amount',
  'total', 'sub total', 'subtotal', 'opening', 'closing', 'currency', 'date',
  'statement', 'period', 'renewal', 'product', 'plan', 'type', 'frequency',
  'gstin', 'gst', 'tax', 'transaction', 'deposit', 'withdrawal', 'interest',
  'maturity', 'contact', 'customer', 'reference', 'page', 'signature',
  // AIE unified document fallback (2026-09-23). The labels the three new
  // identifier rules above anchor on must also be able to TERMINATE an address
  // continuation, or a 3-line postal address printed immediately above
  // `HIN: X0001234567` would swallow the HIN line into the address token.
  // That is over-capture, not a leak (the HIN is still masked) — but it
  // destroys a label the adapter reads and makes `coverage_by_type` report an
  // address where the document actually had an address AND a holder id, which
  // is the same inaccurate-privacy-evidence failure this list already exists
  // to prevent.
  'hin', 'srn', 'member', 'membership', 'loan', 'crn', 'client',
];

const ADDRESS_STOP_TERM_ALTERNATION = ADDRESS_STOP_TERMS
  // Escape regex metacharacters, then let any literal space in a multi-word
  // term match runs of spaces WITHOUT crossing a line ending — the same
  // `[^\S\r\n]` discipline M12B established everywhere else in this file.
  .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +/g, '[^\\S\\r\\n]+'))
  .join('|');

/**
 * The stop-conditions, evaluated as lookaheads at the START of each candidate
 * continuation line. Consumption ends at the FIRST line that trips any of
 * them. Order here is cosmetic (they are all zero-width and all must pass);
 * the list is what matters.
 */
const ADDRESS_CONTINUATION_GUARDS = [
  // (a) SECTION BOUNDARY — a blank or whitespace-only line ends the field.
  '(?=[^\\S\\r\\n]*\\S)',
  // (b) ALREADY-MASKED CONTENT. A line carrying a placeholder an earlier rule
  // wrote is never swallowed. Without this, one masked PAN three lines below
  // an address would poison the ENTIRE multi-line capture via `maskText`'s
  // `sensitive.includes('[MASKED:')` check, and the address would then be left
  // wholly unmasked — a strictly worse outcome than not extending at all.
  '(?![^\\r\\n]*\\[MASKED:)',
  // (c) A RECOGNISED FIELD LABEL, colon or no colon. `PAN ABCDE1234F` on its
  // own line is the next field even though it prints no separator.
  `(?![^\\S\\r\\n]*(?:${ADDRESS_STOP_TERM_ALTERNATION})\\b)`,
  // (d) ANY generic `Label:` line shape, for labels the vocabulary above does
  // not know. Only `:` counts — `-` and `.` are common INSIDE address lines
  // ("Flat 5 - B Wing", "St. Mary's Road") and would stop far too eagerly.
  "(?![^\\S\\r\\n]*[A-Za-z][A-Za-z0-9 /#.&'()-]{0,40}:)",
  // (e) TABLE: pipe- or tab-delimited.
  '(?![^\\r\\n]*[|\\t])',
  // (f) TABLE: a horizontal rule / separator line.
  '(?![^\\S\\r\\n]*[-=_*~]{4,})',
  // (g) TABLE: three or more whitespace-delimited columns (two runs of 2+
  // spaces). Deliberately 3 columns and not 2 — PDF text extraction routinely
  // leaves a double space inside one wrapped address line, so a 2-column
  // threshold would stop on genuine addresses, whereas 3 aligned columns is a
  // table header or row in every layout this repository parses.
  '(?!(?:[^\\r\\n]*?\\S[^\\S\\r\\n]{2,}){2})',
  // (h) MONEY-SHAPED — a currency symbol anywhere, or a 2-decimal amount.
  // `(?!\\d)` after the cents keeps this off unit/NAV figures like `1234.567`,
  // which are caught by (g) or by their own row's money column instead.
  '(?![^\\r\\n]*(?:[$\\u20B9\\u00A3\\u20AC\\u00A5]|\\d[\\d,]*\\.\\d{2}(?!\\d)))',
  // (i) DATE-LED — `31/08/2027`, `2027-08-31`, `31 Aug 2027`, `31 March 2027`.
  // THE SPELLED-OUT-MONTH BRANCH IS WHY THIS IS NOT JUST `\d{1,2}\s+(jan|...)`:
  // the rule runs case-insensitively, so that shorter form matched "12 Mar"
  // inside `12 Marigold Avenue` and stopped the capture on the second line of
  // a perfectly ordinary address. Caught by the 4-line test, which went from
  // red to a DIFFERENT red rather than to green. The branch therefore also
  // requires a trailing YEAR/day number, which prose after a house number
  // does not have.
  '(?![^\\S\\r\\n]*(?:\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}' +
    '|\\d{1,2}[^\\S\\r\\n]+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]{0,6}\\.?[^\\S\\r\\n]+\\d{2,4}\\b))',
].join('');

/** `{0,N}` repetitions of "a newline, then a line that trips no guard and is
 * consumed IN FULL". Ending each repetition on `(?=\r?\n|$)` is what makes
 * the cap a LINE cap rather than a character cap, and is also what keeps the
 * terminating newline out of the capture so the document's line structure
 * below the address survives. */
const ADDRESS_CONTINUATION =
  `(?:\\r?\\n${ADDRESS_CONTINUATION_GUARDS}[^\\r\\n]{1,${ADDRESS_MAX_CONTINUATION_LINE_CHARS}}(?=\\r?\\n|$))` +
  `{0,${ADDRESS_MAX_CONTINUATION_LINES}}`;

const ADDRESS_PATTERN = new RegExp(
  '\\b(?<!e-?mail )' +
    '((?:residential[^\\S\\r\\n]*address|correspondence[^\\S\\r\\n]*address|permanent[^\\S\\r\\n]*address' +
    '|mailing[^\\S\\r\\n]*address|registered[^\\S\\r\\n]*address|address)[^\\S\\r\\n]*[:.\\-][^\\S\\r\\n]*)' +
    `([^\\r\\n]{5,160}${ADDRESS_CONTINUATION})`,
  'gi',
);

/** Carried over verbatim in substance from
 * `lib/financial-data-hub/payslip/privacy.ts`'s `SENSITIVE_PATTERNS`, plus
 * `textUtils.ts`'s PAN shape (already covered by the 5-letter/4-digit/
 * 1-letter pattern below) and new card/phone detectors AIE-1.1 needs that
 * neither existing file has. */
const PII_PATTERNS: PiiPattern[] = [
  // ---- M2 (H.9). ORDER IS LOAD-BEARING: these run FIRST because they are
  // the high-precision rules, and `maskText` applies patterns in array order
  // over progressively-masked text, so whichever rule matches first owns the
  // span. Put below the generic digit rules, a folio like `12345678/90` is
  // swallowed by the AU-TFN rule (`\d{3}\d{3}\d{2,3}` matches `12345678`)
  // and gets tagged `tax_id` — still masked, but mislabelled, which corrupts
  // `aie_masking_summary.coverage_by_type` and makes the privacy evidence
  // say something untrue about what the document contained.

  // Mutual-fund folio number. Folio formats are genuinely not uniform
  // (`1234567/89`, `12345678`, `91234567-01`, alphanumeric registrar codes),
  // so a bare shape rule would be either uselessly narrow or would swallow
  // unit/NAV figures. This is therefore LABEL-ANCHORED: it matches only a
  // value the document itself introduces as a folio. The label is kept and
  // only the value is tokenised, so an adapter can still see that a folio
  // field was present — which is what it needs for structure — without the
  // identifier itself leaving the process.
  // The value charset deliberately EXCLUDES whitespace. An earlier M2 draft
  // allowed spaces inside the value, and on a real CAS line
  // (`Folio No: 12345678/90   IFSC: HDFC0001234`) it greedily ran across the
  // gap and swallowed the *next field's label* into the folio token. That
  // over-captures rather than under-captures, so it was not a privacy leak,
  // but it destroyed a label a downstream adapter needs and made
  // `coverage_by_type` describe the document inaccurately.
  { type: 'folio_number', pattern: /\b(folio(?:\s*(?:no|number|#))?\s*[:.\-]?\s*)([A-Z0-9][A-Z0-9/\-]{2,24})/gi, valueGroup: 2 },

  // M12B (M12B-F1) — INSURANCE POLICY NUMBER. An account-class identifier
  // with no rule of any kind before this phase. The generic numeric rules
  // below cannot reach it: `long_digit_run` needs 11+ digits, `card_number`
  // needs 13-19, `bank_account` needs a BSB-shaped 12-16, and the AU-TFN rule
  // needs a word boundary after 8-9 — so a perfectly ordinary 10-digit policy
  // number matched NOTHING and egressed verbatim. Proved on a real pipeline
  // run by M12B's own egress-boundary privacy proof (`INS-B05`), not by
  // inspection.
  //
  // LABEL-ANCHORED, for the same reason the folio rule is: policy-number
  // formats are genuinely not uniform across insurers (pure digits, letter
  // prefixes, slashed and hyphenated group/member forms), so a bare shape rule
  // would either be uselessly narrow or would swallow sums insured and
  // premiums. Only a value the document itself introduces as a policy number
  // is tokenised, and the LABEL survives so an adapter can still see that the
  // field was present — which is exactly what `insurance/parser.ts` needs for
  // structure.
  //
  // The value charset deliberately excludes whitespace, carrying forward the
  // fix the folio rule already needed: allowing spaces let it run across the
  // gap on a real statement line and swallow the next field's label.
  // `certificate no` and `member no` are included because renewal and group
  // notices print the same identifier under those names.
  //
  // THE GAP BETWEEN LABEL AND VALUE IS `[^\S\r\n]*`, NOT `\s*`, AND THAT IS
  // LOAD-BEARING. Written with `\s*` this rule produced a false positive the
  // moment it started working: once the value is replaced by a placeholder and
  // the guard strips placeholders before re-scanning, `Policy Number: <gone>`
  // followed by `Policy Owner: ...` on the next line let `\s*` cross the line
  // ending and match the literal word "Policy" as the value (the `i` flag
  // makes `[A-Z0-9]` match lowercase too). `containsUnmaskedPii` then reported
  // residual PII on fully-masked text and the gateway refused every payload —
  // the same class of false alarm as M12B-F2 itself, reintroduced by its own
  // fix. Requiring the value on the label's own line is also exactly the
  // bounded generic layout `adapters/insurance/labels.ts` certifies ("plain
  // Label: Value lines, one fact per line"), so this costs no real coverage.
  {
    type: 'policy_number',
    pattern: /\b((?:policy|certificate|member)[^\S\r\n]*(?:no|number|#|ref|reference)\.?[^\S\r\n]*[:.\-][^\S\r\n]*)([A-Z0-9][A-Z0-9/\-]{3,24})/gi,
    valueGroup: 2,
  },

  // ---- AIE unified document fallback (2026-09-23). THREE NEW RULES.
  //
  // All three were found the same way M2 and M12B found theirs: not by
  // inspection, but by running the new adapters' masking over synthetic
  // documents through a CAPTURING test provider and reading the payload that
  // would actually have left the process
  // (`tests/unit/aieUnifiedFallbackMaskingEgress.test.ts`). All three are
  // LABEL-ANCHORED for the reason the folio and policy-number rules above
  // already establish — these identifier formats are genuinely not uniform,
  // so a bare shape rule is either uselessly narrow or swallows the money
  // figures the adapters exist to read — and all three keep the LABEL via
  // `valueGroup: 2` so a downstream adapter still sees that the field was
  // present. Every gap is `[^\S\r\n]*`, never `\s*`, carrying forward the
  // M12B-F3 fix: `\s*` crosses a line ending, so an EMPTY labelled field
  // reaches down and tokenises whatever is printed on the next line.
  //
  // THEY SIT HERE, ABOVE `person_name_label` AND ABOVE THE GENERIC DIGIT
  // RULES, DELIBERATELY. `maskText` applies patterns in array order over
  // progressively-masked text, so the first rule to match owns the span. Put
  // below `long_digit_run`/`tax_id`, an 11-digit member number would be
  // masked but tagged `long_digit_run`, which is the
  // "coverage_by_type says something untrue about the document" failure the
  // array's own opening comment describes.

  // AU HOLDER IDENTIFICATION NUMBER (HIN) / SECURITYHOLDER REFERENCE NUMBER
  // (SRN). The identifier that uniquely names a holding on the ASX CHESS
  // register or an issuer-sponsored share registry, printed on essentially
  // every real broker and registry statement (`HIN: X0001234567`,
  // `SRN: I0001234567`).
  //
  // BEFORE THIS RULE IT MATCHED NOTHING AND EGRESSED VERBATIM — the identical
  // structural gap M12B-F1 records for insurance policy numbers. A HIN is a
  // letter followed by 10 digits: `long_digit_run` needs 11+, `card_number`
  // needs 13-19, `bank_account` needs a BSB-shaped prefix, and the AU-TFN rule
  // needs a word boundary after 8-9 digits which a 10-digit run does not
  // provide (and the `X` prefix removes the leading boundary too). Confirmed
  // by capture, not by reading the regexes.
  {
    type: 'holder_identification_number',
    pattern:
      /\b((?:hin|srn|holder[^\S\r\n]*identification(?:[^\S\r\n]*(?:no|number))?|securityholder[^\S\r\n]*reference(?:[^\S\r\n]*(?:no|number))?|shareholder[^\S\r\n]*reference(?:[^\S\r\n]*(?:no|number))?)\.?[^\S\r\n]*[:.\-][^\S\r\n]*)([A-Z0-9][A-Z0-9/\-]{3,24})/gi,
    valueGroup: 2,
  },

  // MEMBER / CUSTOMER / CLIENT / LOAN-ACCOUNT / CRN REFERENCE. The
  // account-class identifier on a retirement statement (`Member No: 4821993`),
  // a liability statement (`Loan Account: HL-00482913`, `CRN: 194872`) and a
  // broker statement (`Client Number: 88213`).
  //
  // The `policy_number` rule above already covers `Member Number: …` because
  // `member` is in its alternation — but ONLY when the label carries an
  // explicit `no`/`number`/`ref` word. Real statements print `Member: 4821993`
  // and `Membership No: …` just as often, and neither matched. A bare 7-10
  // digit account number matched nothing at all (below `long_digit_run`'s
  // 11-digit floor).
  //
  // `valuePredicate` REQUIRING A DIGIT IS LOAD-BEARING, NOT DEFENSIVE. Without
  // it, `Member: JANE CITIZEN` would match here — this rule runs BEFORE
  // `person_name_label` — and tokenise only the first word, leaving `CITIZEN`
  // in the clear AND mislabelling a person's name as an account reference.
  // Requiring a digit in the value means a name-valued label falls through to
  // the name rule below, which is where it belongs. `account`/`a/c` are
  // included for the same reason the M12B header gives for `certificate no`:
  // the same identifier is printed under several names across issuers.
  {
    type: 'account_reference',
    pattern:
      /\b((?:member|membership|customer|client|loan|crn|a\/c|account)[^\S\r\n]*(?:account|no|number|id|#|ref|reference)?\.?[^\S\r\n]*[:.\-][^\S\r\n]*)([A-Z0-9][A-Z0-9/\-]{3,24})/gi,
    valueGroup: 2,
    // See the header: a value with no digit in it is a NAME, not a reference,
    // and must be left for `person_name_label` to own.
    valuePredicate: (value) => /\d/.test(value),
  },

  // DATE OF BIRTH. Printed on retirement/super member statements and on many
  // insurance and loan documents. `date of birth`/`dob` have been in
  // `FORBIDDEN_LABEL_TERMS` since AIE-1.1 — but that list is ONLY read by
  // `isBelowMaskingPolicy`, whose sole callers pass `labelsSeenRaw: []`, so it
  // has never once fired. No regex masked the VALUE, so a member's date of
  // birth egressed verbatim.
  //
  // LABEL-ANCHORED and nothing else, deliberately: a bare date rule would
  // tokenise every statement period, payment date and valuation date in the
  // document — which is to say, exactly the fields every one of these adapters
  // exists to read. Only a date the document itself introduces as a birth date
  // is masked. Both the numeric (`14/03/1978`, `1978-03-14`) and the
  // spelled-month (`14 March 1978`) forms are covered, because AU and India
  // statements print both.
  {
    type: 'date_of_birth',
    pattern:
      /\b((?:date[^\S\r\n]*of[^\S\r\n]*birth|birth[^\S\r\n]*date|d\.?o\.?b\.?)[^\S\r\n]*[:.\-][^\S\r\n]*)(\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}|\d{1,2}[^\S\r\n]+[A-Za-z]{3,9}[^\S\r\n]+\d{2,4})/gi,
    valueGroup: 2,
  },

  // STANDALONE AU BSB. The generic `bank_account` rule below
  // (`\b\d{3}-?\d{3}\s?\d{6,10}\b`) requires the BSB and the account digits to
  // be ADJACENT. A real payslip or liability statement prints them as two
  // separately-labelled fields — `BSB: 062-000` on one line, `Account: 1234
  // 5678` on the next — and the six-digit BSB alone matched nothing. Reported
  // as a disclosed residual exposure by the payslip dispatch
  // (`AIE_UNIFIED_DOCUMENT_FALLBACK_DESIGN_2026_09_22.md` §6.3) rather than
  // fixed there because it is a shared-pattern limit, not a payslip bug;
  // closed here, where four more document types depend on it.
  //
  // Tagged `bank_account`, not a new type: it IS a bank account identifier,
  // and splitting it would make `coverage_by_type` report two categories for
  // what a reader would call one. Label-anchored so it cannot swallow an
  // ordinary six-digit figure.
  {
    type: 'bank_account',
    pattern: /\b(bsb(?:[^\S\r\n]*(?:no|number|code))?\.?[^\S\r\n]*[:.\-][^\S\r\n]*)(\d{3}[- ]?\d{3})\b/gi,
    valueGroup: 2,
  },

  // Person / holder / nominee NAME. Global invariant D.6 requires holder
  // names to be excluded or tokenised where not required, and nominee
  // details never to egress. Before M2 there was NO name rule of any kind —
  // `FORBIDDEN_LABEL_TERMS` nominally mentioned `name` and `account holder`,
  // but that list is only consulted by `isBelowMaskingPolicy`, which its
  // sole caller invokes with an empty array, so it could never fire. A
  // holder name therefore reached the provider verbatim. This was caught by
  // M2's own live provider proof, not by inspection.
  //
  // LABEL-ANCHORED, and deliberately does NOT include a bare `name`
  // alternative: `Scheme Name: NIPPON INDIA LIQUID FUND` would then match
  // and mask the scheme name, which is exactly the non-personal field the
  // adapter exists to read. Only unambiguously person-bearing labels are
  // listed. Bounded to 5 words so a runaway match cannot eat a paragraph.
  {
    type: 'person_name_label',
    // M12B (M12B-F1) — INSURANCE LABELS ADDED. The alternation below was
    // written for CAS/investment statements and contained only that
    // vocabulary (`investor`, `unit holder`, `nominee`, ...). An insurance
    // policy schedule names the same kind of person under entirely different
    // labels — `Policy Owner:`, `Insured Person:`, `Life Insured:` — none of
    // which appeared here, so an insurance document's policy-owner and
    // insured-person names reached the provider VERBATIM. Found by M12B's own
    // privacy proof at the egress boundary, on a real pipeline run, not by
    // inspection: `INS-B05` egressed "Reese Ellis Vaughn" in the outbound
    // OpenAI request body while `aie_masking_summary.coverage_by_type` for
    // that run was literally `{}`.
    //
    // `insured` is deliberately NOT added as a bare alternative: `Sum Insured`
    // is a MONEY field, and matching it here would tokenise the cover amount —
    // exactly the mis-bucketing `labels.ts` already had to add an `unless`
    // veto for on the adapter side. Only unambiguously person-bearing
    // multi-word labels are listed.
    //
    // M12B (M12B-F3) — `\s` REPLACED BY AN EXPLICIT NON-NEWLINE CLASS in the
    // value. `\s` matches `\n`, so on any document where a name is the last
    // thing on its line this rule ran past the line ending and swallowed the
    // NEXT line's LABEL into the token: on `INS-B13` it captured
    // "Rohan Prakash Iyer\nPAN Number" as one person name, destroying the
    // `PAN Number:` label a downstream adapter needs and making
    // `coverage_by_type` describe the document inaccurately. That is the same
    // over-capture failure the folio rule above was narrowed for during M2,
    // and the same reasoning applies: over-capturing is not a leak, but it
    // destroys structure and corrupts the privacy evidence. A person's name
    // never spans a line break in these layouts, so the value is now bounded
    // to its own line.
    // The GAP BETWEEN THE COLON AND THE VALUE is `[^\S\r\n]*` for the same
    // reason as the value's own internal spacing, and it is the half that
    // actually bites: `\s*` there let the rule skip a line ending entirely, so
    // a label with an EMPTY value — `Policy Owner:` on its own line — matched
    // whatever was printed on the NEXT line and tokenised that instead.
    // `Policy Owner:` followed by `Sum Insured: 42,000.00` masked the words
    // "Sum Insured". This is latent in the raw-text path too (any document
    // printing an empty labelled field), and it is what `containsUnmaskedPii`
    // kept tripping on after M12B-F2's strip replaced each placeholder with
    // whitespace. A person's name is on the label's own line in every layout
    // this repository parses.
    // 2026-09-22 (AIE payslip AI-fallback adapter build) — `employee`/
    // `employee name` ADDED. Found the identical class of gap M12B found and
    // fixed for insurance's `Policy Owner:`/`Insured Person:` labels (this
    // rule's own header above), this time live-testing the NEW payslip
    // adapter's masking of a synthetic payslip against the real provider
    // (`tests/live-dev/aiePayslipAdapterLiveProviderProof.live.test.ts`): an
    // AU/India payslip's single most common person-bearing label — `Employee:`
    // / `Employee Name:` — was not in this alternation, so a real payslip's
    // employee name would have egressed to the AI provider VERBATIM the
    // moment `AIE_PAYSLIP_AI_FALLBACK_ENABLED`/`AIE_AI_FALLBACK_ENABLED` were
    // both turned on. `employer` is deliberately NOT added: an employer NAME
    // is a business name FDH-9's own extraction is supposed to read (the
    // `employerName` canonical field), not personal PII to redact — masking
    // it would defeat the adapter's own purpose, the same "unless" reasoning
    // this rule's header already applies to `insured` vs `Sum Insured`.
    pattern:
      /\b((?:investor|account[^\S\r\n]*holder|unit[^\S\r\n]*holder|first[^\S\r\n]*holder|second[^\S\r\n]*holder|joint[^\S\r\n]*holder|holder|nominee|beneficiary|applicant|policy[^\S\r\n]*owner|policy[^\S\r\n]*holder|insured[^\S\r\n]*person|insured[^\S\r\n]*name|life[^\S\r\n]*insured|life[^\S\r\n]*assured|proposer|employee)(?:[^\S\r\n]*name)?[^\S\r\n]*[:.\-][^\S\r\n]*)([A-Za-z][A-Za-z.'-]*(?:[^\S\r\n]+[A-Za-z][A-Za-z.'-]*){0,4})/gi,
    valueGroup: 2,
    // The label must match case-insensitively (`Investor:`, `INVESTOR:`,
    // `investor:` all occur in real statements), so the value needs its
    // capitalisation guard here rather than in the pattern. A real holder
    // name is Title Case or ALL CAPS; requiring at least one capital keeps
    // this from matching prose that happens to follow one of these labels.
    valuePredicate: (value) => /[A-Z]/.test(value),
  },

  // M3 (Phase 4) — ADDRESS. Closes M2-OPEN-7, which recorded address as the
  // one D.6 category still with no rule of any kind. LABEL-ANCHORED for the
  // same reason as the two rules above: there is no shape a street address
  // reliably has, so the only dependable signal is the label the document
  // itself prints. Captures to end of line.
  //
  // M3's DISCLOSED LIMITATION — "a postal address printed across several
  // lines is masked on its FIRST line only", tracked as `M3-OPEN-2` — IS NOW
  // CLOSED, conservatively. The capture extends across newlines, but ONLY via
  // the bounded, stop-condition-terminated continuation defined above
  // (`ADDRESS_CONTINUATION`): at most `ADDRESS_MAX_CONTINUATION_LINES` further
  // lines, each at most `ADDRESS_MAX_CONTINUATION_LINE_CHARS` characters and
  // consumed only in full, halting at the first recognised field label, table
  // shape, blank line, money-shaped line, date-led line or already-masked
  // line. M3's objection — that an open-ended newline capture "would run on
  // and swallow the next labelled field" — is not answered by ignoring it but
  // by refusing to be open-ended. See the block comment above
  // `ADDRESS_MAX_CONTINUATION_LINES` for the counting decision (a wrapped
  // address is ONE `address_label`, not one per line) and for what remains
  // out of reach (a 5th line; a continuation line that genuinely begins with
  // a stop term).
  //
  // WHAT IS STILL FIRST-LINE-ONLY, STATED PLAINLY: nothing about an
  // UNLABELLED address. A postal address that the document never introduces
  // with a recognisable label is not matched at all, before or after M12C —
  // this rule has always been label-anchored because a street address has no
  // reliable shape, and that is unchanged.
  //
  // The `(?<!e-?mail )` lookbehind is load-bearing, not defensive padding:
  // real statements print `Email Address: investor@example.com`, and without
  // it this rule would claim that span before the email rule ever ran. The
  // value would still be masked — so this is not a leak — but it would be
  // recorded as an `address_label` in `aie_masking_summary.coverage_by_type`,
  // which is the same "privacy evidence describes the document inaccurately"
  // failure M2 fixed for the AU-TFN-vs-folio ordering.
  //
  // M12B: the gap between the colon and the value is `[^\S\r\n]*`, not `\s*`,
  // for exactly the reason given on the person-name rule above — so that an
  // EMPTY `Residential Address:` line cannot silently claim the whole of the
  // next line as an address. That is what kept `containsUnmaskedPii`
  // reporting residual PII on fully-masked text after M12B-F2's strip.
  // M12C PRESERVES THIS EXACTLY and it is load-bearing for the new
  // continuation too: the FIRST line of the value is still mandatory
  // (`[^\r\n]{5,160}`) and still has to be on the label's own line, so a
  // label with no value gets no continuation either — an empty address label
  // cannot reach down and claim three lines instead of one.
  {
    type: 'address_label',
    pattern: ADDRESS_PATTERN,
    valueGroup: 2,
  },

  // India Aadhaar, canonical spaced form `1234 5678 9012`. A real Aadhaar
  // never begins with 0 or 1, which is what keeps this from eating ordinary
  // 12-digit money figures grouped in fours. The UNSPACED form was already
  // incidentally caught by `long_digit_run` (11+ digits); the spaced form
  // matched nothing before M2, because the card rule needs 13-19 digits and
  // the TFN rule needs a word boundary after 8-9.
  { type: 'aadhaar', pattern: /\b[2-9]\d{3}\s\d{4}\s\d{4}\b/g },

  // India IFSC: 4 letters, a literal 0, then 6 alphanumerics. Fixed shape,
  // so this is a low-false-positive rule.
  { type: 'ifsc', pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },

  // ---- pre-M2 rules, unchanged.
  // AU Tax File Number: 8-9 digits, usually spaced 3-3-3.
  { type: 'tax_id', pattern: /\b\d{3}\s?\d{3}\s?\d{2,3}\b(?=[^\d]|$)/g },
  // India PAN: 5 letters, 4 digits, 1 letter.
  { type: 'tax_id', pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  // AU BSB + account, e.g. 062-000 12345678
  { type: 'bank_account', pattern: /\b\d{3}-?\d{3}\s?\d{6,10}\b/g },
  // Card-like 13-19 digit runs, optionally grouped in 4s.
  { type: 'card_number', pattern: /\b(?:\d[ -]?){13,19}\b/g },
  // Long bare account-like digit runs (11+ digits) not already matched above.
  { type: 'long_digit_run', pattern: /\b\d{11,}\b/g },
  // Email addresses.
  { type: 'email', pattern: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g },
  // AU/India-shaped phone numbers (+61/0 mobile, +91 mobile — deliberately
  // narrow rather than a generic "any 10-digit run", to avoid swallowing
  // legitimate non-phone financial figures).
  { type: 'phone', pattern: /\b(?:\+?61|0)4\d{2}[ -]?\d{3}[ -]?\d{3}\b|\b\+?91[ -]?[6-9]\d{9}\b/g },
];

/** M12C: `FORBIDDEN_LABEL_TERMS` itself now lives ABOVE `PII_PATTERNS` (see
 * the note on its declaration) because the address rule's stop-vocabulary
 * reads it at module-initialisation time. Only the declaration moved; the
 * list is byte-identical and this accessor is unchanged. */
export function isForbiddenLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return FORBIDDEN_LABEL_TERMS.some((term) => lower.includes(term));
}

export interface MaskingResult {
  maskedText: string;
  /** Counts by detected type ONLY — matches
   * `aie_masking_summary.coverage_by_type`'s "counts, never matched text"
   * discipline (PII-11). */
  coverageByType: Partial<Record<AiePiiType, number>>;
  totalMatches: number;
  /**
   * M3 — how many DISTINCT identifier values were tokenised (as opposed to
   * `totalMatches`, which counts occurrences). Recorded because a one-way
   * scheme has no map to count, and privacy evidence still needs to be able
   * to say "this document contained N distinct identifiers" without holding
   * any of them.
   *
   * NOTE what is deliberately absent from this type: there is no
   * `reversibleTokenMap` any more. It was removed, not renamed — no caller
   * can obtain the original values from this function's result, because the
   * function no longer retains them past the `.replace()` callback that
   * MAC'd them.
   */
  distinctIdentifierCount: number;
}

/**
 * Masks every recognised PII pattern in `text`, replacing each match with a
 * KEYED ONE-WAY HMAC pseudonym (PII-06: "collision-resistant tokens, prevent
 * cross-user correlation"; D.6: "stable pseudonyms via keyed one-way HMAC,
 * never reversible/dictionary-vulnerable").
 *
 * `tenantKey` (the authenticated user id) is REQUIRED and has no default.
 * It is part of the MAC input, so tokens are stable within one tenant and
 * uncorrelatable across tenants. Making it optional would let a caller
 * silently produce globally-correlatable pseudonyms, which is the precise
 * failure PII-06 exists to prevent — so it is a required field rather than a
 * defaulted one.
 *
 * THROWS if `AIE_MASK_TOKEN_ENCRYPTION_KEY` is unset or malformed. That is
 * the intended fail-closed behaviour and it is load-bearing: no key means no
 * tokenisation, which means the caller cannot construct an AI payload, which
 * means nothing egresses. It is never downgraded to an unkeyed hash.
 */
export function maskText(text: string, opts: { tenantKey: string }): MaskingResult {
  let masked = text;
  const coverageByType: Partial<Record<AiePiiType, number>> = {};
  let totalMatches = 0;
  // Raw value -> its derived token, so the same value occurring many times in
  // one document is MAC'd once rather than once per occurrence. This map is
  // local to the call and is never returned, logged or persisted; it dies
  // with this function's stack frame.
  const tokensForValue = new Map<string, string>();

  for (const { type, pattern, valueGroup, valuePredicate } of PII_PATTERNS) {
    masked = masked.replace(pattern, (...args: unknown[]) => {
      const match = args[0] as string;
      // `replace` passes (match, ...groups, offset, string) — groups are
      // everything between the match and the trailing offset/string pair.
      const groups = args.slice(1, -2) as (string | undefined)[];

      // A label-anchored rule tokenises ONLY its value group; the sensitive
      // value is `sensitive`, and `prefix` is the non-sensitive label text
      // that is written back verbatim.
      const sensitive = valueGroup === undefined ? match : groups[valueGroup - 1];
      if (sensitive === undefined || sensitive === '') return match;

      // M3: never re-tokenise something an EARLIER pattern already replaced.
      // `maskText` applies patterns in sequence over progressively-masked
      // text, so a later open-ended rule (the address rule captures to end of
      // line) can otherwise swallow a placeholder a previous rule wrote and
      // MAC it a second time — producing a token of a token, double-counting
      // `coverageByType`, and destroying the stability property the one-way
      // scheme exists to provide. Applies to every rule, so a future
      // open-ended pattern inherits the protection automatically rather than
      // needing to remember it.
      if (sensitive.includes('[MASKED:')) return match;

      if (valuePredicate !== undefined && !valuePredicate(sensitive)) return match;

      let token = tokensForValue.get(sensitive);
      if (!token) {
        token = deriveIdentifierToken({ tenantKey: opts.tenantKey, type, value: sensitive });
        tokensForValue.set(sensitive, token);
      }
      coverageByType[type] = (coverageByType[type] ?? 0) + 1;
      totalMatches += 1;

      if (valueGroup === undefined) return token;
      // Rebuild the match with only the value group replaced, so the label
      // survives. Uses the LAST occurrence so a value that also appears
      // inside the label text cannot shift the splice point.
      const at = match.lastIndexOf(sensitive);
      return match.slice(0, at) + token + match.slice(at + sensitive.length);
    });
  }

  return { maskedText: masked, coverageByType, totalMatches, distinctIdentifierCount: tokensForValue.size };
}

/** PAN display-masking convention carried over from `textUtils.ts.maskPan`
 * (first 5, last 1 visible) — used when a masked SUMMARY needs to show a
 * partial identifier to a reviewer rather than a fully opaque token. */
export function maskPanForDisplay(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim().toUpperCase();
  if (!/^[A-Z]{5}\d{4}[A-Z]$/.test(s)) return s;
  return `${s.slice(0, 5)}****${s.slice(9)}`;
}

/**
 * PII-10: "calculate masking coverage/uncertainty by type and block AI when
 * below admission policy." A minimal, explicit policy: any label matching
 * `isForbiddenLabel` found UNMASKED in the candidate text is an automatic
 * block (never let a forbidden-label value slip through as an "acceptable
 * residual"), independent of overall coverage numbers.
 */
export function isBelowMaskingPolicy(input: { maskedText: string; labelsSeenRaw: string[] }): boolean {
  const stillContainsForbiddenLabelValue = input.labelsSeenRaw.some((label) => isForbiddenLabel(label));
  return stillContainsForbiddenLabelValue;
}

/**
 * Defensive re-scan (PAY-04/GW guard): confirms a payload about to leave
 * the privacy boundary contains no residual raw PII pattern match. This is
 * NOT the primary masking control (that is `maskText` above, run earlier in
 * the pipeline) — it is a second, independent check the AI gateway runs
 * immediately before constructing a provider payload, so a bug in an
 * upstream caller that forgot to mask cannot silently reach the provider.
 */
export function containsUnmaskedPii(text: string): boolean {
  return firstResidualPiiType(text) !== null;
}

/**
 * M12B (M12B-F2). The guard now asks the ONE question it was always meant to
 * ask: *would `maskText` still find something here to mask?* — and it answers
 * it by applying `maskText`'s own per-match acceptance logic rather than a
 * bare `pattern.test()`.
 *
 * THE DEFECT THIS CLOSES, AND WHY IT WAS NOT HARMLESS. `maskText` refuses to
 * re-tokenise something an earlier pattern already replaced: the
 * `sensitive.includes('[MASKED:')` check in its replace callback, added in M3
 * for exactly this reason. `containsUnmaskedPii` had no equivalent check, and
 * the address rule's value group is `[^\r\n]{5,160}` — it matches ANYTHING to
 * end of line, including a placeholder the masker itself had just written. So
 * on any document printing a labelled address, `Residential Address:
 * [MASKED:...]` re-matched the address rule and the guard reported residual
 * PII in text that was in fact completely masked.
 *
 * The consequence was not a leak — it fails CLOSED, and the gateway returned
 * `unmasked_pii_detected` and never called the provider. It was harmful in a
 * subtler way: it made a correctly-masked document INDISTINGUISHABLE from a
 * leaking one, so the guard's own signal carried no information, and it made
 * the AI fallback permanently unreachable for essentially every real insurance
 * policy, all of which print an address. M12B's own privacy proof recorded
 * exactly that on `INS-B13`, where no payload was ever built at all.
 *
 * WHY NOT SIMPLY STRIP THE PLACEHOLDERS FIRST. That was tried and is wrong,
 * and the way it failed is worth recording because it is not obvious: removing
 * a placeholder leaves an EMPTY value slot behind a label that is still
 * printed, and every label-anchored rule then runs on and claims whatever text
 * comes next. On a real CAS header, `Folio No: <stripped>   IFSC: <stripped>`
 * made the folio rule match the literal word "IFSC" as a folio value, and the
 * guard went on reporting residual PII — a DIFFERENT false positive with the
 * same effect. Mirroring the masker's own logic has no such failure mode,
 * because it evaluates the text the masker actually produced.
 *
 * FAIL-CLOSED IS PRESERVED EXACTLY. Every genuinely unmasked value still
 * matches its pattern, still fails the `[MASKED:` check, still satisfies its
 * `valuePredicate`, and is still reported. The only matches now excluded are
 * ones `maskText` itself would decline to mask — i.e. ones that are already
 * masked.
 */
function firstResidualPiiType(text: string): AiePiiType | null {
  for (const { type, pattern, valueGroup, valuePredicate } of PII_PATTERNS) {
    pattern.lastIndex = 0; // global regexes carry state across calls
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      // A zero-length match would loop forever on a global regex.
      if (match[0] === '') {
        pattern.lastIndex += 1;
        continue;
      }
      const sensitive = valueGroup === undefined ? match[0] : match[valueGroup];
      // Exactly the three conditions `maskText`'s replace callback applies,
      // in the same order, for the same reasons.
      if (sensitive === undefined || sensitive === '') continue;
      if (sensitive.includes('[MASKED:')) continue;
      if (valuePredicate !== undefined && !valuePredicate(sensitive)) continue;
      return type;
    }
  }
  return null;
}
