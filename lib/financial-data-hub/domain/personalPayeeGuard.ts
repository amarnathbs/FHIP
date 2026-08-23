/**
 * Financial Data Hub — the personal-payee / PII screening heuristic for the
 * global-learning governance workflow (FDH-2 specification section 29-37,
 * 55-64, 83-93).
 *
 * PURPOSE. Before any observed alias/narrative can become a global-learning
 * CANDIDATE (fdh_global_learning_candidates — never fdh_merchants or
 * fdh_classification_rules directly; see globalLearningGovernance.ts), it
 * must be screened. This is a SIMPLE, EXPLAINABLE heuristic — never complex
 * AI-based PII detection, per the specification. It is DELIBERATELY
 * conservative: a false positive here just means "held for admin review", so
 * over-flagging is the safe failure direction, and it is not applied to
 * FHIP's own hand-curated, admin-authored merchant/institution library
 * (which is verified by a human at authoring time, not by this heuristic).
 *
 * FDH-2 calls no code path that persists a screened candidate anywhere — see
 * globalLearningGovernance.ts for why. This module is pure and side-effect
 * free so it can be unit-tested and reused unchanged by whichever future
 * phase (FDH-6+) actually wires up candidate intake.
 */

export interface PersonalPayeeScreenResult {
  /** True if ANY reason fired. The caller must treat this as "hold for admin
   * review" — never as "safe to reject outright" and never as "safe to
   * auto-approve" when false (false only means this heuristic found nothing,
   * not that the text is guaranteed clean). */
  flagged: boolean;
  reasons: string[];
}

/**
 * A representative, non-exhaustive set of tokens that indicate a BUSINESS or
 * INSTITUTION identity rather than a private individual. Deliberately broad:
 * a genuine merchant name that happens to use none of these words will still
 * be flagged for human review, which is the intended conservative behaviour
 * (specification: "conservatively flagged/rejected rather than persisted").
 */
const BUSINESS_INDICATOR_WORDS = new Set([
  'BANK', 'BANKING', 'STORE', 'STORES', 'SHOP', 'SUPERMARKET', 'SUPERMARKETS',
  'MARKET', 'PHARMACY', 'CLINIC', 'HOSPITAL', 'HOSPITALS', 'SCHOOL', 'SCHOOLS',
  'COLLEGE', 'UNIVERSITY', 'LIMITED', 'LTD', 'GROUP', 'SERVICES', 'SERVICE',
  'SOLUTIONS', 'TECHNOLOGIES', 'TECHNOLOGY', 'PAYMENTS', 'PAYMENT', 'FINANCIAL',
  'FINANCE', 'CAPITAL', 'VENTURES', 'ENERGY', 'MOBILE', 'DIGITAL', 'ONLINE',
  'GLOBAL', 'INDIA', 'AUSTRALIA', 'PRIVATE', 'PVT', 'PLC', 'CORP', 'CORPORATION',
  'INC', 'HOLDINGS', 'FUND', 'TRUST', 'BROKING', 'BROKER', 'BROKERS',
  'SECURITIES', 'INSURANCE', 'MUTUAL', 'AIRLINES', 'AIRWAYS', 'HOTELS', 'HOTEL',
  'EXPRESS', 'DIRECT', 'WHOLESALE', 'RETAIL', 'ELECTRIC', 'ELECTRICITY',
  'POWER', 'GAS', 'WATER', 'TELECOM', 'TELECOMMUNICATIONS', 'PETROLEUM',
  'FUEL', 'RESTAURANT', 'RESTAURANTS', 'CAFE', 'CAFES', 'DEPARTMENT', 'RETAILER',
  'WAREHOUSE', 'ENTERPRISES', 'ENTERPRISE', 'INDUSTRIES', 'ASSOCIATION',
  'COMPANY', 'CO', 'AIRLINE', 'RAILWAYS', 'RAILWAY', 'TRANSPORT', 'LOGISTICS',
]);

const DIGIT_RUN = /\d{7,}/;
const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** A bare UPI-handle shape (no dot required — e.g. "ravikumar@paytm"). */
const UPI_HANDLE_PATTERN = /^[a-z0-9._-]{2,}@[a-z]{2,}$/i;
const TRANSFER_TO_PHRASE = /\b(TRANSFER TO|PAYMENT TO|PAID TO|SENT TO|TFR TO|TRF TO|FROM)\b/;

/**
 * Screen a candidate narrative/alias string. `rawText` should be the
 * observed text BEFORE the caller's own normalisation, so this function can
 * apply its own case-insensitive checks consistently.
 */
export function screenForPersonalPayee(rawText: string): PersonalPayeeScreenResult {
  const trimmed = rawText.trim();
  const normalised = trimmed.toUpperCase().replace(/\s+/g, ' ');
  const reasons: string[] = [];

  if (DIGIT_RUN.test(normalised)) {
    reasons.push('contains a run of 7 or more digits, resembling an account/phone number');
  }
  if (EMAIL_PATTERN.test(trimmed)) {
    reasons.push('contains an email-address-like pattern');
  }
  if (UPI_HANDLE_PATTERN.test(normalised.replace(/ /g, ''))) {
    reasons.push('contains a UPI-handle-like pattern (name@provider)');
  }
  if (TRANSFER_TO_PHRASE.test(normalised)) {
    reasons.push('narrative phrasing suggests a payment to/from a named individual');
  }

  const words = normalised.split(' ').filter(Boolean);
  const looksLikeBareNamePhrase = words.length >= 1
    && words.length <= 3
    && words.every((w) => /^[A-Z]{2,15}$/.test(w))
    && !words.some((w) => BUSINESS_INDICATOR_WORDS.has(w));
  if (looksLikeBareNamePhrase) {
    reasons.push('short bare-word narrative with no recognised business/institution indicator — may be a personal name');
  }

  return { flagged: reasons.length > 0, reasons };
}
