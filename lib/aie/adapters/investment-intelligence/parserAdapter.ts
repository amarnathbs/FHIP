/**
 * AIE-1.2 — wraps the EXISTING deterministic Investment Intelligence parsers
 * (CAMS/KFintech CAS + CAMS individual Folio statement — see
 * `documentCatalogue.ts`) as one AIE-registered `RegisteredParser`
 * (mandatory execution sequence step 6: "wrap the EXISTING deterministic
 * CAS parser as an AIE-registered classifier/parser ... before enabling any
 * masked AI fallback path").
 *
 * REUSE, NOT REBUILD. Every actual parsing decision (source detection,
 * folio/scheme extraction, transaction classification, warning/error
 * generation, the deterministic confidence formula) is made by
 * `lib/services/investment-intelligence/parsers/registry.ts`'s
 * `detectSource` / `parseDocumentWithParser` — cited by file:line in
 * AIE_1_2_IMPLEMENTATION.md. This file's own job is narrow: translate that
 * module's own `ParsedDocumentOutput` shape into AIE-1.1's generic
 * `AieFieldCandidate[]` vocabulary, and decide the one thing AIE-1.1's
 * `DeterministicParserResult` needs that Investment Intelligence's own
 * `ValidationOutcome` does not directly give it: outcome
 * complete/partial/failed.
 *
 * DISCLOSED DESIGN DECISION — candidate encoding. AIE-1.1's
 * `AieFieldCandidate` is shaped for ONE scalar value per field (a single
 * missing form field an AI fallback might fill in). Investment Intelligence
 * statements are structured multi-record documents (many accounts,
 * transactions, holdings). Rather than inventing a second, adapter-private
 * candidate shape (which would violate "no second exception/candidate
 * system" in spirit), each parsed record is serialised as ONE
 * `AieFieldCandidate` whose `fieldName` names its record kind/index (e.g.
 * `transaction:12`) and whose `valueRaw` is that record's own fields
 * encoded as JSON (bigint amounts converted to exact decimal strings first
 * — see `serializeTransaction`/`serializeHolding` below — never a
 * lossy float). `sourceReference` carries `{ recordType, index }` so a
 * later stage (matching/reconciliation) can find a specific record without
 * re-parsing the JSON blindly. This mapping decision is recorded here,
 * verbatim, rather than silently reinterpreted.
 *
 * AI-ELIGIBLE GAPS — deliberately always empty this pass. Every registered
 * II parser either extracts a transaction/holding/account line completely
 * or records a typed WARNING/ERROR against it (`ParsedWarning`) — none of
 * them has a concept of "this one field is missing, ask AI to fill it in".
 * Wiring a masked-AI-fallback gap out of nothing here would mean inventing
 * an AI-eligible field that doesn't correspond to any real extraction gap,
 * which is worse than declaring honestly that this pass's masked-AI path
 * for Investment Intelligence is designed (see `schema.ts`) but UNEXERCISED
 * — no real document reaches it today. A future pass with a genuine
 * "illegible narrative fragment" case would populate `aiEligibleGaps` for
 * real, through this same file.
 */

import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';
import type {
  ParsedAccountRecord,
  ParsedDocumentOutput,
  ParsedHoldingRecord,
  ParsedTransactionRecord,
} from '@/lib/services/investment-intelligence/parsers/types';
import { aieParserRegistry, type DeterministicParserResult, type RegisteredParser } from '../../classifier/registry';
import type { AieDeterministicOutcome, AieFieldCandidate } from '../../types';

export const II_ADAPTER_ID = 'ii_cas_kfintech_folio_v1';
export const II_ADAPTER_VERSION = '1';

function serializeAccount(a: ParsedAccountRecord): Record<string, unknown> {
  return { ...a };
}

function serializeTransaction(t: ParsedTransactionRecord): Record<string, unknown> {
  return {
    folioNumber: t.folioNumber,
    scheme: t.scheme,
    transactionDateIso: t.transactionDateIso,
    rawTransactionTypeText: t.rawTransactionTypeText,
    canonicalType: t.canonicalType,
    classificationConfidence: t.classificationConfidence,
    amount: scaledToDecimalString(t.amountScaled, 2),
    units: t.unitsScaled === null ? null : scaledToDecimalString(t.unitsScaled),
    nav: t.navScaled === null ? null : scaledToDecimalString(t.navScaled),
    balanceUnitsAfter: t.balanceUnitsAfterScaled === null ? null : scaledToDecimalString(t.balanceUnitsAfterScaled),
    sourceReference: t.sourceReference,
    sourceDescription: t.sourceDescription,
  };
}

