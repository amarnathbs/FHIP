/**
 * PC5 (M4) — K.15 and K.16: the acceptance summary, and the exception-only
 * default that keeps it short.
 *
 * K.15 lists eleven things a user must see before a canonical write, and
 * then adds the constraint that makes it hard: *"Do not force users to
 * manually review every correctly extracted row."* K.16 restates it as a
 * design rule — surface only material unresolved items, with an expandable
 * full view for transparency.
 *
 * So this module computes a SUMMARY (counts, period, status) from evidence
 * that is already recorded, and returns the full extracted set behind a
 * separate flag rather than inlining it. A CAMS consolidated statement
 * routinely carries several hundred transactions; rendering them all by
 * default would guarantee the user scrolls past the one line that
 * mattered.
 *
 * EVERY FIELD IS DERIVED, NOT ASSERTED. There is no place in this file
 * where a value is defaulted, rounded or inferred: a count is a count of
 * real candidate rows, the period comes from the metadata candidate the
 * parser recorded, the reconciliation status is AIE's own worst outcome,
 * and anything genuinely unknown comes back null with the UI saying "not
 * stated on this statement" rather than a plausible-looking blank.
 * `null + reason` is valid evidence; a plausible guess is not (global
 * invariant D.5).
 *
 * K.21's UI COPY LIVES HERE TOO, as a constant rather than in a component,
 * so the promise made to the user about the original document and the
 * behaviour that actually implements it are reviewable side by side.
 */

import {
  countItemsBlockingAcceptanceForRun,
  getAdapterIdForRun,
  getIntakeDisplayFilename,
  getRunForUser,
  latestReconciliationOutcomesForRun,
  listFieldCandidatesForRun,
} from '@/lib/aie/db/repository';
import { worstOutcome } from '@/lib/aie/reconciliation/types';
import { candidatesByRecordType, parsedMetadataFromCandidates } from '@/lib/aie/adapters/investment-intelligence/parserAdapter';
import { II_ADAPTER_ID } from '@/lib/aie/adapters/investment-intelligence';
import { maskHolderName } from '@/lib/aie/adapters/investment-intelligence/ownerMatching';
import { resolveOwnerOptions } from './optionSets';
import { projectResolutionsForRun } from './projection';
import type { AieReconciliationOutcome } from '@/lib/aie/types';
import type { Pc5ResolutionItemView } from './types';

/**
 * K.21 — *"UI copy should clearly communicate that the original statement
 * is removed after successful processing while accepted structured
 * investment data remains."*
 *
 * The second sentence is the one users get wrong if it is left implicit:
 * people reasonably assume "we delete the document" means "we delete the
 * data". Both halves are therefore stated, in that order, before the
 * acceptance rather than after it.
 *
 * The third sentence exists because of Phase 4's one-way-HMAC decision. A
 * user who later wants to check a masked value against the original will
 * find they cannot, and the honest moment to tell them is now — not when
 * they click a reveal control that no longer exists.
 */
export const PC5_PDF_LIFECYCLE_COPY = {
  heading: 'What happens to your statement file',
  body:
    'Once this statement is accepted, the holdings and transactions below are saved to your portfolio and the original PDF is permanently deleted from our systems. Your investment data stays; the document does not.',
  maskingNote:
    'Identifiers such as folio and PAN numbers are stored in a one-way masked form. That masking cannot be reversed by you or by us, so the original values cannot be shown again after processing.',
} as const;

export interface Pc5AcceptanceSummary {
  runId: string;
  intakeId: string;
  /** K.15: source type. */
  sourceType: string | null;
  documentClass: string | null;
  displayFilename: string | null;
  /** K.15: owner/entity. Null when the user has not yet chosen one — which
   * is itself a blocking exception, surfaced in `unresolvedWarnings`. */
  ownerLabel: string | null;
  ownerMemberId: string | null;
  /** K.15: accounts/folios. Masked — a folio number is an identifier. */
  accounts: { maskedFolio: string | null; institution: string }[];
  /** K.15: schemes. */
  schemeCount: number;
  schemeNames: string[];
  /** K.15: transaction count, holdings count. */
  transactionCount: number;
  holdingCount: number;
  /** K.15: statement period. Null when the statement did not print one. */
  statementPeriodStart: string | null;
  statementPeriodEnd: string | null;
  asOfDate: string | null;
  /** K.15: unresolved warnings. Material items only (K.16). */
  unresolvedWarnings: Pc5ResolutionItemView[];
  blockingCount: number;
  /** K.15: history completeness. Derived from AIE's own recorded
   * roll-forward rule outcomes — never recomputed here, which would be a
   * second opinion on a question the reconciliation engine already
   * answered. */
  historyCompleteness: 'complete' | 'incomplete' | 'not_assessed';
  /** K.15: financial reconciliation status. */
  reconciliationOutcome: AieReconciliationOutcome;
  /** True only when every gate the acceptance route enforces is currently
   * satisfied. Advisory: the route re-derives all of it server-side and
   * remains the authority. */
  readyToAccept: boolean;
  lifecycleCopy: typeof PC5_PDF_LIFECYCLE_COPY;
}

