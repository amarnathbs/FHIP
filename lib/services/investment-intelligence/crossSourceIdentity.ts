// Investment Intelligence R11 — cross-source transaction identity
// resolution (spec sections 24-41). Pure functions only — no I/O, exactly
// the design discipline reconciliation.ts (R2) and publicationLogic.ts
// (R3) already established in this codebase, so this can be certified
// with fast, deterministic unit tests and audited by an oracle that never
// imports it.
//
// Scope, per R11_SCOPE_AND_ARCHITECTURE_RECONCILIATION.md: this module
// answers ONE question — given a newly-parsed candidate transaction and
// the set of already-canonical ii_transactions rows for the SAME
// (account_id, instrument_id) position (which, per accountResolution.ts,
// is already resolved source-agnostically), does the candidate represent
// the SAME real-world economic transaction as an existing row, evidenced
// via a DIFFERENT source? It deliberately does NOT touch same-source
// re-import idempotency (fingerprint.ts + migration 0033's
// uidx_ii_transactions_dedup already own that, untouched).
//
// States (spec section 32) — EXACT / HIGH_CONFIDENCE / AMBIGUOUS /
// REVIEW_REQUIRED, plus NONE (no relationship at all — a genuinely
// different transaction). Never a fake confidence percentage — every
// state is a named, deterministic rule, documented below and in
// R11_CROSS_SOURCE_RECONCILIATION.md.

import { absScaled, compareScaled, parseExactDecimal, subScaled } from './decimal';
import { DEFAULT_RECONCILIATION_CONFIG, type ReconciliationConfig } from './reconciliationConfig';

export type CrossSourceMatchState = 'exact' | 'high_confidence' | 'conflict' | 'ambiguous' | 'review_required' | 'none';

export interface CrossSourceCandidateTransaction {
  sourceKey: string; // ii_sources.source_key of the NEW evidence being imported
  sourceDocumentId: string;
  accountId: string;
  instrumentId: string;
  transactionDate: string; // ISO date
  transactionType: string; // canonical IiTransactionType
  grossAmount: string; // exact decimal string, as stored (numeric(18,2))
  units: string | null; // exact decimal string, as stored (numeric(20,6)), or null for cash-only
  sourceReference: string | null;
}

export interface CrossSourceExistingTransaction extends CrossSourceCandidateTransaction {
  id: string;
  status: string;
}

export interface CrossSourceFieldComparison {
  field: 'accountId' | 'instrumentId' | 'transactionDate' | 'transactionType' | 'grossAmount' | 'units' | 'sourceReference';
  matched: boolean;
  candidateValue: string | null;
  existingValue: string | null;
}

export interface CrossSourceMatchResult {
  state: CrossSourceMatchState;
  /** The single existing row this candidate matches against, when state is exact/high_confidence/conflict. Null for none/ambiguous (ambiguous means MORE than one existing row matched equally well — ambiguousCandidateIds carries them). */
  matchedExistingId: string | null;
  ambiguousCandidateIds: string[];
  comparisons: CrossSourceFieldComparison[];
  matchedFields: string[];
  differingFields: string[];
  rationale: string;
  engineVersion: string;
}

export const CROSS_SOURCE_IDENTITY_ENGINE_VERSION = 'r11-cross-source-identity-v1';

function decimalsWithinTolerance(a: string, b: string, toleranceScaled: bigint): boolean {
  const pa = parseExactDecimal(a);
  const pb = parseExactDecimal(b);
  if (!pa.ok || !pb.ok) return false;
  return compareScaled(absScaled(subScaled(pa.scaled, pb.scaled)), toleranceScaled) <= 0;
}

/**
 * Compare one candidate against one existing row on every deterministic
 * identity field (spec section 29: "PAN/investor identifiers where
 * legally appropriate, folio, account number, ISIN, scheme code,
 * instrument identity, transaction date/type, units, NAV, amount,
 * reference, source account" — account_id/instrument_id here ARE the
 * already-resolved folio/ISIN identity, per accountResolution.ts/
 * schemeResolution.ts, so re-comparing raw folio/ISIN text again would be
 * redundant, not additional safety).
 */
