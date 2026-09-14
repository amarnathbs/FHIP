/**
 * M3 (Phase 4), item I.1 — THE MISSING REAL INVESTMENT INTELLIGENCE PATH.
 *
 * WHAT WAS ACTUALLY MISSING. Every individual piece of AIE-1.2 existed and
 * was unit-tested: a registered parser wrapping the certified CAMS/KFintech/
 * Folio parsers, conservative account and instrument matching, a
 * deterministic reconciliation rule, typed unresolved items, a gated atomic
 * canonical write, and a governed acceptance gate that already dispatches on
 * `II_ADAPTER_ID`. What did not exist was anything that CALLED them together.
 * `registerInvestmentIntelligenceAdapter()` had zero production callers, so
 * `sniffDocument()` could never match an investment document; the generic
 * `/api/aie/intake` route ran `noDomainAdapterReconciliationRule`, which
 * reports `not_applicable`, which `accept.ts` explicitly refuses as "a
 * document nothing ever actually checked". The net effect was that
 * `source_module_hint=investment_intelligence` was metadata and nothing else
 * — which is exactly what the dispatch says must not be treated as dispatch.
 *
 * This module is the missing orchestration. It is a SERVICE, not a route,
 * for a specific reason: the required journey has two entry points (a plain
 * upload, and a later password-unlock for an encrypted statement) that must
 * run identical processing. Putting the pipeline in a route would mean
 * either duplicating it or having one route call the other's handler.
 *
 * THE JOURNEY, IN THE DISPATCH'S OWN ORDER:
 *   user -> authenticated II/AIE intake (the route)
 *        -> quarantine + scan gate          (`admitDocument`)
 *        -> decrypt if needed               (`password` parameter)
 *        -> local extraction                (`extractPdfTextLocally`)
 *        -> deterministic investment parser (registered II parser, Level 1)
 *        -> masked AI fallback for approved gaps only (gated; see below)
 *        -> strict investment JSON schema   (`documentFactsSchema`)
 *        -> II deterministic reconciliation (`buildInvestmentReconciliationRule`)
 *        -> AIE unresolved items            (`createUnresolvedItems`)
 *        -> PC5/user acceptance when required  (NOT here — see I.9 note)
 *        -> II domain-owned atomic canonical write (NOT here — accept.ts)
 *        -> AIE completion + binary purge   (accept.ts -> finalizeDocumentBinaryAfterRun)
 *
 * I.9 / M2-OPEN-6 — THE ANTI-PATTERN THIS ROUTE DELIBERATELY DOES NOT COPY.
 * M2 recorded that `app/api/aie/fdh-bank/intake/route.ts` performs a
 * canonical write inline at intake time, bypassing `accept.ts` entirely —
 * the same shortcut the Insurance route explicitly removed, citing AIE-1.5's
 * own non-negotiable prohibition on "silently auto-writing the moment
 * extraction reaches `awaiting_acceptance`". This module contains NO write.
 * It imports no canonical write service, holds no reference to
 * `acceptAndWriteInvestmentCandidates`, and returns at the extraction
 * outcome. The only path to a canonical Investment Intelligence row remains
 * `POST /api/aie/review/runs/{runId}/accept`, which re-derives the blocking
 * count and the reconciliation outcome server-side rather than trusting
 * anything this request computed.
 *
 * QUARANTINE AND SCAN GATING — WHAT IS REAL HERE AND WHAT IS NOT.
 * The dispatch requires a quarantine/scan step. The honest position, which
 * M2 established and M3 re-verified fresh: this application has no S3 code
 * path and no GuardDuty wiring, the credentials in this environment have
 * zero S3/GuardDuty permissions, and both candidate bucket names provably do
 * not exist. So the quarantine implemented here is the one the codebase
 * ACTUALLY has — Supabase Storage, service-role-only, per-user path prefix —
 * and the "scan" is `validateUploadForAdmission`'s real structural and
 * signature checks, which fail CLOSED. That is a genuine admission gate, and
 * it is not a malware scanner. The S3 + GuardDuty swap remains blocked
 * infrastructure and is named as such in the M3 report rather than implied
 * to be done.
 */

import { extractPdfTextLocally } from '../../extraction/textExtraction';
import { downloadFromQuarantine } from '../../storage';
import { createRun, createUnresolvedItems, recordReconciliationRuns, updateIntakeStatus } from '../../db/repository';
import { recordAieAuditEvent } from '../../audit';
import { runExtractionPipeline, type AieOrchestratorDeps, type RunPipelineOutcome } from '../../orchestrator';
import { detectSource, parseDocumentWithParser } from '@/lib/services/investment-intelligence/parsers/registry';
import { registerInvestmentIntelligenceAdapter } from './index';
import { registerInvestmentDocumentFactsSchema, AIE_II_DOCUMENT_FACTS_SCHEMA_NAME, AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION } from './documentFactsSchema';
import { buildInvestmentReconciliationContext } from './context';
import { buildInvestmentReconciliationRule } from './reconciliationRule';
import { checkStatementPeriod } from './statementMatching';
import { isDocumentClassCertified } from './documentCatalogue';
import {
  unresolvedItemForOwnerUnresolved,
  unresolvedItemForStatementPeriod,
  unresolvedItemsForAccountMatches,
  unresolvedItemsForInstrumentMatches,
} from './unresolvedItems';
import type { AieUnresolvedItemInput } from '../../types';

