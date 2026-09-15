/**
 * PC5 (M4) — reconstructing a parsed Investment Intelligence document from
 * the field candidates AIE already persisted, so a re-reconciliation
 * (K.19) never has to re-read the original PDF.
 *
 * ================================================================
 * WHY NOT JUST RE-DOWNLOAD AND RE-PARSE?
 * ================================================================
 * That was the obvious design and it is worse in four separate ways, each
 * of which independently matters:
 *
 *   1. GLOBAL INVARIANT D.3 — "source evidence is immutable; corrections
 *      are overlays". `aie_field_candidate` rows ARE the recorded source
 *      evidence for a run: written once by the deterministic parser,
 *      never mutated (`candidateMerge.ts` overlays corrections on top
 *      rather than editing them). Reconciling against them is reconciling
 *      against the evidence of record. Re-parsing produces a SECOND,
 *      possibly different reading and then reconciles against that — which
 *      is precisely the "silent rewrite" D.3 forbids.
 *
 *   2. PARSER DRIFT. A re-parse runs whatever parser version is deployed
 *      TODAY, not the one that produced the run. If a parser changed
 *      between the upload and the user's decision, the user would be
 *      answering a question about one document and the system would be
 *      re-deciding a different one — with no signal that it had happened.
 *      K.12's `parser_version_at_decision` exists to pin exactly this, and
 *      would be meaningless if re-reconciliation silently used a newer
 *      parser.
 *
 *   3. THE BYTES ARE OFTEN ALREADY GONE, LEGITIMATELY. AIE's document
 *      lifecycle deletes the quarantine object as soon as it is no longer
 *      required, and a 24-hour hard backstop
 *      (`enforceAieRawFileHardBackstop`) deletes it regardless. A user who
 *      comes back the next day to resolve an exception would find
 *      re-reconciliation impossible — the workflow would be defeated by
 *      the privacy guarantee it is supposed to coexist with. K.21 wants
 *      the PDF gone; K.19 wants resolution to re-reconcile; only
 *      candidate-based reconciliation satisfies both.
 *
 *   4. PASSWORD-PROTECTED DOCUMENTS. Re-extraction would need the password
 *      again, on every decision. Working from candidates means a document
 *      that was successfully unlocked ONCE never needs the password again.
 *
 * ================================================================
 * WHAT IS AND IS NOT FAITHFUL
 * ================================================================
 * `toAieCandidates` (parserAdapter.ts) serialises every account,
 * transaction and holding, plus the metadata block — bigint amounts as
 * EXACT decimal strings, never floats. This module is its exact inverse for
 * the fields the reconciliation context and rule consume, and
 * `tests/unit/pc5Rehydrate.test.ts` asserts the round trip on real parser
 * output rather than on a hand-built fixture.
 *
 * Two fields are NOT round-tripped, and both are deliberate:
 *   - `warnings` / `errors` come back EMPTY. They are parse-time
 *     diagnostics, they were never serialised into candidates, and nothing
 *     in the reconciliation context or rule reads them. Returning `[]` is
 *     accurate ("this reconstruction carries no diagnostics") rather than
 *     fabricated.
 *   - `parserConfidence` comes back as 0. Same reason — and deliberately
 *     the LOW end rather than a flattering 1: no code path consumes it
 *     here, and if one ever does, a zero is a visible wrong answer whereas
 *     a 1 is an invisible one.
 */

import { parseExactDecimal, ZERO } from '@/lib/services/investment-intelligence/decimal';
import type {
  ParsedAccountRecord,
  ParsedDocumentOutput,
  ParsedHoldingRecord,
  ParsedInstrumentRecord,
  ParsedTransactionRecord,
  ParseMetadata,
} from '@/lib/services/investment-intelligence/parsers/types';
import type { IiParserCode, IiTransactionType } from '@/lib/services/investment-intelligence/types';
import type { AieFieldCandidate } from '../../types';
import { candidatesByRecordType, parsedMetadataFromCandidates } from './parserAdapter';

function scaled(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const parsed = parseExactDecimal(String(value));
  return parsed.ok ? parsed.scaled : null;
}

function scaledOrZero(value: unknown): bigint {
  return scaled(value) ?? ZERO;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function instrumentFrom(value: unknown): ParsedInstrumentRecord {
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    rawSchemeName: (str(v.rawSchemeName) ?? ''),
    normalisedSchemeName: (str(v.normalisedSchemeName) ?? ''),
    amcName: (str(v.amcName) ?? ''),
    planType: (v.planType as ParsedInstrumentRecord['planType']) ?? null,
    optionType: (v.optionType as ParsedInstrumentRecord['optionType']) ?? null,
    isin: str(v.isin),
    amfiSchemeCode: str(v.amfiSchemeCode),
  };
}

