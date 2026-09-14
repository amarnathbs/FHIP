/**
 * M3 (Phase 4), item I.7 — deterministic-vs-AI disagreement resolution.
 *
 * THE RULE THIS IMPLEMENTS, VERBATIM FROM THE DISPATCH:
 *   "If deterministic parser and AI both produce evidence: compare
 *    field-by-field; deterministic parser does not automatically 'win' merely
 *    because it is deterministic; AI does not automatically 'win' because it
 *    is flexible; disagreement on a material financial field creates an AIE
 *    unresolved item unless a deterministic reconciliation rule objectively
 *    resolves it. Record both candidate values and evidence provenance."
 *
 * WHY "NEITHER AUTOMATICALLY WINS" IS HARDER THAN IT SOUNDS, AND WHAT IT
 * ACTUALLY MEANS HERE. The tempting implementation is a precedence table —
 * deterministic beats AI, done. That is explicitly forbidden, and for a good
 * reason: the deterministic parser's failure mode is not "returns nothing",
 * it is "misreads a glued or wrapped row and returns a confident wrong
 * number" (PC4 defects #2 and #7b were exactly that). A precedence table
 * would silently discard the one piece of evidence that could have caught it.
 *
 * So the resolution here is NOT a preference between sources. It is a
 * three-way classification:
 *
 *   1. AGREE — the two sources say the same thing, within the module's own
 *      certified tolerance for that field type. No item. Nothing to decide.
 *   2. OBJECTIVELY RESOLVED — the two disagree, but an EXTERNAL arithmetic
 *      fact on the document itself settles it without preferring a source.
 *      The only such fact available on an investment statement, and the one
 *      used here, is the printed running unit balance: if exactly one of the
 *      two candidate unit figures makes the roll-forward arithmetic close,
 *      the document itself has answered the question. The winner is recorded
 *      WITH the arithmetic that decided it, so the decision is auditable
 *      rather than asserted.
 *   3. UNRESOLVED — they disagree on a material financial field and nothing
 *      objective settles it. This becomes a BLOCKING `aie_unresolved_item`
 *      carrying BOTH candidate values and BOTH provenances, for PC5/the user
 *      to decide. It never silently picks one.
 *
 * MATERIALITY IS A PROPERTY OF THE FIELD, NOT OF THE SIZE OF THE GAP. Units,
 * amount, NAV, transaction date and transaction type are material: a
 * disagreement on any of them changes the user's economic truth. Narrative
 * text is not — two renderings of the same statement line are routinely
 * spelled differently and blocking a document over that would make the
 * feature unusable. The split is a closed list below, so "is this material"
 * is never a judgement call at a call site.
 *
 * NO CONFIDENCE ANYWHERE. Consistent with P4/REC-04 and with every other
 * module in this adapter, no function in this file takes or returns a
 * confidence score. Comparison is by value and by document arithmetic only.
 */

import { compareScaled, absScaled, parseExactDecimal, scaledToDecimalString, ZERO } from '@/lib/services/investment-intelligence/decimal';
import type { ReconciliationConfig } from '@/lib/services/investment-intelligence/reconciliationConfig';
import type { AieUnresolvedItemInput } from '../../types';

/** CLOSED list. A disagreement on one of these changes economic truth. */
export const MATERIAL_FINANCIAL_FIELDS = ['units', 'amount', 'navOrPrice', 'transactionDateIso', 'transactionTypeCandidate', 'closingUnits'] as const;
export type MaterialFinancialField = (typeof MATERIAL_FINANCIAL_FIELDS)[number];

/** CLOSED list. A disagreement on one of these is informational. */
export const NON_MATERIAL_FIELDS = ['narrative', 'schemeText', 'amcOrInstitutionText'] as const;

export function isMaterialFinancialField(fieldName: string): fieldName is MaterialFinancialField {
  return (MATERIAL_FINANCIAL_FIELDS as readonly string[]).includes(fieldName);
}

export interface CandidateEvidence {
  /** Exact decimal string, an ISO date, or an enum literal — never a float. */
  value: string | null;
  /** Where this came from, for the audit trail. `parserCode@version` for the
   * deterministic side; `schemaName@version` for the AI side. */
  producedBy: string;
  /** Free-form provenance the producing side already had: a source
   * reference, a page/line, the raw statement line. Carried through
   * unchanged so a reviewer sees what each side actually read. */
  provenance: Record<string, unknown>;
}