/**
 * THE AI PROVIDER IS INJECTED, NOT CONSTRUCTED HERE — and that is a rule,
 * not a preference. AIE-1.2's own prohibition P2 forbids any file in this
 * adapter directory from importing a provider or provider-selection module:
 * "only the orchestrator (outside this adapter) wires the gateway in". An
 * earlier draft of this file built its own `AieDocumentAiGateway` and
 * `tests/unit/aieIiAdapterProhibitions.test.ts` caught it, which is exactly
 * what that test exists for. The route constructs the gateway (as the
 * Insurance route already does) and hands the resulting orchestrator deps
 * down. The kill switch and cost admission therefore live where every other
 * AIE intake route puts them, and this module keeps no provider reference of
 * any kind.
 */
export type DispatchOutcome =
  | { ok: false; reason: 'password_required' | 'wrong_password'; intakeId: string }
  | { ok: false; reason: 'quarantine_download_failed' | 'local_extraction_failed' | 'run_create_failed'; intakeId: string; detail: string }
  | { ok: false; reason: 'not_an_investment_document'; intakeId: string; detail: string }
  | {
      ok: true;
      intakeId: string;
      runId: string;
      finalStatus: RunPipelineOutcome['finalStatus'];
      aiWasUsed: boolean;
      candidateCount: number;
      unresolvedItemIds: string[];
      parserCode: string;
      documentClass: string | null;
      certifiedDocumentClass: boolean;
    };

export interface DispatchParams {
  intakeId: string;
  userId: string;
  /** The AIE quarantine object key for this intake. Bytes are re-fetched
   * from it rather than passed in, so the unlock entry point and the upload
   * entry point genuinely share one code path. */
  storageKey: string;
  /** Owner's country, needed for instrument resolution and for the
   * currency-conflict rule. Supplied by the caller from the authenticated
   * household context — never derived from the document text, which would be
   * an inference about jurisdiction from evidence that does not state it. */
  countryCode: string;
  /**
   * Household member this statement belongs to, if the user has said. NOT
   * inferred, ever: PC4-INV-12's own finding is that owner MISMATCH detection
   * does not exist in Investment Intelligence at all and that `holderName` is
   * parsed and discarded. Passing null here produces a typed BLOCKING
   * unresolved item rather than a guess.
   */
  ownerMemberId: string | null;
  /** Supplied only by the unlock entry point. Never logged, never persisted,
   * never echoed, never sent to a provider. */
  password?: string;
  /** Built by the route via `createDefaultDeps(gateway)`. See the note above
   * on why this adapter may not construct a provider itself. */
  deps: AieOrchestratorDeps;
}

/**
 * Runs one investment document all the way from quarantine bytes to a
 * reconciled extraction run with typed unresolved items.
 *
 * KEYED BY IMMUTABLE INTAKE IDENTITY (item I.2). Every step below is keyed
 * on `intakeId` — the `aie_document_intake` primary key, a server-generated
 * UUID — and on the `runId` derived from it. `storageKey` is used only to
 * FETCH bytes, never as a logical identity, and it is itself built from two
 * random UUIDs (`buildQuarantineStorageKey`: `{userId}/{intakeId}/{intakeId}.bin`)
 * so it cannot collide between two documents even with the same filename.
 */