export type RehydrateOutcome =
  | { ok: false; reason: 'no_metadata_candidate' | 'no_records' }
  | { ok: true; parsed: ParsedDocumentOutput };

/**
 * Rebuilds the `ParsedDocumentOutput` that `buildInvestmentReconciliationContext`
 * and `buildInvestmentReconciliationRule` consume.
 *
 * FAILS RATHER THAN GUESSING. A run whose candidates carry no metadata
 * block, or no records at all, cannot be reconciled — and the honest answer
 * is a typed refusal the caller turns into "we could not re-check this
 * document", not a default-shaped empty document that would then
 * reconcile as vacuously clean and let an unchecked statement through. That
 * is the same failure mode `revalidate.ts` avoids by returning `null` for
 * an adapter it cannot re-check rather than `noDomainAdapterReconciliationRule`.
 */
export function rehydrateParsedDocument(candidates: readonly AieFieldCandidate[]): RehydrateOutcome {
  const metadataRaw = parsedMetadataFromCandidates(candidates);
  if (!metadataRaw) return { ok: false, reason: 'no_metadata_candidate' };

  const accounts: ParsedAccountRecord[] = candidatesByRecordType(candidates, 'account').map(({ value }) => ({
    folioNumber: str(value.folioNumber),
    accountNumberMasked: str(value.accountNumberMasked),
    amcName: str(value.amcName) ?? '',
    holderName: str(value.holderName),
    panMasked: str(value.panMasked),
    jointHolders: strArray(value.jointHolders),
    holdingModeRaw: str(value.holdingModeRaw),
    raw: str(value.raw) ?? '',
  }));

  const transactions: ParsedTransactionRecord[] = candidatesByRecordType(candidates, 'transaction').map(({ value }) => ({
    folioNumber: str(value.folioNumber),
    scheme: instrumentFrom(value.scheme),
    transactionDateIso: str(value.transactionDateIso) ?? '',
    rawTransactionTypeText: str(value.rawTransactionTypeText) ?? '',
    canonicalType: (value.canonicalType as IiTransactionType) ?? 'adjustment',
    classificationConfidence: typeof value.classificationConfidence === 'number' ? value.classificationConfidence : 0,
    amountScaled: scaledOrZero(value.amount),
    unitsScaled: scaled(value.units),
    navScaled: scaled(value.nav),
    balanceUnitsAfterScaled: scaled(value.balanceUnitsAfter),
    sourceReference: str(value.sourceReference),
    sourceDescription: str(value.sourceDescription) ?? '',
  }));

  const holdings: ParsedHoldingRecord[] = candidatesByRecordType(candidates, 'holding').map(({ value }) => ({
    folioNumber: str(value.folioNumber),
    scheme: instrumentFrom(value.scheme),
    asOfDateIso: str(value.asOfDateIso) ?? '',
    unitsScaled: scaledOrZero(value.units),
    valueScaled: scaled(value.value),
    navScaled: scaled(value.nav),
  }));

  if (accounts.length === 0 && transactions.length === 0 && holdings.length === 0) {
    return { ok: false, reason: 'no_records' };
  }

  const metadata: ParseMetadata = {
    sourceKey: str(metadataRaw.sourceKey) ?? '',
    sourceConfidence: typeof metadataRaw.sourceConfidence === 'number' ? metadataRaw.sourceConfidence : 0,
    documentTypeDetected: str(metadataRaw.documentTypeDetected) ?? '',
    formatVersionDetected: str(metadataRaw.formatVersionDetected),
    statementPeriodStartIso: str(metadataRaw.statementPeriodStartIso),
    statementPeriodEndIso: str(metadataRaw.statementPeriodEndIso),
    statementAsOfDateIso: str(metadataRaw.statementAsOfDateIso),
    extractionMethod: str(metadataRaw.extractionMethod) ?? 'rehydrated_from_candidates',
  };

  return {
    ok: true,
    parsed: {
      // `parserCode` is not serialised into candidates; the metadata's own
      // `sourceKey` is the closest recorded fact and is what
      // `buildInvestmentReconciliationContext` actually consumes
      // (`sourceKey` is part of the transaction fingerprint). The cast is
      // narrow and the value is real, not invented.
      parserCode: (str(metadataRaw.sourceKey) ?? 'cams') as IiParserCode,
      parserVersion: 'rehydrated',
      metadata,
      accounts,
      transactions,
      holdings,
      warnings: [],
      errors: [],
      parserConfidence: 0,
    },
  };
}
