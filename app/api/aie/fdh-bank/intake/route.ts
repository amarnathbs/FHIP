import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { isAieDocumentIntakeEnabled, isMissingSignatureScannerAllowed } from '@/lib/aie/featureFlags';
import { DEFAULT_AIE_UPLOAD_LIMITS, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';
import { buildQuarantineStorageKey, uploadToQuarantine } from '@/lib/aie/storage';
import { createIntake, updateIntakeStatus, recordFingerprint, existingFingerprintHashesForUser, createRun, createUnresolvedItems } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { classifyDuplicate } from '@/lib/aie/fingerprint';
import { createDefaultDeps, runExtractionPipeline } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import { isAieAiFallbackEnabled } from '@/lib/aie/featureFlags';

import { classifyPdf } from '@/lib/financial-data-hub/bank-pdf/classification';
import { loadDedupIndexForAccount, loadPriorStatementDateRanges, loadExistingAccountsForInstitutionCurrency } from '@/lib/financial-data-hub/bank-csv/repository';
import { normaliseMaskedIdentifier, resolveAccountIdentity } from '@/lib/financial-data-hub/bank-csv/accountIdentity';
import { bankCsvUploadMetadataSchema } from '@/lib/financial-data-hub/validation/bankCsv';

import { isAieFdhBankAdapterEnabled, isAieFdhBankAiFallbackEnabled } from '@/lib/aie/adapters/fdhBankStatement/featureFlags';
import { createFdhBankStatementParser } from '@/lib/aie/adapters/fdhBankStatement/parser';
import { fdhBankStatementReconciliationRule, extractInstitutionHintForDisplay } from '@/lib/aie/adapters/fdhBankStatement/reconciliation';
import { commitFdhBankStatementImport } from '@/lib/aie/adapters/fdhBankStatement/atomicImport';
import '@/lib/aie/adapters/fdhBankStatement'; // side-effecting registration (schemas + classification parser)

// A single project-wide mock provider instance — genuinely no external AI
// provider traffic occurs anywhere in this route (matches the generic
// `/api/aie/intake` route's own disclosed constraint). The narrow
// institution-hint fallback this adapter declares (see parser.ts) is
// additionally gated behind its OWN feature flag
// (`AIE_FDH_BANK_AI_FALLBACK_ENABLED`), ANDed with AIE-1.1's global
// `AIE_AI_FALLBACK_ENABLED` kill switch via `isKillSwitchEnabled` below —
// both must be 'true' or every call short-circuits to
// `kill_switch_blocked` before the (mock) provider is ever invoked. Both
// default OFF.
const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), {
  isKillSwitchEnabled: () => isAieAiFallbackEnabled() && isAieFdhBankAiFallbackEnabled(),
});

