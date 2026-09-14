/**
 * AIE-1.2 — the adapter-owned deterministic reconciliation rule (execution
 * sequence step 9: "implement deterministic roll-forward, duplicate/
 * overlap, and canonical-conflict checks against the real Investment
 * Intelligence tables"), wired into AIE-1.1's `ReconciliationRule` contract
 * (lib/aie/reconciliation/types.ts).
 *
 * REUSE, NOT REBUILD. Every actual reconciliation calculation is Investment
 * Intelligence's OWN pure function:
 *   - `computeTransactionFingerprint` (fingerprint.ts) for duplicate/overlap
 *   - `reconcilePosition` / `determineHistoryCompleteness` (reconciliation.ts)
 *     for roll-forward, IDENTICAL to the formula `documentProcessing.ts`'s
 *     `evaluatePositionAndCertify` already uses in production
 *   - `OPENING_BALANCE_SOURCE_REFERENCE` (openingBalanceMarker.ts) for the
 *     same known-opening-balance detection FS1 already certified
 * This file's own job is narrow: read the AIE-generic `AieFieldCandidate[]`
 * back into typed records, join them against a caller-supplied read-only
 * snapshot of existing canonical state (never written to here), and shape
 * the result as `AieReconciliationRunResult[]`.
 *
 * NO CONFIDENCE SCORE INPUT (P4) — this function's signature, like AIE-1.1's
 * own `ReconciliationRule` type, has no `confidence` parameter anywhere.
 *
 * DI, NOT A LIVE DB CALL. `buildInvestmentReconciliationRule` takes an
 * already-fetched, read-only `InvestmentReconciliationContext` rather than
 * querying Supabase itself — mirrors AIE-1.1's own orchestrator DI pattern
 * (`AieOrchestratorDeps`) so this rule is unit-testable with zero database
 * access, and keeps this file itself free of any I/O.
 */

import { computeTransactionFingerprint } from '@/lib/services/investment-intelligence/fingerprint';
import { determineHistoryCompleteness, reconcilePosition, type ReconciliationTransactionInput } from '@/lib/services/investment-intelligence/reconciliation';
import { OPENING_BALANCE_SOURCE_REFERENCE } from '@/lib/services/investment-intelligence/openingBalanceMarker';
import { parseExactDecimal, scaledToNumber, ZERO } from '@/lib/services/investment-intelligence/decimal';
import type { ReconciliationConfig } from '@/lib/services/investment-intelligence/reconciliationConfig';
import type { IiTransactionType } from '@/lib/services/investment-intelligence/types';
import type { SchemeResolutionOutcome } from '@/lib/services/investment-intelligence/schemeResolution';
import type { AccountMatchingResult } from './accountMatching';
import { candidatesByRecordType } from './parserAdapter';
import type { ReconciliationHandoffRequest, ReconciliationRule } from '../../reconciliation/types';
import type { AieReconciliationRunResult } from '../../types';

function toScaled(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const parsed = parseExactDecimal(String(value));
  return parsed.ok ? parsed.scaled : null;
}

export interface ExistingSnapshotForRollForward {
  unitsScaled: bigint;
  asOfDateIso: string;
}

export interface InvestmentReconciliationContext {
  sourceKey: string;
  countryCode: string;
  accountMatches: AccountMatchingResult;
  instrumentMatches: ReadonlyMap<string, SchemeResolutionOutcome>;
  /** `${accountId}:${fingerprint}` set, from `ii_transactions.transaction_fingerprint`. */
  existingFingerprints: ReadonlySet<string>;
  /** `${accountId}:${instrumentId}` -> most recent EXISTING closing snapshot, if any. */
  existingSnapshots: ReadonlyMap<string, ExistingSnapshotForRollForward>;
  /** `${accountId}:${instrumentId}` -> existing transactions strictly after that snapshot's as-of date. */
  existingTransactionsForPosition: ReadonlyMap<string, { canonicalType: IiTransactionType; unitsScaled: bigint | null; sourceReference: string | null }[]>;
  /** accountId -> currency_code already on file for that account. */
  existingAccountCurrency: ReadonlyMap<string, string>;
  config: ReconciliationConfig;
}

function resolvedAccountId(ctx: InvestmentReconciliationContext, folioNumber: string | null, amcName: string): string | null {
  const key = ctx.accountMatches.plan.resolveRowKey(folioNumber, amcName);
  const outcome = ctx.accountMatches.byKey.get(key);
  return outcome?.kind === 'resolved' ? outcome.accountId : null;
}

function resolvedInstrumentId(ctx: InvestmentReconciliationContext, schemeKeyValue: string): string | null {
  const outcome = ctx.instrumentMatches.get(schemeKeyValue);
  return outcome?.kind === 'resolved' ? outcome.instrumentId : null;
}

