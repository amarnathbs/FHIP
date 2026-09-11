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
 */

import type { AieUnresolvedItemInput } from '../../types';
import type { AccountMatchOutcome } from './accountMatching';
import type { SchemeResolutionOutcome } from '@/lib/services/investment-intelligence/schemeResolution';
import type { StatementPeriodCheck } from './statementMatching';

export function unresolvedItemsForAccountMatches(outcomes: readonly AccountMatchOutcome[]): AieUnresolvedItemInput[] {
  return outcomes
    .filter((o): o is Extract<AccountMatchOutcome, { kind: 'ambiguous' }> => o.kind === 'ambiguous')
    .map((o) => ({
      reasonCode: 'ii_adapter:ambiguous_account',
      severity: 'blocking',
      displayCandidate: `${o.folioNumber ?? '(no folio)'} / ${o.amcName}`,
      evidenceRef: { folioNumber: o.folioNumber, amcName: o.amcName, candidateAccountIds: o.candidateAccountIds },
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
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
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
    },
  ];
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
      permittedActionTypes: ['request_reprocessing', 'reject_document'],
    },
  ];
}