// POST /api/aie/fdh-bank/intake?country_code=AU&currency_code=AUD[&institution_id=...]
//
// AIE-1.3's own AIE-fronted bank-statement intake: admission -> quarantine
// -> fingerprint (AIE-1.1, reused unchanged) -> FDH-5's own byte-level PDF
// structural classification (reused unchanged: encrypted/corrupt/image-only
// detection) -> this adapter's deterministic parser bridge (parser.ts,
// wrapping FDH-5's certified row-extraction) -> masked AI fallback for the
// ONE declared gap only (institution-hint-on-ambiguous-layout) -> this
// adapter's reconciliation rule -> AIE unresolved items for material
// failure/ambiguity, OR (gated, OFF by default) FDH's own existing atomic
// import service.
//
// This is additive: FDH's own existing
// `/api/financial-data-hub/bank-pdf/upload` route is completely unmodified
// and unaffected by this file's existence either way.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isAieFdhBankAdapterEnabled()) {
    return bad('The AIE-fronted FDH bank-statement adapter is not currently enabled in this environment.', 403);
  }
  if (!isAieDocumentIntakeEnabled()) {
    return bad('AIE document intake is not currently enabled in this environment.', 403);
  }

  const url = new URL(req.url);
  const metadataParsed = bankCsvUploadMetadataSchema.safeParse({
    original_filename_sanitised: url.searchParams.get('filename') || undefined,
    institution_id: url.searchParams.get('institution_id') || undefined,
    country_code: url.searchParams.get('country_code') || undefined,
    currency_code: url.searchParams.get('currency_code') || undefined,
    declared_masked_identifier: url.searchParams.get('masked_identifier') || undefined,
    statement_period_start: url.searchParams.get('statement_period_start') || undefined,
    statement_period_end: url.searchParams.get('statement_period_end') || undefined,
  });
  if (!metadataParsed.success) return bad(metadataParsed.error.issues[0]?.message ?? 'Invalid request', 422);
  const metadata = metadataParsed.data;

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = DEFAULT_AIE_UPLOAD_LIMITS.maxBytesByMimeType['application/pdf'];
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > maxBytes) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  const displayFilename = metadata.original_filename_sanitised ?? null;

  const rlsClient = await createClient();
  const created = await createIntake(rlsClient, {
    userId: user.id,
    declaredMimeType: 'application/pdf',
    byteSize: bytes.byteLength,
    displayFilename,
    sourceModuleHint: 'fdh_bank',
  });
  if ('error' in created) return bad('could not create intake', 500);
  const intakeId = created.id;
  await recordAieAuditEvent({ intakeId, runId: null, userId: user.id, eventType: 'intake_created', actorType: 'user', actorId: user.id });

  const admission = validateUploadForAdmission({
    declaredMimeType: 'application/pdf',
    byteLength: bytes.byteLength,
    bytes,
    allowMissingSignatureScanner: isMissingSignatureScannerAllowed(),
  });
  if (!admission.ok) {
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: admission.failureCode });
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: admission.failureCode });
  }

  const existingHashes = await existingFingerprintHashesForUser(user.id);
  const duplicateClassification = classifyDuplicate({ candidateExactHash: admission.fileHash, existingExactHashes: existingHashes });
  await recordFingerprint({ intakeId, userId: user.id, exactSha256: admission.fileHash });

  const storageKey = buildQuarantineStorageKey(user.id, intakeId);
  const uploadResult = await uploadToQuarantine({ storageKey, bytes, contentType: 'application/pdf' });
  if (!uploadResult.ok) {
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: 'storage_write_failed' });
    return bad('could not store document', 500);
  }
  await updateIntakeStatus({ intakeId, toStatus: 'quarantined', storageKey, detectedMimeType: admission.detectedMimeType });

  // FDH-5's own byte-level structural classification, REUSED UNCHANGED
  // (encrypted/corrupt/image-only/text-native/mixed-content). No secure
  // password-collection flow exists in this pass (matching the generic
  // `/api/aie/intake` route's own already-disclosed limitation) and no OCR
  // engine is wired into this repository at all (verified against
  // `lib/financial-data-hub/bank-pdf/ocr.ts` — see `parser.ts`'s header) —
  // both stay quarantined/rejected rather than guessing.
  const classified = await classifyPdf(bytes);
  if (classified.classification !== 'text_native' && classified.classification !== 'mixed_content') {
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: classified.reasonCode });
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: classified.reasonCode, duplicate_classification: duplicateClassification });
  }
  await updateIntakeStatus({ intakeId, toStatus: 'ready' });
  const extractedText = (classified.pages ?? []).join('\n');

  // Account-identity resolution — SAME pure functions FDH-5's own
  // `uploadBankPdf` calls (reused unchanged), run here READ-ONLY so this
  // adapter's own dedup/overlap analysis (below) can be scoped to the
  // correct account BEFORE any commit decision is made. `uploadBankPdf`
  // performs this exact resolution again, idempotently, at actual commit
  // time — this earlier call creates nothing.
  const maskedIdentifier = normaliseMaskedIdentifier(metadata.declared_masked_identifier ?? null);
  const existingAccounts = await loadExistingAccountsForInstitutionCurrency(user.id, metadata.institution_id ?? null, metadata.currency_code);
  const accountDecision = resolveAccountIdentity({
    userId: user.id,
    institutionId: metadata.institution_id ?? null,
    currencyCode: metadata.currency_code,
    maskedIdentifierNormalised: maskedIdentifier,
    existingAccountsForInstitutionAndCurrency: existingAccounts,
  });

  const run = await createRun({ intakeId, userId: user.id, runNumber: 1 });
  if ('error' in run) return bad('could not create extraction run', 500);

  if (accountDecision.outcome === 'ambiguous') {
    // AIE13 binding scope: "PC5 consumes AIE account-holder/ownership...
    // items; no parallel PC5 or FDH-PDF exception truth" — surfaced as an
    // AIE unresolved item directly (never row-extracted at all: there is no
    // account to scope dedup/reconciliation against yet).
    const unresolvedItemIds = await createUnresolvedItems({
      runId: run.id,
      intakeId,
      userId: user.id,
      items: [
        {
          reasonCode: 'account_identity_ambiguous',
          severity: 'blocking',
          displayCandidate: null,
          evidenceRef: { institutionId: metadata.institution_id ?? null, currencyCode: metadata.currency_code },
          permittedActionTypes: ['provide_masked_identifier', 'reject_document'],
        },
      ],
    });
    return ok({ intake_id: intakeId, run_id: run.id, status: 'unresolved', unresolved_item_ids: unresolvedItemIds, duplicate_classification: duplicateClassification });
  }

  // For a brand-new ('create') account there is, by construction, no prior
  // transaction to dedup/overlap against — an empty index/range map is
  // correct, not a placeholder approximation. For 'reuse', both are loaded
  // for real. Either way, the id used below for economic-fingerprint
  // computation during THIS AIE analysis pass may differ from the real
  // account id `uploadBankPdf` creates at commit time for a brand-new
  // account (which does not exist yet) — harmless here because there is
  // nothing yet to compare fingerprints against for a brand-new account,
  // and `commitFdhBankStatementImport` never reuses these AIE-side
  // fingerprints; FDH-5's own commit-time pipeline recomputes them for real.
  const financialAccountId = accountDecision.outcome === 'reuse' ? accountDecision.accountId : `pending:${accountDecision.fingerprint}`;
  const dedupIndex = accountDecision.outcome === 'reuse' ? await loadDedupIndexForAccount(user.id, accountDecision.accountId) : new Map();
  const priorStatementRanges =
    accountDecision.outcome === 'reuse' ? await loadPriorStatementDateRanges(user.id, accountDecision.accountId, run.id) : new Map();

  const parser = createFdhBankStatementParser({
    financialAccountId,
    currencyCode: metadata.currency_code,
    statementUploadId: run.id,
    declaredPeriodStart: metadata.statement_period_start ?? null,
    declaredPeriodEnd: metadata.statement_period_end ?? null,
    dedupIndex,
    priorStatementRanges,
  });

  // `runExtractionPipeline` drives classifier -> masking -> gated AI ->
  // reconciliation using AIE-1.1 core UNCHANGED. It calls `sniffDocument()`
  // internally against the GLOBAL registry, so this per-request parser is
  // consulted directly here instead (see parser.ts's header for why) —
  // matching `sniffDocument`'s own contract exactly (unambiguous/ambiguous/
  // none), just scoped to this one adapter rather than every globally
  // registered one, since a bank-statement intake already knows its own
  // domain.
  const outcome = await runFdhBankStatementPipeline({ run, intakeId, userId: user.id, extractedText, parser });

  // Reachable only when this adapter's reconciliation rule returned
  // pass/pass_with_tolerance for every rule (`blockingItemsForReconciliation`
  // — AIE-1.1 core, unchanged — turns any fail/indeterminate outcome into a
  // blocking unresolved item and stops the run at 'unresolved' before this
  // point). Note this can never be reached on an AMBIGUOUS layout at all:
  // `reconciliation.ts` always reports that case as `indeterminate` (see its
  // own header on why the AI institution-hint candidate can never change
  // this), so an ambiguous statement is always blocked here regardless of
  // whether AI was consulted for a display-only hint.
  let commit: Awaited<ReturnType<typeof commitFdhBankStatementImport>> | null = null;
  if (outcome.finalStatus === 'awaiting_acceptance') {
    commit = await commitFdhBankStatementImport({ userId: user.id, runId: run.id, intakeId, bytes, metadata });
  }

  return ok({
    intake_id: intakeId,
    run_id: run.id,
    status: outcome.finalStatus,
    ai_used: outcome.aiWasUsed,
    institution_hint: extractInstitutionHintForDisplay(outcome.candidates),
    field_count: outcome.candidates.length,
    unresolved_item_ids: outcome.unresolvedItemIds,
    duplicate_classification: duplicateClassification,
    commit,
  });
}

// Calls straight into AIE-1.1 core's `runExtractionPipeline`, unchanged
// except for the disclosed, additive `parserOverride` field it now accepts
// (see `lib/aie/orchestrator.ts`'s own doc comment on `RunPipelineParams`) —
// this route uses it to hand the pipeline a request-scoped, account-aware
// parser instead of relying on the stateless global registry lookup (see
// `parser.ts`'s header for why the row-level parser cannot be a
// process-wide singleton).
async function runFdhBankStatementPipeline(params: {
  run: { id: string };
  intakeId: string;
  userId: string;
  extractedText: string;
  parser: ReturnType<typeof createFdhBankStatementParser>;
}) {
  const deps = createDefaultDeps(gateway);
  return runExtractionPipeline({
    runId: params.run.id,
    intakeId: params.intakeId,
    userId: params.userId,
    extractedText: params.extractedText,
    parserOverride: params.parser,
    reconcile: fdhBankStatementReconciliationRule,
    deps,
  });
}
