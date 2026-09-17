/**
 * AIE-1.2 — builds typed `AieUnresolvedItemInput`s from matching/
 * reconciliation outcomes, for persistence through AIE-1.1's EXISTING
 * unresolved-item lifecycle (`repo.createUnresolvedItems`/
 * `aie_unresolved_item`) — execution sequence step 10: "wire AIE-1.1's
 * unresolved-item lifecycle for anything ambiguous — do not build a second
 * exception system." No new table, no new state machine is defined here;
 * this file only shapes the `reasonCode`/`severity`/`permittedActionTypes`
 * payload AIE-1.1's own `createUnresolvedItems` already knows how to
 * persist.
 *
 * PC5 (M4) CHANGE — `permittedActionTypes` IS NOW LOAD-BEARING.
 *
 * Every builder below used to write the same hard-coded
 * `['request_reprocessing', 'reject_document']`, and — verified fresh
 * against the current tree — NOTHING IN THE APPLICATION EVER READ THE
 * COLUMN BACK. `createUnresolvedItems` (repository.ts) writes it; no
 * SELECT anywhere includes it; the review UI's permitted actions came
 * entirely from the static `reasonCodes.ts` registry. So the column was
 * write-only, and the two could diverge silently forever with no test or
 * runtime check noticing.
 *
 * PC5 now reads it as the OUTER BOUND on what a user may do with an item
 * (`lib/pc5/reviewStatus.ts`'s `permittedPc5Actions` intersects it with the
 * registry). That makes these arrays real permissions rather than
 * decoration — which is why each one below now states, per item, WHICH
 * actions are genuinely meaningful for that condition, instead of
 * repeating one list. The registry may still NARROW what is offered; it can
 * never widen past what is written here.
 *
 * `'request_reprocessing'` is retained in these arrays because it is part
 * of AIE's declared vocabulary and removing it would be a silent scope
 * change — but note that no route or service implements it anywhere in this
 * repository (see `AieReviewActionType`'s own note). PC5 does not offer it.
 */

import type { AieUnresolvedItemInput } from '../../types';
import type { AccountMatchOutcome } from './accountMatching';
import type { SchemeResolutionOutcome } from '@/lib/services/investment-intelligence/schemeResolution';
import type { StatementPeriodCheck } from './statementMatching';
import { PC5_OWNER_JOINT_REASON_CODE, PC5_OWNER_MISMATCH_REASON_CODE, type Pc5OwnerMatchOutcome } from './ownerMatching';

export function unresolvedItemsForAccountMatches(outcomes: readonly AccountMatchOutcome[]): AieUnresolvedItemInput[] {
  return outcomes
    .filter((o): o is Extract<AccountMatchOutcome, { kind: 'ambiguous' }> => o.kind === 'ambiguous')
    .map((o) => ({
      reasonCode: 'ii_adapter:ambiguous_account',
      severity: 'blocking',
      displayCandidate: `${o.folioNumber ?? '(no folio)'} / ${o.amcName}`,
      evidenceRef: { folioNumber: o.folioNumber, amcName: o.amcName, candidateAccountIds: o.candidateAccountIds },
      // The ambiguity is between a finite set of the user's OWN account
      // ids, already recorded above in `candidateAccountIds`. A user can
      // legitimately resolve that; PC5 offers the choice from exactly that
      // list.
      permittedActionTypes: ['choose_value', 'request_reprocessing', 'reject_document'],
    }));
}

export function unresolvedItemForOwnerUnresolved(hasAnyAccountMatch: boolean): AieUnresolvedItemInput[] {
  if (!hasAnyAccountMatch) return [];
  return [
    {
      reasonCode: 'ii_adapter:owner_unresolved',
      severity: 'blocking',
      displayCandidate: null,
      evidenceRef: { reason: 'No household member was specified for this statement at intake time.' },
      // PC5: the user can now simply say who it belongs to. Before this
      // phase their only exits were reject-and-reupload, or an action with
      // no implementation.
      permittedActionTypes: ['choose_value', 'request_reprocessing', 'reject_document'],
    },
  ];
}

/**
 * PC5 (M4) — K.4/K.7. The owner-MISMATCH item, which did not previously
 * exist in any form.
 *
 * WHAT IS AND IS NOT IN `evidenceRef`. The holder name printed on a
 * statement is another person's PII. Only `ownerMatching.maskHolderName`'s
 * irreversible partial form reaches this row ("A***** S*****"), never the
 * raw name, and the masked form is not reversible by anyone including the
 * user — the Product Owner's 2026-09-15 one-way-HMAC decision removed the
 * reversible token map from the repository entirely (the crypto module was
 * DELETED, not disabled). PC5's own UI states this in words rather than
 * offering a reveal that cannot work.
 *
 * `candidateMemberIds` are the user's OWN active household member ids, and
 * they are recorded so the resolution step can offer a closed option set
 * that a browser cannot widen (K.20's "browser cannot forge victim
 * account/owner IDs"): the option set is re-derived server-side at
 * resolution time anyway, so this is a display convenience and an audit
 * record of what was offered, never the authority.
 */