export interface FieldDisagreementInput {
  /** Which record this is about, e.g. `transaction:12` or `holding:0`. */
  recordRef: string;
  fieldName: string;
  deterministic: CandidateEvidence;
  ai: CandidateEvidence;
}

export type FieldComparison =
  | { kind: 'agree'; recordRef: string; fieldName: string; value: string | null }
  | { kind: 'one_sided'; recordRef: string; fieldName: string; presentSide: 'deterministic' | 'ai'; value: string | null }
  | { kind: 'objectively_resolved'; recordRef: string; fieldName: string; winner: 'deterministic' | 'ai'; value: string | null; resolvedBy: string; evidence: Record<string, unknown> }
  | { kind: 'disagree_material'; recordRef: string; fieldName: string; deterministic: CandidateEvidence; ai: CandidateEvidence }
  | { kind: 'disagree_immaterial'; recordRef: string; fieldName: string; deterministic: CandidateEvidence; ai: CandidateEvidence };

/**
 * Objective tie-breaker: the document's own printed running unit balance.
 *
 * Supplied by the caller for the ONE field where such a fact exists
 * (`units`). When present, whichever candidate makes
 * `openingUnits + candidate == printedRunningBalance` hold within the
 * module's certified unit tolerance is the winner — and it wins because the
 * document says so, not because of which system produced it. If both close
 * or neither does, the tie-breaker declines and the disagreement stands.
 */
export interface RollForwardTieBreak {
  openingUnitsScaled: bigint;
  printedRunningBalanceScaled: bigint;
}

function toScaled(value: string | null): bigint | null {
  if (value === null) return null;
  const parsed = parseExactDecimal(value);
  return parsed.ok ? parsed.scaled : null;
}

function withinUnitTolerance(a: bigint, b: bigint, config: ReconciliationConfig): boolean {
  return compareScaled(absScaled(a - b), config.unitToleranceScaled) <= 0;
}

/**
 * Compares ONE field from the two sources.
 *
 * `tieBreak` is only meaningful for `units`; passing it for another field is
 * ignored rather than misapplied, because "opening + amount == running unit
 * balance" is not an identity that holds for amounts or NAVs and pretending
 * otherwise would manufacture a wrong winner.
 */
export function compareFieldEvidence(input: FieldDisagreementInput, config: ReconciliationConfig, tieBreak?: RollForwardTieBreak): FieldComparison {
  const { recordRef, fieldName, deterministic, ai } = input;

  // One side silent is not a disagreement — it is one source having less to
  // say. D.5 already covers "null + reason"; there is nothing to arbitrate.
  if (deterministic.value === null && ai.value === null) {
    return { kind: 'agree', recordRef, fieldName, value: null };
  }
  if (deterministic.value === null) return { kind: 'one_sided', recordRef, fieldName, presentSide: 'ai', value: ai.value };
  if (ai.value === null) return { kind: 'one_sided', recordRef, fieldName, presentSide: 'deterministic', value: deterministic.value };

  const detScaled = toScaled(deterministic.value);
  const aiScaled = toScaled(ai.value);
  const bothNumeric = detScaled !== null && aiScaled !== null;

  // Numeric fields compare on VALUE within the certified tolerance, not on
  // string equality: "100.000" and "100.0" are the same number of units, and
  // failing a document over that formatting difference would be a defect.
  if (bothNumeric) {
    if (withinUnitTolerance(detScaled, aiScaled, config)) {
      return { kind: 'agree', recordRef, fieldName, value: deterministic.value };
    }
  } else if (deterministic.value === ai.value) {
    return { kind: 'agree', recordRef, fieldName, value: deterministic.value };
  }

  // --- They genuinely disagree. Can the DOCUMENT settle it? --------------
  if (fieldName === 'units' && tieBreak && bothNumeric) {
    const detCloses = withinUnitTolerance(tieBreak.openingUnitsScaled + detScaled!, tieBreak.printedRunningBalanceScaled, config);
    const aiCloses = withinUnitTolerance(tieBreak.openingUnitsScaled + aiScaled!, tieBreak.printedRunningBalanceScaled, config);

    // EXACTLY ONE closing is the whole condition. If both close the printed
    // balance cannot discriminate (it would mean the two candidates are
    // within tolerance of each other, which the branch above already ruled
    // out — so this is defensive). If neither closes, the printed balance
    // disagrees with BOTH sources, which is itself a finding and must not be
    // resolved by picking the nearer one.
    if (detCloses !== aiCloses) {
      const winner = detCloses ? 'deterministic' : 'ai';
      return {
        kind: 'objectively_resolved',
        recordRef,
        fieldName,
        winner,
        value: detCloses ? deterministic.value : ai.value,
        resolvedBy: 'printed_running_unit_balance_roll_forward',
        evidence: {
          openingUnits: scaledToDecimalString(tieBreak.openingUnitsScaled),
          printedRunningBalance: scaledToDecimalString(tieBreak.printedRunningBalanceScaled),
          deterministicCandidate: deterministic.value,
          aiCandidate: ai.value,
          deterministicClosesArithmetic: detCloses,
          aiClosesArithmetic: aiCloses,
          unitTolerance: scaledToDecimalString(config.unitToleranceScaled),
        },
      };
    }
  }

  return isMaterialFinancialField(fieldName)
    ? { kind: 'disagree_material', recordRef, fieldName, deterministic, ai }
    : { kind: 'disagree_immaterial', recordRef, fieldName, deterministic, ai };
}