export function compareCrossSourceTransactions(
  candidate: CrossSourceCandidateTransaction,
  existing: CrossSourceExistingTransaction,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG
): CrossSourceFieldComparison[] {
  const unitsMatch = (): boolean => {
    if (candidate.units === null && existing.units === null) return true;
    if (candidate.units === null || existing.units === null) return false;
    return decimalsWithinTolerance(candidate.units, existing.units, config.unitToleranceScaled);
  };
  const amountMatch = (): boolean => decimalsWithinTolerance(candidate.grossAmount, existing.grossAmount, config.currencyToleranceScaled);

  return [
    { field: 'accountId', matched: candidate.accountId === existing.accountId, candidateValue: candidate.accountId, existingValue: existing.accountId },
    { field: 'instrumentId', matched: candidate.instrumentId === existing.instrumentId, candidateValue: candidate.instrumentId, existingValue: existing.instrumentId },
    { field: 'transactionDate', matched: candidate.transactionDate === existing.transactionDate, candidateValue: candidate.transactionDate, existingValue: existing.transactionDate },
    { field: 'transactionType', matched: candidate.transactionType === existing.transactionType, candidateValue: candidate.transactionType, existingValue: existing.transactionType },
    { field: 'grossAmount', matched: amountMatch(), candidateValue: candidate.grossAmount, existingValue: existing.grossAmount },
    { field: 'units', matched: unitsMatch(), candidateValue: candidate.units, existingValue: existing.units },
    {
      field: 'sourceReference',
      matched: candidate.sourceReference !== null && existing.sourceReference !== null && candidate.sourceReference === existing.sourceReference,
      candidateValue: candidate.sourceReference,
      existingValue: existing.sourceReference,
    },
  ];
}

function classifyPairwise(comparisons: CrossSourceFieldComparison[], candidate: CrossSourceCandidateTransaction, existing: CrossSourceExistingTransaction): 'exact' | 'high_confidence' | 'conflict' | 'none' {
  const by = (f: CrossSourceFieldComparison['field']) => comparisons.find((c) => c.field === f)!;

  // The four fields that MUST agree for any relationship to exist at all
  // (spec section 29 — these are the deterministic identity/economic-fact
  // fields, never skipped).
  const coreMatch = by('accountId').matched && by('instrumentId').matched && by('transactionDate').matched && by('transactionType').matched;
  if (!coreMatch) return 'none';

  const amountMatched = by('grossAmount').matched;
  const unitsMatched = by('units').matched;
  const refField = by('sourceReference');
  const bothRefsPresent = candidate.sourceReference !== null && existing.sourceReference !== null;
  const refsAgree = refField.matched;
  const refsDisagree = bothRefsPresent && !refsAgree;

  // A genuine reference collision on an otherwise-matching row (same
  // account+instrument+date+type+amount+units, but a real, present,
  // DIFFERENT provider reference on each side) is treated as a CONFLICT,
  // never auto-merged (spec section 33: "same transaction reference with
  // different amount... explicit conflict" — generalised here to "same
  // core economic fact, disagreeing reference" being equally unsafe to
  // silently merge).
  if (amountMatched && unitsMatched && refsDisagree) return 'conflict';
  if (!amountMatched || !unitsMatched) {
    // Core identity matches but the economic magnitude doesn't — a real
    // conflict (e.g. same reference, different amount) rather than "no
    // relationship", so it surfaces for review instead of silently
    // creating an unrelated second row.
    if (bothRefsPresent && refsAgree) return 'conflict';
    return 'none';
  }

  // amount + units both match within tolerance.
  if (bothRefsPresent && refsAgree) return 'exact'; // every deterministic signal, including the provider reference, agrees
  if (!bothRefsPresent) return 'high_confidence'; // strong agreement on every hard economic field; the soft reference field simply isn't available on one/both sides
  return 'exact'; // unreachable given the branches above, kept for exhaustiveness
}