export type Pc5AcceptanceSummaryOutcome =
  | { ok: false; reason: 'not_found' | 'unsupported_adapter' | 'no_candidates' }
  | { ok: true; summary: Pc5AcceptanceSummary; fullExtract: Pc5FullExtract | null };

/** K.16's "expandable full extracted-data view for transparency". Returned
 * only when explicitly asked for. */
export interface Pc5FullExtract {
  accounts: Record<string, unknown>[];
  transactions: Record<string, unknown>[];
  holdings: Record<string, unknown>[];
}

const ROLL_FORWARD_RULE_PREFIX = 'ii_adapter_roll_forward:';

/**
 * History completeness from the recorded rule outcomes.
 *
 * `not_assessed` is a real answer, not a fallback for "something went
 * wrong": a statement with no prior snapshot to roll forward from has no
 * roll-forward rule result at all, and reporting `complete` for it would
 * claim a check that never ran. This is exactly the distinction PC4-INV-08
 * ("opening-balance safety / no fabricated tax lots") turns on.
 */
export function deriveHistoryCompleteness(outcomes: readonly { ruleId: string; outcome: AieReconciliationOutcome }[]): 'complete' | 'incomplete' | 'not_assessed' {
  const rollForward = outcomes.filter((o) => o.ruleId.startsWith(ROLL_FORWARD_RULE_PREFIX));
  if (rollForward.length === 0) return 'not_assessed';
  return rollForward.every((o) => o.outcome === 'pass' || o.outcome === 'pass_with_tolerance') ? 'complete' : 'incomplete';
}

/** A folio number is an identifier and must not be printed in full on a
 * summary screen. Reuses the same irreversible partial-mask shape
 * `maskHolderName` applies to names, so one masking convention covers the
 * surface rather than two that could drift. */
export function maskFolio(folio: string | null): string | null {
  if (!folio) return null;
  const chars = Array.from(folio);
  if (chars.length <= 4) return `${'*'.repeat(Math.max(chars.length - 1, 0))}${chars[chars.length - 1] ?? ''}`;
  return `${'*'.repeat(chars.length - 4)}${chars.slice(-4).join('')}`;
}