function hasAmbiguousAccount(ctx: InvestmentReconciliationContext, folioNumber: string | null, amcName: string): boolean {
  const key = ctx.accountMatches.plan.resolveRowKey(folioNumber, amcName);
  return ctx.accountMatches.byKey.get(key)?.kind === 'ambiguous';
}

function hasAmbiguousInstrument(ctx: InvestmentReconciliationContext, schemeKeyValue: string): boolean {
  return ctx.instrumentMatches.get(schemeKeyValue)?.kind === 'ambiguous';
}

/** Rule 1 — DEDUP-style duplicate/overlap detection, keyed on the SAME
 * resolved-id fingerprint formula the real write path uses. */
function duplicateOverlapResult(ctx: InvestmentReconciliationContext, candidates: ReturnType<typeof candidatesByRecordType>): AieReconciliationRunResult {
  let anyUnresolvable = false;
  let duplicateCount = 0;
  let resolvedCount = 0;

  for (const { value } of candidates) {
    const folioNumber = (value.folioNumber as string | null) ?? null;
    const scheme = value.scheme as { amcName: string; normalisedSchemeName: string; planType: string; optionType: string } | undefined;
    if (!scheme) {
      anyUnresolvable = true;
      continue;
    }
    const schemeKeyValue = `${scheme.normalisedSchemeName}|${scheme.planType}|${scheme.optionType}|${scheme.amcName}`;

    if (hasAmbiguousAccount(ctx, folioNumber, scheme.amcName) || hasAmbiguousInstrument(ctx, schemeKeyValue)) {
      anyUnresolvable = true;
      continue;
    }

    const accountId = resolvedAccountId(ctx, folioNumber, scheme.amcName);
    const instrumentId = resolvedInstrumentId(ctx, schemeKeyValue);
    if (!accountId || !instrumentId) continue; // genuinely new account/instrument — no existing history to collide with, not unresolvable

    resolvedCount++;
    const fingerprint = computeTransactionFingerprint({
      sourceKey: ctx.sourceKey,
      accountId,
      instrumentId,
      transactionDateIso: value.transactionDateIso as string,
      transactionType: value.canonicalType as IiTransactionType,
      amountScaled: toScaled(value.amount) ?? ZERO,
      unitsScaled: toScaled(value.units),
      navScaled: toScaled(value.nav),
      sourceReference: (value.sourceReference as string | null) ?? null,
    });
    if (ctx.existingFingerprints.has(`${accountId}:${fingerprint}`)) duplicateCount++;
  }

  if (anyUnresolvable) {
    return { ruleId: 'ii_adapter_duplicate_overlap', ruleVersion: '1', outcome: 'indeterminate' };
  }
  if (duplicateCount > 0) {
    return { ruleId: 'ii_adapter_duplicate_overlap', ruleVersion: '1', outcome: 'pass_with_tolerance', delta: duplicateCount };
  }
  void resolvedCount; // kept for future diagnostics/audit — no branch depends on it today
  return { ruleId: 'ii_adapter_duplicate_overlap', ruleVersion: '1', outcome: 'pass' };
}

/** Rule 2 — per-position roll-forward, one `AieReconciliationRunResult` per
 * distinct (account, instrument) position with a closing holding candidate. */