function serializeHolding(h: ParsedHoldingRecord): Record<string, unknown> {
  return {
    folioNumber: h.folioNumber,
    scheme: h.scheme,
    asOfDateIso: h.asOfDateIso,
    units: scaledToDecimalString(h.unitsScaled),
    value: h.valueScaled === null ? null : scaledToDecimalString(h.valueScaled, 2),
    nav: h.navScaled === null ? null : scaledToDecimalString(h.navScaled),
  };
}

export function toAieCandidates(parsed: ParsedDocumentOutput): AieFieldCandidate[] {
  const candidates: AieFieldCandidate[] = [];

  candidates.push({
    fieldName: 'metadata',
    valueRaw: JSON.stringify(parsed.metadata),
    isNull: false,
    sourceMethod: 'deterministic',
    sourceReference: { recordType: 'metadata' },
  });

  parsed.accounts.forEach((a, index) => {
    candidates.push({
      fieldName: `account:${index}`,
      valueRaw: JSON.stringify(serializeAccount(a)),
      isNull: false,
      sourceMethod: 'deterministic',
      sourceReference: { recordType: 'account', index },
    });
  });

  parsed.transactions.forEach((t, index) => {
    candidates.push({
      fieldName: `transaction:${index}`,
      valueRaw: JSON.stringify(serializeTransaction(t)),
      isNull: false,
      sourceMethod: 'deterministic',
      sourceReference: { recordType: 'transaction', index },
    });
  });

  parsed.holdings.forEach((h, index) => {
    candidates.push({
      fieldName: `holding:${index}`,
      valueRaw: JSON.stringify(serializeHolding(h)),
      isNull: false,
      sourceMethod: 'deterministic',
      sourceReference: { recordType: 'holding', index },
    });
  });

  return candidates;
}

/** Reverses `toAieCandidates` for one record kind — used by the matching/
 * reconciliation stages, which receive only the generic `AieFieldCandidate[]`
 * the orchestrator persisted, not the original `ParsedDocumentOutput`. */
export function candidatesByRecordType(
  candidates: readonly AieFieldCandidate[],
  recordType: 'account' | 'transaction' | 'holding',
): { index: number; value: Record<string, unknown> }[] {
  return candidates
    .filter((c) => (c.sourceReference as { recordType?: string } | undefined)?.recordType === recordType)
    .map((c) => ({
      index: (c.sourceReference as { index: number }).index,
      value: c.valueRaw ? (JSON.parse(c.valueRaw) as Record<string, unknown>) : {},
    }))
    .sort((a, b) => a.index - b.index);
}

export function parsedMetadataFromCandidates(candidates: readonly AieFieldCandidate[]): Record<string, unknown> | null {
  const row = candidates.find((c) => (c.sourceReference as { recordType?: string } | undefined)?.recordType === 'metadata');
  return row?.valueRaw ? (JSON.parse(row.valueRaw) as Record<string, unknown>) : null;
}

function outcomeFor(parsed: ParsedDocumentOutput, validationOk: boolean): AieDeterministicOutcome {
  if (!validationOk) return 'failed';
  if (parsed.errors.length > 0) return 'partial';
  return 'complete';
}

export const investmentIntelligenceRegisteredParser: RegisteredParser = {
  adapterId: II_ADAPTER_ID,
  version: II_ADAPTER_VERSION,
  moduleHint: 'investment_intelligence',

  // REG-02: sniffing uses already-extracted local text only (never raw
  // bytes, never the filename) — delegated entirely to Investment
  // Intelligence's own real, certified detection heuristics.
  sniff: (text: string) => detectSource(text).parser !== null,

  parse: (text: string): DeterministicParserResult => {
    const detection = detectSource(text);
    if (!detection.parser) {
      // Should not normally be reached (the orchestrator only calls
      // `parse` after `sniff` returned true), but handled honestly rather
      // than assumed unreachable.
      return { outcome: 'not_applicable', candidates: [], aiEligibleGaps: [] };
    }

    const parsed = parseDocumentWithParser(detection.parser, text);
    const validation = detection.parser.validateParsedOutput(parsed);
    const candidates = toAieCandidates(parsed);

    return {
      outcome: outcomeFor(parsed, validation.ok),
      documentClass: parsed.metadata.documentTypeDetected,
      candidates,
      aiEligibleGaps: [],
      failureReason: validation.ok ? undefined : validation.errors.join('; '),
    };
  },
};

let registered = false;

/** Idempotent — safe to call from multiple entry points (API route module
 * init, tests) without hitting the registry's own duplicate-registration
 * guard. */
export function registerInvestmentIntelligenceAieParser(): void {
  if (registered) return;
  aieParserRegistry.register(investmentIntelligenceRegisteredParser);
  registered = true;
}