export async function buildAcceptanceSummary(params: {
  userId: string;
  runId: string;
  includeFullExtract?: boolean;
}): Promise<Pc5AcceptanceSummaryOutcome> {
  const run = await getRunForUser(params.runId, params.userId);
  if (!run) return { ok: false, reason: 'not_found' };

  const adapterId = await getAdapterIdForRun(run.id);
  if (adapterId !== II_ADAPTER_ID) return { ok: false, reason: 'unsupported_adapter' };

  const [candidates, blockingCount, reconciliationOutcomes, displayFilename, projected, ownerOptions] = await Promise.all([
    listFieldCandidatesForRun(run.id),
    countItemsBlockingAcceptanceForRun(run.id),
    latestReconciliationOutcomesForRun(run.id),
    getIntakeDisplayFilename(run.intakeId),
    projectResolutionsForRun({ userId: params.userId, runId: run.id, materialOnly: true }),
    resolveOwnerOptions(params.userId),
  ]);
  if (candidates.length === 0) return { ok: false, reason: 'no_candidates' };

  const metadata = parsedMetadataFromCandidates(candidates);
  const accountRecords = candidatesByRecordType(candidates, 'account');
  const transactionRecords = candidatesByRecordType(candidates, 'transaction');
  const holdingRecords = candidatesByRecordType(candidates, 'holding');

  const schemeNames = [
    ...new Set(
      [...transactionRecords, ...holdingRecords]
        .map((r) => ((r.value.scheme as Record<string, unknown> | undefined)?.rawSchemeName as string | undefined) ?? null)
        .filter((n): n is string => typeof n === 'string' && n.length > 0),
    ),
  ];

  // The owner the user has chosen, read from PC5's own decision trail via
  // the projection rather than from a separate query — one source for "who
  // owns this", so the summary and the exception list cannot disagree.
  const ownerChoiceItem = projected.items.find((i) => i.reasonCode.startsWith('ii_adapter:owner'));
  const ownerMemberId = typeof ownerChoiceItem?.evidenceRef?.declaredOwnerMemberId === 'string'
    ? (ownerChoiceItem.evidenceRef.declaredOwnerMemberId as string)
    : null;
  const ownerLabel = ownerMemberId ? (ownerOptions.find((o) => o.value === ownerMemberId)?.label ?? null) : null;

  const worst = worstOutcome(reconciliationOutcomes.map((r) => ({ ruleId: r.ruleId, ruleVersion: '1', outcome: r.outcome })));

  const summary: Pc5AcceptanceSummary = {
    runId: run.id,
    intakeId: run.intakeId,
    sourceType: (metadata?.sourceKey as string | undefined) ?? null,
    documentClass: (metadata?.documentTypeDetected as string | undefined) ?? null,
    displayFilename,
    ownerLabel,
    ownerMemberId,
    accounts: accountRecords.map((r) => ({
      maskedFolio: maskFolio((r.value.folioNumber as string | null) ?? null),
      institution: (r.value.amcName as string | undefined) ?? '(institution not stated)',
    })),
    schemeCount: schemeNames.length,
    schemeNames,
    transactionCount: transactionRecords.length,
    holdingCount: holdingRecords.length,
    statementPeriodStart: (metadata?.statementPeriodStartIso as string | null) ?? null,
    statementPeriodEnd: (metadata?.statementPeriodEndIso as string | null) ?? null,
    asOfDate: (metadata?.statementAsOfDateIso as string | null) ?? null,
    unresolvedWarnings: projected.items,
    blockingCount,
    historyCompleteness: deriveHistoryCompleteness(reconciliationOutcomes),
    reconciliationOutcome: worst,
    // Mirrors the acceptance gate's own conditions exactly: the run must be
    // `awaiting_acceptance`, nothing may still be blocking, and the worst
    // reconciliation outcome must be a genuine pass. `not_applicable` is
    // NOT a pass — accepting a document nothing ever checked is the silent
    // gap `accept.ts` explicitly refuses, and this summary must not imply
    // otherwise.
    readyToAccept:
      run.status === 'awaiting_acceptance' &&
      blockingCount === 0 &&
      (worst === 'pass' || worst === 'pass_with_tolerance'),
    lifecycleCopy: PC5_PDF_LIFECYCLE_COPY,
  };

  const fullExtract: Pc5FullExtract | null = params.includeFullExtract
    ? {
        // Holder names are masked before leaving the server, even in the
        // "full" view: K.16's transparency is about the user seeing every
        // EXTRACTED ROW, not about undoing a masking decision the Product
        // Owner made deliberately and irreversibly.
        accounts: accountRecords.map((r) => ({
          ...r.value,
          holderName: maskHolderName((r.value.holderName as string | null) ?? null),
          jointHolders: Array.isArray(r.value.jointHolders)
            ? (r.value.jointHolders as string[]).map((j) => maskHolderName(j))
            : [],
          folioNumber: maskFolio((r.value.folioNumber as string | null) ?? null),
          // The verbatim source block the parser kept for provenance. Never
          // returned to a browser — it is the raw document text.
          raw: undefined,
        })),
        // FOUND BY THE LIVE-DEV MATRIX (S-44). The account rows were being
        // masked and the transaction and holding rows were not — and every
        // one of those carries its own `folioNumber`, verbatim from the
        // statement. So the "full extract" leaked in the clear exactly the
        // identifier the summary above had just taken care to mask, for
        // every transaction on the document. A one-line omission with a
        // real privacy consequence, and precisely the kind of thing a
        // structural test does not catch and a live assertion does.
        transactions: transactionRecords.map((r) => ({ ...r.value, folioNumber: maskFolio((r.value.folioNumber as string | null) ?? null) })),
        holdings: holdingRecords.map((r) => ({ ...r.value, folioNumber: maskFolio((r.value.folioNumber as string | null) ?? null) })),
      }
    : null;

  return { ok: true, summary, fullExtract };
}