export function unresolvedItemForOwnerMismatch(outcome: Pc5OwnerMatchOutcome, declaredOwnerMemberId: string | null): AieUnresolvedItemInput[] {
  if (outcome.kind === 'mismatch') {
    return [
      {
        reasonCode: PC5_OWNER_MISMATCH_REASON_CODE,
        severity: 'blocking',
        displayCandidate: outcome.maskedHolderName,
        evidenceRef: {
          maskedHolderName: outcome.maskedHolderName,
          declaredOwnerMemberId,
          candidateMemberIds: outcome.candidateMemberIds,
          comparison: 'exact_after_normalisation',
          originalValueRecoverable: false,
        },
        permittedActionTypes: ['choose_value', 'reject_document'],
      },
    ];
  }
  if (outcome.kind === 'ambiguous') {
    return [
      {
        reasonCode: PC5_OWNER_MISMATCH_REASON_CODE,
        severity: 'blocking',
        displayCandidate: outcome.maskedHolderName,
        evidenceRef: {
          maskedHolderName: outcome.maskedHolderName,
          declaredOwnerMemberId,
          candidateMemberIds: outcome.candidateMemberIds,
          ambiguityReason: outcome.reason,
          comparison: 'exact_after_normalisation',
          originalValueRecoverable: false,
        },
        permittedActionTypes: ['choose_value', 'reject_document'],
      },
    ];
  }
  if (outcome.kind === 'joint_holding') {
    return [
      {
        reasonCode: PC5_OWNER_JOINT_REASON_CODE,
        severity: 'blocking',
        displayCandidate: outcome.maskedHolderName,
        evidenceRef: {
          maskedHolderName: outcome.maskedHolderName,
          maskedJointHolders: outcome.maskedJointHolders,
          declaredOwnerMemberId,
          matchedMemberIds: outcome.matchedMemberIds,
          originalValueRecoverable: false,
        },
        permittedActionTypes: ['choose_value', 'reject_document'],
      },
    ];
  }
  // `exact_match` and `no_owner_evidence` raise nothing here — see
  // `ownerOutcomeBlocksAcceptance`'s own note on why a document that names
  // nobody must not be double-blocked alongside `owner_unresolved`.
  return [];
}

export function unresolvedItemsForInstrumentMatches(outcomes: ReadonlyMap<string, SchemeResolutionOutcome>): AieUnresolvedItemInput[] {
  const items: AieUnresolvedItemInput[] = [];
  for (const [key, outcome] of outcomes) {
    if (outcome.kind !== 'ambiguous') continue;
    items.push({
      // AIE-1.1's `AieItemSeverity` is a coarser two-level vocabulary
      // ('blocking' | 'warning') than Investment Intelligence's own five
      // levels — an ambiguous instrument match cannot safely proceed to a
      // canonical write (execution sequence step 7: "never a plausible-
      // default guess"), so it maps to AIE's 'blocking', not 'warning'.
      reasonCode: 'ii_adapter:ambiguous_instrument',
      severity: 'blocking',
      displayCandidate: key,
      evidenceRef: { schemeKey: key, matchedVia: outcome.matchedVia, candidateInstrumentIds: outcome.candidateInstrumentIds, reason: outcome.reason },
      // Deliberately NOT widened to `choose_value`. Unlike an ambiguous
      // ACCOUNT (a choice between the user's own folios, which the user
      // genuinely knows), an ambiguous INSTRUMENT is a choice between
      // near-identical scheme variants — Direct vs Regular plan, Growth vs
      // IDCW option — where a wrong answer silently corrupts cost base and
      // tax lots and the user has no better information than the parser
      // did. Asking would manufacture false confidence. This one stays a
      // reprocess/reject.
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
    });
  }
  return items;
}

export function unresolvedItemForStatementPeriod(check: StatementPeriodCheck): AieUnresolvedItemInput[] {
  if (check.ok) return [];
  return [
    {
      reasonCode: `ii_adapter:${check.reasonCode}`,
      severity: 'blocking',
      displayCandidate: null,
      evidenceRef: { reasonCode: check.reasonCode },
      // A missing or mis-ordered statement period is correctable with
      // AIE's own typed `correct` action (the registry already declares
      // `statementPeriodStart`/`statementPeriodEnd`/`asOfDate` as
      // correctable date fields), not with a PC5 choice over canonical
      // data. `correct` is therefore what this row permits.
      permittedActionTypes: ['correct', 'request_reprocessing', 'reject_document'],
    },
  ];
}
