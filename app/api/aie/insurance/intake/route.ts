import { isUserIdInAiePilotCohort } from '@/lib/aie/pilotCohortEmail';
import { bad, ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { isAieDocumentIntakeEnabled, isMissingSignatureScannerAllowed, isAieAiFallbackEnabled } from '@/lib/aie/featureFlags';
import { DEFAULT_AIE_UPLOAD_LIMITS, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';
import { buildQuarantineStorageKey, uploadToQuarantine } from '@/lib/aie/storage';
import { extractPdfTextLocally } from '@/lib/aie/extraction/textExtraction';
import { createIntake, updateIntakeStatus, recordFingerprint, existingFingerprintHashesForUser, createRun } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { finalizeDocumentBinaryAfterRun } from '@/lib/aie/services/purge';
import { reserveConservativeAiCost, settleAiCost } from '@/lib/aie/cost/costAdmission';
import { runAieRealMalwareScanGate } from '@/lib/aie/malware/aieGateAdapter';
import { classifyDuplicate } from '@/lib/aie/fingerprint';
import { createDefaultDeps, runExtractionPipeline } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { createLazyAieAiProvider } from '@/lib/aie/provider/providerFactory';

import { isAieInsuranceAdapterEnabled } from '@/lib/aie/adapters/insurance/featureFlags';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import { registerInsuranceAdapter } from '@/lib/aie/adapters/insurance';
import {
  registerInsuranceAdapterSchema,
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
  AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
} from '@/lib/aie/adapters/insurance/schema';

// LIVE-DEV VERIFICATION FIX (2026-09-12, AIE_1_LIVE_DEV_VERIFICATION_REPORT.md
// pass 2): this used to be a bare `import '@/lib/aie/adapters/insurance';`
// with a comment claiming "side-effecting registration (parser + AI-fallback
// schema)". That claim was FALSE — `lib/aie/adapters/insurance/index.ts`'s
// own header is explicit that "nothing else in this module has side effects
// at import time" and registration only happens via an explicit
// `registerInsuranceAdapter()` call, which every AIE-1.4/1.5 unit test makes
// in its own `beforeAll` but which no application code ever made. The
// defect was invisible to every existing test (each one calls
// `registerInsuranceAdapter()` itself) and only surfaced when this document
// was driven through the real running route against real DEV infrastructure:
// `sniffDocument()` returned `none_matched` for a genuine insurance-shaped
// document, so the deterministic parser never ran, zero field candidates
// were ever produced, and the run could never reach `awaiting_acceptance`.
// Calling the real registration function here (once, at module load, exactly
// the "API route module" call site its own doc comment already anticipated)
// fixes it for real; the previous bare import is removed rather than kept
// alongside it, since a no-op import left in place would silently invite the
// same false "this line already does the job" reading again.
registerInsuranceAdapter();
// AIE-1 closure mission: this adapter's own narrower field-completion
// schema (closed enum: only `policyNameClarification`) must be registered
// before any run can select it via `schemaOverride` below.
registerInsuranceAdapterSchema();

// AIE-1 closure mission: provider selection now goes through the one shared
// factory (`AIE_AI_PROVIDER` env var) instead of a hardcoded mock — see
// `lib/aie/provider/providerFactory.ts`'s header for why this was a real,
// disclosed gap (three routes each independently hardcoded the mock with
// no switch to a real provider anywhere). Still gated by AIE-1.1's global
// kill switch, defaulted OFF, regardless of which provider is selected.
const gateway = new AieDocumentAiGateway(createLazyAieAiProvider(), {
  isKillSwitchEnabled: () => isAieAiFallbackEnabled(),
  costAdmission: { reserve: reserveConservativeAiCost, settle: settleAiCost },
});

// POST /api/aie/insurance/intake?owner=self[&master_item_key=...]
//
// AIE-1.4's Insurance adapter: admission -> quarantine -> local extraction
// (AIE-1.1, reused unchanged) -> this adapter's deterministic parser
// (parser.ts) -> masked AI fallback for the ONE declared gap
// (policyNameClarification) only, gated by AIE-1.1's global kill switch,
// defaulted OFF -> this adapter's reconciliation rule -> AIE unresolved
// items for material failure/ambiguity, OR (gated, OFF by default) the
// SAME canonical write `app/api/insurance/route.ts`'s manual-entry POST
// handler performs (`insuranceSchema` + `makeRegistry('insurance_policies')`).
//
// This is additive: the existing manual-entry
// `POST /api/insurance` route is completely unmodified and unaffected by
// this file's existence either way. There is no review/acceptance UI yet
// (explicitly AIE-1.5's job) — this route self-accepts using the SAME
// authenticated user as the uploader, matching AIE-1.2/1.3's own identical,
// disclosed placeholder for "required user acceptance".
export async function POST(req: Request) {
  const { user, blocked } = await requireModuleCapability('INSURANCE', req);
  if (!user) return blocked!;

  if (!isAieInsuranceAdapterEnabled()) {
    return bad('The AIE-fronted Insurance adapter is not currently enabled in this environment.', 403);
  }
  if (!isAieDocumentIntakeEnabled()) {
    return bad('AIE document intake is not currently enabled in this environment.', 403);
  }
  // `requireModuleCapability`'s declared return type narrows `user` to
  // `{ id: string }` only (no `.email`) -- userId-based cohort membership
  // alone is checked here; an operator using the email-allowlist form of
  // AIE_PILOT_COHORT_EMAILS should list this route's callers by user id
  // instead, or this route's own capability layer can be extended to
  // surface email if that becomes a real operational need.
  // AIE-1 final completion (2026-09-25): the email is now resolved server-side
  // (lib/aie/pilotCohortEmail.ts), so an email-only allowlist admits correctly.
  if (!(await isUserIdInAiePilotCohort(user.id))) {
    return bad('AIE is currently limited to an allowlisted pilot cohort.', 403);
  }

  // AIE-1.5 note: this route used to also parse `owner`/`master_item_key`
  // query params here, purely to feed its own since-removed self-accept
  // call (see below). Household-role ownership and any amendment-lineage
  // key are now supplied by the CALLER OF ACCEPTANCE
  // (`POST /api/aie/review/runs/{runId}/accept`'s request body), matching
  // the real manual-entry form's own timing (a user picks "whose policy is
  // this" at the moment they confirm the save, not at upload time) — so
  // this route no longer needs either param.
  const url = new URL(req.url);
  const filename = url.searchParams.get('filename');

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = DEFAULT_AIE_UPLOAD_LIMITS.maxBytesByMimeType['application/pdf'];
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > maxBytes) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  const displayFilename = filename ? filename.replace(/[^\w.\- ]/g, '_').slice(0, 120) : null;

  const rlsClient = await createClient();
  const created = await createIntake(rlsClient, {
    userId: user.id,
    declaredMimeType: 'application/pdf',
    byteSize: bytes.byteLength,
    displayFilename,
    sourceModuleHint: 'other',
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

  // Real-malware-gate wiring (2026-09-21): shipped disabled — see
  // lib/aie/malware/aieGateAdapter.ts's header.
  const malwareGate = await runAieRealMalwareScanGate({ intakeId, userId: user.id, bytes, contentHash: admission.fileHash });
  if (!malwareGate.proceed) {
    if (malwareGate.outcome === 'pending_scan') {
      return ok({ intake_id: intakeId, status: 'quarantined', malware_scan_status: 'pending', duplicate_classification: duplicateClassification });
    }
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: malwareGate.failureCode, duplicate_classification: duplicateClassification });
  }

  if (admission.passwordRequired) {
    return ok({ intake_id: intakeId, status: 'quarantined', password_required: true, duplicate_classification: duplicateClassification });
  }

  await updateIntakeStatus({ intakeId, toStatus: 'ready' });

  const extraction = await extractPdfTextLocally(bytes);
  if (!extraction.ok) {
    await updateIntakeStatus({ intakeId, toStatus: 'rejected', rejectionReason: extraction.kind });
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: extraction.kind, duplicate_classification: duplicateClassification });
  }

  const run = await createRun({ intakeId, userId: user.id, runNumber: 1 });
  if ('error' in run) return bad('could not create extraction run', 500);

  const deps = createDefaultDeps(gateway);
  const outcome = await runExtractionPipeline({
    runId: run.id,
    intakeId,
    userId: user.id,
    extractedText: extraction.concatenatedText,
    reconcile: buildInsuranceReconciliationRule(),
    deps,
    schemaOverride: {
      schemaName: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_NAME,
      schemaVersion: AIE_INSURANCE_ADAPTER_FIELD_COMPLETION_SCHEMA_VERSION,
    },
  });

  // AIE-1 closure mission (section 4.1): Insurance's canonical write never
  // touches storage (`insurance/write.ts` has no download/storage import at
  // all — it writes typed fields only) — so, unlike Investment Intelligence
  // and FDH-bank (whose accept-time writes need the original bytes; see
  // `lib/aie/review/accept.ts`'s `finalizeDocumentBinary` doc comment), the
  // AIE quarantine copy is safe to delete now, immediately, rather than
  // waiting for a later, separate acceptance request. `runExtractionPipeline`
  // only ever returns `privacy_blocked`/`unresolved`/`awaiting_acceptance`
  // here — never a state that still needs the binary — and structured
  // candidates/reconciliation results are already durably persisted by this
  // point. A failure here is non-fatal; the scheduled sweep is the backstop.
  await finalizeDocumentBinaryAfterRun({ intakeId, userId: user.id, storageKey });

  // AIE-1.5 SUPERSEDES THE SELF-ACCEPT THIS ROUTE USED TO PERFORM HERE.
  //
  // AIE-1.4's own comment above this route (see the module header) called
  // the previous auto-write "the SAME authenticated user as the uploader,
  // matching AIE-1.2/1.3's own identical, disclosed placeholder for
  // 'required user acceptance' [because] there is no review/acceptance UI
  // yet — explicitly AIE-1.5's job." That UI now exists
  // (`POST /api/aie/review/runs/{runId}/accept`,
  // `lib/aie/review/accept.ts`) and is the real, gated, versioned,
  // idempotent acceptance path AIE-1.5 section 20 requires — silently
  // auto-writing the moment extraction reaches `awaiting_acceptance` would
  // be exactly the "no explicit user acceptance" / "no accept-anyway"
  // violation AIE-1.5's own non-negotiable prohibitions forbid, even though
  // the write itself only ever fired on a genuine pass outcome. This route
  // now stops at reporting the outcome; the caller (the AIE-1.5 review UI)
  // decides whether/when to call the accept endpoint, and does so with a
  // server-re-verified reconciliation outcome and a fresh blocking-item
  // count rather than the values this one request happened to compute.
  return ok({
    intake_id: intakeId,
    run_id: run.id,
    status: outcome.finalStatus,
    ai_used: outcome.aiWasUsed,
    field_count: outcome.candidates.length,
    unresolved_item_ids: outcome.unresolvedItemIds,
    duplicate_classification: duplicateClassification,
  });
}
