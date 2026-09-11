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
 */

export type AiePiiType =
  | 'tax_id' // AU TFN / India PAN
  | 'bank_account'
  | 'card_number'
  | 'email'
  | 'phone'
  | 'person_name_label'
  | 'address_label'
  | 'long_digit_run';

interface PiiPattern {
  type: AiePiiType;
  pattern: RegExp;
}

/** Carried over verbatim in substance from
 * `lib/financial-data-hub/payslip/privacy.ts`'s `SENSITIVE_PATTERNS`, plus
 * `textUtils.ts`'s PAN shape (already covered by the 5-letter/4-digit/
 * 1-letter pattern below) and new card/phone detectors AIE-1.1 needs that
 * neither existing file has. */
const PII_PATTERNS: PiiPattern[] = [
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

/** Field LABELS whose entire value must be dropped rather than redacted —
 * carried over verbatim in substance from `FORBIDDEN_LABEL_TERMS`, extended
 * with person/address terms AIE-1.1's own spec calls for. */
const FORBIDDEN_LABEL_TERMS = [
  'tax file number', 'tfn', 'pan number', 'pan no', 'aadhaar', 'aadhar',
  'bank account', 'account number', 'account no', 'a/c no', 'ifsc', 'bsb',
  'employee id', 'employee no', 'employee code', 'emp id', 'emp code',
  'address', 'date of birth', 'dob', 'uan', 'esic', 'passport',
  'next of kin', 'emergency contact', 'phone', 'mobile',
  'name', 'account holder', 'card number', 'cvv',
];

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
   * SENSITIVE — token -> original raw matched value. NEVER log, audit, or
   * include this in any AI payload/response/error. Its ONLY legitimate
   * destination is `lib/aie/db/repository.ts`'s `persistMaskTokenMap`,
   * which encrypts every value before it reaches the database
   * (`aie_mask_token_map.ciphertext`, PII-08). Empty object when
   * `totalMatches` is 0.
   */
  reversibleTokenMap: Record<string, string>;
}

/**
 * Masks every recognised PII pattern in `text`, replacing each match with a
 * stable, collision-resistant placeholder token (PII-06: "collision-
 * resistant tokens, prevent cross-user correlation") scoped to THIS call
 * only (document-local placeholder scope, PII-05) — the same raw value
 * appearing twice in one document gets the same token within that call,
 * but two different documents (two different calls) never share a token
 * space, since each token embeds a fresh per-call salt.
 */
export function maskText(text: string, opts?: { callSalt?: string }): MaskingResult {
  const salt = opts?.callSalt ?? cryptoRandomSalt();
  let masked = text;
  const coverageByType: Partial<Record<AiePiiType, number>> = {};
  let totalMatches = 0;
  // Track raw-value -> token within this call so repeats of the same value
  // get the same placeholder (still never reversible without the encrypted
  // token map — see lib/aie/db/repository.ts's maskTokenMap persistence).
  const tokensForValue = new Map<string, string>();
  let counter = 0;

  for (const { type, pattern } of PII_PATTERNS) {
    masked = masked.replace(pattern, (match) => {
      let token = tokensForValue.get(match);
      if (!token) {
        counter += 1;
        token = `[MASKED:${type}:${salt}:${counter.toString(36)}]`;
        tokensForValue.set(match, token);
      }
      coverageByType[type] = (coverageByType[type] ?? 0) + 1;
      totalMatches += 1;
      return token;
    });
  }

  const reversibleTokenMap: Record<string, string> = {};
  for (const [rawValue, token] of tokensForValue.entries()) reversibleTokenMap[token] = rawValue;

  return { maskedText: masked, coverageByType, totalMatches, reversibleTokenMap };
}

function cryptoRandomSalt(): string {
  // Not security-critical (only needs to avoid cross-call token collision,
  // never reversibility) — Math.random is adequate here; the actual
  // sensitive material lives in aie_mask_token_map's encrypted ciphertext,
  // not in this salt. Letters only (digits stripped): a placeholder token
  // like "[MASKED:tax_id:ab12cd:3]" must never itself contain a 3+ digit
  // run that a LATER pattern in PII_PATTERNS could re-match on a
  // subsequent .replace() pass over the same (already partially masked)
  // string — this keeps every placeholder structurally immune to that.
  return Math.random().toString(36).replace(/[0-9]/g, 'x').slice(2, 10);
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
  return PII_PATTERNS.some(({ pattern }) => {
    pattern.lastIndex = 0; // global regexes carry state across .test() calls
    return pattern.test(text);
  });
}