/**
 * Resolve a candidate transaction against every existing canonical
 * transaction already on file for the SAME (account_id, instrument_id)
 * position, from a DIFFERENT source than the candidate (same-source
 * comparisons are fingerprint.ts's job, not this function's).
 */
export function resolveCrossSourceTransactionMatch(
  candidate: CrossSourceCandidateTransaction,
  existingForSamePosition: CrossSourceExistingTransaction[],
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG
): CrossSourceMatchResult {
  const otherSourceRows = existingForSamePosition.filter((e) => e.sourceDocumentId !== candidate.sourceDocumentId);

  const perRow = otherSourceRows.map((existing) => {
    const comparisons = compareCrossSourceTransactions(candidate, existing, config);
    const classification = classifyPairwise(comparisons, candidate, existing);
    return { existing, comparisons, classification };
  });

  const exactMatches = perRow.filter((r) => r.classification === 'exact');
  const highConfidenceMatches = perRow.filter((r) => r.classification === 'high_confidence');
  const conflictMatches = perRow.filter((r) => r.classification === 'conflict');

  const fieldSummary = (comparisons: CrossSourceFieldComparison[]) => ({
    matchedFields: comparisons.filter((c) => c.matched).map((c) => c.field),
    differingFields: comparisons.filter((c) => !c.matched).map((c) => c.field),
  });

  if (exactMatches.length === 1 && highConfidenceMatches.length === 0 && conflictMatches.length === 0) {
    const { comparisons } = exactMatches[0];
    const { matchedFields, differingFields } = fieldSummary(comparisons);
    return {
      state: 'exact',
      matchedExistingId: exactMatches[0].existing.id,
      ambiguousCandidateIds: [],
      comparisons,
      matchedFields,
      differingFields,
      rationale: `Every deterministic field (account, instrument, date, type, amount, units, source reference) matches existing transaction ${exactMatches[0].existing.id} from a different source — treated as the same real-world transaction, corroborating evidence linked, no new canonical row created.`,
      engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
    };
  }

  if (exactMatches.length > 1) {
    // More than one existing row is an EXACT match for this candidate —
    // cannot safely pick one (spec section 29: "no unsafe fuzzy matching
    // alone... when two source records cannot be safely resolved, use
    // REVIEW_REQUIRED"). This is a genuinely rare case (it implies two
    // already-canonical rows for the same position are themselves
    // indistinguishable), surfaced rather than guessed.
    return {
      state: 'ambiguous',
      matchedExistingId: null,
      ambiguousCandidateIds: exactMatches.map((m) => m.existing.id),
      comparisons: exactMatches.flatMap((m) => m.comparisons),
      matchedFields: [],
      differingFields: [],
      rationale: `Candidate matches ${exactMatches.length} existing transactions equally exactly (${exactMatches.map((m) => m.existing.id).join(', ')}) — cannot safely determine which is the same real-world transaction without human review.`,
      engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
    };
  }

  if (conflictMatches.length > 0) {
    const { comparisons } = conflictMatches[0];
    const { matchedFields, differingFields } = fieldSummary(comparisons);
    return {
      state: 'conflict',
      matchedExistingId: conflictMatches[0].existing.id,
      ambiguousCandidateIds: conflictMatches.map((m) => m.existing.id),
      comparisons,
      matchedFields,
      differingFields,
      rationale: `Candidate shares core identity (account, instrument, date, type) with existing transaction ${conflictMatches[0].existing.id} from a different source, but amount/units/reference disagree beyond tolerance — flagged REVIEW_REQUIRED, both pieces of evidence preserved, neither silently preferred.`,
      engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
    };
  }

  if (highConfidenceMatches.length === 1) {
    const { comparisons } = highConfidenceMatches[0];
    const { matchedFields, differingFields } = fieldSummary(comparisons);
    return {
      state: 'high_confidence',
      matchedExistingId: highConfidenceMatches[0].existing.id,
      ambiguousCandidateIds: [],
      comparisons,
      matchedFields,
      differingFields,
      rationale: `Account, instrument, date, type, amount and units all agree with existing transaction ${highConfidenceMatches[0].existing.id} from a different source; provider reference is unavailable on one or both sides so it cannot corroborate further, but every available hard economic field agrees — treated as the same real-world transaction.`,
      engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
    };
  }

  if (highConfidenceMatches.length > 1) {
    return {
      state: 'ambiguous',
      matchedExistingId: null,
      ambiguousCandidateIds: highConfidenceMatches.map((m) => m.existing.id),
      comparisons: highConfidenceMatches.flatMap((m) => m.comparisons),
      matchedFields: [],
      differingFields: [],
      rationale: `Candidate matches ${highConfidenceMatches.length} existing transactions with equal high-confidence strength (${highConfidenceMatches.map((m) => m.existing.id).join(', ')}) — cannot safely determine which is the same real-world transaction without human review.`,
      engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
    };
  }

  return {
    state: 'none',
    matchedExistingId: null,
    ambiguousCandidateIds: [],
    comparisons: [],
    matchedFields: [],
    differingFields: [],
    rationale: 'No existing transaction from a different source shares this candidate\'s core identity (account, instrument, date, type) — a genuinely new/different transaction.',
    engineVersion: CROSS_SOURCE_IDENTITY_ENGINE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Source precedence (spec section 30). Resolves WHICH of two exact/high-
// confidence-linked sources' evidence should be treated as "originating"
// when more than one candidate could claim it — i.e. import-order
// independence: "CAMS then broker" and "broker then CAMS" must reach the
// identical answer. Precedence NEVER discards the losing evidence (the
// caller always still records ii_transaction_source_links for it) — it
// only decides which single source_document_id is recorded as
// is_originating on the canonical row.
// ---------------------------------------------------------------------------
export interface SourcePrecedenceRule {
  sourceKey: string;
  rank: number; // lower = higher precedence
}

export interface PrecedenceCandidate {
  sourceKey: string;
  sourceDocumentId: string;
  statementAsOfDate: string | null; // ISO date, null if unknown
}

export function resolvePrecedenceWinner(candidates: PrecedenceCandidate[], rules: SourcePrecedenceRule[]): PrecedenceCandidate {
  if (candidates.length === 0) throw new Error('resolvePrecedenceWinner: candidates must be non-empty');
  const rankOf = (sourceKey: string): number => rules.find((r) => r.sourceKey === sourceKey)?.rank ?? Number.MAX_SAFE_INTEGER;

  return [...candidates].sort((a, b) => {
    const rankDiff = rankOf(a.sourceKey) - rankOf(b.sourceKey);
    if (rankDiff !== 0) return rankDiff; // lower rank (higher precedence) wins outright
    // Same rank (precedence-equal sources, e.g. CAMS vs KFintech): tie-break
    // by statement freshness (as_of date), NEVER by import order — this is
    // exactly what makes "CAMS then broker" and "broker then CAMS" resolve
    // identically regardless of which one the pipeline processed first.
    const aDate = a.statementAsOfDate ?? '';
    const bDate = b.statementAsOfDate ?? '';
    if (aDate !== bDate) return aDate > bDate ? -1 : 1; // newer as_of date wins
    // Fully tied (same rank, same/unknown as_of date): deterministic,
    // order-independent final tiebreak on sourceDocumentId so the function
    // is a total order regardless of input array order.
    return a.sourceDocumentId < b.sourceDocumentId ? -1 : a.sourceDocumentId > b.sourceDocumentId ? 1 : 0;
  })[0];
}