function rollForwardResults(
  ctx: InvestmentReconciliationContext,
  transactionCandidates: ReturnType<typeof candidatesByRecordType>,
  holdingCandidates: ReturnType<typeof candidatesByRecordType>,
): AieReconciliationRunResult[] {
  const results: AieReconciliationRunResult[] = [];

  for (const { value: holding } of holdingCandidates) {
    const folioNumber = (holding.folioNumber as string | null) ?? null;
    const scheme = holding.scheme as { amcName: string; normalisedSchemeName: string; planType: string; optionType: string };
    const schemeKeyValue = `${scheme.normalisedSchemeName}|${scheme.planType}|${scheme.optionType}|${scheme.amcName}`;

    if (hasAmbiguousAccount(ctx, folioNumber, scheme.amcName) || hasAmbiguousInstrument(ctx, schemeKeyValue)) {
      results.push({ ruleId: `ii_adapter_roll_forward:ambiguous:${schemeKeyValue}`, ruleVersion: '1', outcome: 'indeterminate' });
      continue;
    }

    const accountId = resolvedAccountId(ctx, folioNumber, scheme.amcName);
    const instrumentId = resolvedInstrumentId(ctx, schemeKeyValue);
    if (!accountId || !instrumentId) continue; // brand-new position — nothing to roll forward against yet, not a failure

    const positionKey = `${accountId}:${instrumentId}`;
    const closingUnits = toScaled(holding.units) ?? ZERO;

    const newTxnsForPosition: ReconciliationTransactionInput[] = transactionCandidates
      .filter(({ value: t }) => {
        const tScheme = t.scheme as typeof scheme;
        const tKey = `${tScheme.normalisedSchemeName}|${tScheme.planType}|${tScheme.optionType}|${tScheme.amcName}`;
        return resolvedAccountId(ctx, (t.folioNumber as string | null) ?? null, tScheme.amcName) === accountId && tKey === schemeKeyValue;
      })
      .map(({ value: t }) => ({ canonicalType: t.canonicalType as IiTransactionType, unitsScaled: toScaled(t.units) }));

    const hasNewOpeningMarker = transactionCandidates.some(({ value: t }) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);
    const existingSnapshot = ctx.existingSnapshots.get(positionKey) ?? null;
    const existingTxns = ctx.existingTransactionsForPosition.get(positionKey) ?? [];
    const hasExistingOpeningMarker = existingTxns.some((t) => t.sourceReference === OPENING_BALANCE_SOURCE_REFERENCE);

    const allTxns: ReconciliationTransactionInput[] = [
      ...existingTxns.map((t) => ({ canonicalType: t.canonicalType, unitsScaled: t.unitsScaled })),
      ...newTxnsForPosition,
    ];

    const historyCompleteness = determineHistoryCompleteness({
      hasExplicitOpeningBalanceTransaction: hasNewOpeningMarker || hasExistingOpeningMarker,
      hasAnyTransactionHistory: allTxns.length > 0,
      hasClosingHoldingSnapshot: true,
      statementCoversFromInception: !existingSnapshot && allTxns.length > 0 && !hasNewOpeningMarker && !hasExistingOpeningMarker,
    });

    const reconciliation = reconcilePosition({
      openingUnitsScaled: existingSnapshot?.unitsScaled ?? null,
      transactions: allTxns,
      statementClosingUnitsScaled: closingUnits,
      historyCompleteness,
      config: ctx.config,
    });

    const ruleId = `ii_adapter_roll_forward:${accountId}:${instrumentId}`;
    if (reconciliation.withinTolerance === null) {
      results.push({ ruleId, ruleVersion: '1', outcome: 'indeterminate' });
    } else if (!reconciliation.withinTolerance) {
      results.push({
        ruleId,
        ruleVersion: '1',
        outcome: 'fail',
        delta: reconciliation.unitVarianceScaled === null ? null : scaledToNumber(reconciliation.unitVarianceScaled),
        tolerance: scaledToNumber(ctx.config.unitToleranceScaled),
      });
    } else {
      const isExact = reconciliation.unitVarianceScaled !== null && reconciliation.unitVarianceScaled === ZERO;
      results.push({
        ruleId,
        ruleVersion: '1',
        outcome: isExact ? 'pass' : 'pass_with_tolerance',
        delta: reconciliation.unitVarianceScaled === null ? null : scaledToNumber(reconciliation.unitVarianceScaled),
        tolerance: scaledToNumber(ctx.config.unitToleranceScaled),
      });
    }
  }

  return results;
}

/** Rule 3 — canonical-conflict: an existing account's own currency must
 * agree with what this statement's country/currency derivation implies
 * (`documentProcessing.ts`'s own `countryCode === 'IN' ? 'INR' : 'AUD'`
 * derivation, reused verbatim here for consistency — not re-derived
 * differently). A genuinely new account has nothing to conflict with. */
function canonicalConflictResults(ctx: InvestmentReconciliationContext): AieReconciliationRunResult[] {
  const impliedCurrency = ctx.countryCode === 'IN' ? 'INR' : 'AUD';
  const results: AieReconciliationRunResult[] = [];
  for (const outcome of ctx.accountMatches.outcomes) {
    if (outcome.kind !== 'resolved') continue;
    const existingCurrency = ctx.existingAccountCurrency.get(outcome.accountId);
    if (!existingCurrency) continue;
    const ruleId = `ii_adapter_canonical_conflict:${outcome.accountId}`;
    results.push(
      existingCurrency === impliedCurrency
        ? { ruleId, ruleVersion: '1', outcome: 'pass' }
        : { ruleId, ruleVersion: '1', outcome: 'fail' },
    );
  }
  return results;
}

export function buildInvestmentReconciliationRule(ctx: InvestmentReconciliationContext): ReconciliationRule {
  return (req: ReconciliationHandoffRequest): AieReconciliationRunResult[] => {
    const transactionCandidates = candidatesByRecordType(req.candidates, 'transaction');
    const holdingCandidates = candidatesByRecordType(req.candidates, 'holding');

    if (transactionCandidates.length === 0 && holdingCandidates.length === 0) {
      return [{ ruleId: 'ii_adapter_no_candidates', ruleVersion: '1', outcome: 'not_applicable' }];
    }

    return [
      duplicateOverlapResult(ctx, transactionCandidates),
      ...rollForwardResults(ctx, transactionCandidates, holdingCandidates),
      ...canonicalConflictResults(ctx),
    ];
  };
}