export async function dispatchInvestmentDocument(params: DispatchParams): Promise<DispatchOutcome> {
  const { intakeId, userId, storageKey, countryCode, ownerMemberId, password, deps } = params;

  // Registration is idempotent and safe to call per-request. Doing it here
  // rather than only at route module load is deliberate: the Insurance route
  // shipped a bug where a bare side-effect-free import was believed to
  // register the adapter and did not, and the failure mode was invisible
  // (`sniffDocument` silently returned `none_matched`) until the route was
  // driven against real infrastructure. Calling the real function on the
  // path that needs it removes that class of mistake entirely.
  registerInvestmentIntelligenceAdapter();
  registerInvestmentDocumentFactsSchema();

  const download = await downloadFromQuarantine(storageKey);
  if (!download.ok) return { ok: false, reason: 'quarantine_download_failed', intakeId, detail: download.message };

  const extraction = await extractPdfTextLocally(download.bytes, password);
  if (!extraction.ok) {
    if (extraction.kind === 'password_required' || extraction.kind === 'wrong_password') {
      // The document stays QUARANTINED and unprocessed. No run is created, so
      // no canonical row of any kind can exist for a failed attempt
      // (PC4-INV-17's "failed attempts create no canonical rows", preserved
      // here rather than re-derived). The password itself is not referenced.
      await recordAieAuditEvent({
        intakeId,
        runId: null,
        userId,
        eventType: 'intake_rejected_admission',
        actorType: 'system',
        metadata: { failure_code: extraction.kind, password_supplied: password !== undefined },
      });
      return { ok: false, reason: extraction.kind, intakeId };
    }
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: extraction.kind });
    return { ok: false, reason: 'local_extraction_failed', intakeId, detail: extraction.kind };
  }

  // --- Deterministic detection BEFORE anything else (item I.3) ------------
  // The certified CAMS/KFintech/Folio parsers remain Level 1 and run first.
  // If none of them claims the document, this route refuses it rather than
  // handing an unknown document to an AI fallback and hoping — "do not claim
  // broker/platform support you have not built and tested" is the catalogue's
  // own rule, and an AI-only path would quietly violate it.
  const detection = detectSource(extraction.concatenatedText);
  if (!detection.parser) {
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: 'not_an_investment_document' });
    return {
      ok: false,
      reason: 'not_an_investment_document',
      intakeId,
      detail: `no certified investment parser claimed this document (detection confidence ${detection.detection.confidence})`,
    };
  }

  const parsed = parseDocumentWithParser(detection.parser, extraction.concatenatedText);

  // --- Read-only canonical snapshot + the adapter's reconciliation rule ---
  const context = await buildInvestmentReconciliationContext({
    userId,
    countryCode,
    sourceKey: parsed.metadata.sourceKey,
    parsed,
  });

  const run = await createRun({ intakeId, userId, runNumber: 1 });
  if ('error' in run) return { ok: false, reason: 'run_create_failed', intakeId, detail: run.error };

  const outcome = await runExtractionPipeline({
    runId: run.id,
    intakeId,
    userId,
    extractedText: extraction.concatenatedText,
    reconcile: buildInvestmentReconciliationRule(context),
    deps,
    // The II parser is reached through the global registry (registered
    // above), exactly like Insurance's — no `parserOverride` is needed
    // because the II parser is stateless.
    schemaOverride: {
      schemaName: AIE_II_DOCUMENT_FACTS_SCHEMA_NAME,
      schemaVersion: AIE_II_DOCUMENT_FACTS_SCHEMA_VERSION,
    },
  });

  // --- Matching-derived unresolved items (execution sequence step 7) ------
  // `runExtractionPipeline` already created items for FAIL/INDETERMINATE
  // reconciliation outcomes. These are the ones reconciliation cannot see,
  // because they are about IDENTITY rather than arithmetic: an ambiguous
  // account, an ambiguous instrument, an unstated owner, an unusable
  // statement period. They go through the SAME AIE-1.1 lifecycle
  // (`createUnresolvedItems`) — no second exception system.
  const matchingItems: AieUnresolvedItemInput[] = [
    ...unresolvedItemsForAccountMatches(context.accountMatches.outcomes),
    ...unresolvedItemsForInstrumentMatches(context.instrumentMatches),
    ...unresolvedItemForStatementPeriod(checkStatementPeriod(parsed.metadata)),
    ...(ownerMemberId ? [] : unresolvedItemForOwnerUnresolved(context.accountMatches.outcomes.length > 0)),
  ];

  let unresolvedItemIds = [...outcome.unresolvedItemIds];
  if (matchingItems.length > 0) {
    const ids = await createUnresolvedItems({ runId: run.id, intakeId, userId, items: matchingItems });
    unresolvedItemIds = [...unresolvedItemIds, ...ids];

    // A blocking identity item must also be visible to the acceptance gate's
    // RECONCILIATION check, not only to its blocking-item count. Recording it
    // as a reconciliation run keeps the two views of "is this document
    // acceptable" consistent — `accept.ts` refuses on either signal, and a
    // document that is blocked for one reason but reads as `pass` on the
    // other is the kind of inconsistency that invites an "accept anyway"
    // shortcut later.
    await recordReconciliationRuns({
      runId: run.id,
      intakeId,
      userId,
      results: matchingItems.map((item) => ({
        ruleId: `ii_adapter_identity:${item.reasonCode}`,
        ruleVersion: '1',
        outcome: 'fail' as const,
      })),
    });
  }

  return {
    ok: true,
    intakeId,
    runId: run.id,
    // `runExtractionPipeline` may have reached `awaiting_acceptance` on
    // arithmetic alone. If identity items were added afterwards the document
    // is NOT acceptable, and saying `awaiting_acceptance` here would be
    // misleading to the caller even though `accept.ts` would still refuse it.
    finalStatus: unresolvedItemIds.length > outcome.unresolvedItemIds.length ? 'unresolved' : outcome.finalStatus,
    aiWasUsed: outcome.aiWasUsed,
    candidateCount: outcome.candidates.length,
    unresolvedItemIds,
    parserCode: parsed.parserCode,
    documentClass: parsed.metadata.documentTypeDetected,
    certifiedDocumentClass: isDocumentClassCertified(parsed.parserCode),
  };
}