/**
 * Turns unresolved material disagreements into AIE unresolved items.
 *
 * NO NEW EXCEPTION SYSTEM (AIE10-EXC-08/09/10, and `unresolvedItems.ts`'s own
 * discipline): this returns AIE-1.1's existing `AieUnresolvedItemInput`
 * shape for persistence through `repo.createUnresolvedItems`. No new table,
 * no new status vocabulary, no parallel queue.
 *
 * `evidenceRef` carries BOTH candidate values and BOTH provenances, which is
 * the I.7 requirement that makes this item actionable rather than merely a
 * notification: PC5 cannot present a choice it was not given the options for.
 */
export function unresolvedItemsForDisagreements(comparisons: readonly FieldComparison[]): AieUnresolvedItemInput[] {
  return comparisons
    .filter((c): c is Extract<FieldComparison, { kind: 'disagree_material' }> => c.kind === 'disagree_material')
    .map((c) => ({
      reasonCode: `ii_adapter:source_disagreement:${c.fieldName}`,
      severity: 'blocking',
      // Shown to the user, so it must be readable and must not imply either
      // side is authoritative.
      displayCandidate: `${c.recordRef}: deterministic "${c.deterministic.value}" vs AI "${c.ai.value}"`,
      evidenceRef: {
        recordRef: c.recordRef,
        fieldName: c.fieldName,
        material: true,
        deterministic: { value: c.deterministic.value, producedBy: c.deterministic.producedBy, provenance: c.deterministic.provenance },
        ai: { value: c.ai.value, producedBy: c.ai.producedBy, provenance: c.ai.provenance },
      },
      // Deliberately does NOT offer an "accept one of these" action at this
      // layer. The permitted action vocabulary is AIE-1.5's, and the two
      // actions below are the ones this adapter's existing unresolved items
      // already use; adding a bespoke one here would fork the vocabulary that
      // `decide.ts` validates against.
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
    }));
}

/** Objectively-resolved disagreements are NOT items — but they ARE evidence,
 * and silently discarding the fact that two sources disagreed would hide a
 * real signal about parser quality. Returned separately so the caller can
 * record them as reconciliation runs rather than as exceptions. */
export function objectiveResolutionsForAudit(comparisons: readonly FieldComparison[]): Record<string, unknown>[] {
  return comparisons
    .filter((c): c is Extract<FieldComparison, { kind: 'objectively_resolved' }> => c.kind === 'objectively_resolved')
    .map((c) => ({ recordRef: c.recordRef, fieldName: c.fieldName, winner: c.winner, resolvedBy: c.resolvedBy, evidence: c.evidence }));
}

/** Convenience for the dispatch path: ZERO is the correct opening balance for
 * a position with no prior snapshot, and saying so explicitly here keeps the
 * caller from inventing a different default. */
export const NO_PRIOR_OPENING_UNITS = ZERO;
