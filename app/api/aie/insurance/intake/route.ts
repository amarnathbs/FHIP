import { bad, ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { isAieDocumentIntakeEnabled, isMissingSignatureScannerAllowed, isAieAiFallbackEnabled } from '@/lib/aie/featureFlags';
import { DEFAULT_AIE_UPLOAD_LIMITS, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';
import { buildQuarantineStorageKey, uploadToQuarantine } from '@/lib/aie/storage';
import { extractPdfTextLocally } from '@/lib/aie/extraction/textExtraction';
import { createIntake, updateIntakeStatus, recordFingerprint, existingFingerprintHashesForUser, createRun } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { classifyDuplicate } from '@/lib/aie/fingerprint';
import { createDefaultDeps, runExtractionPipeline } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';

import { isAieInsuranceAdapterEnabled } from '@/lib/aie/adapters/insurance/featureFlags';
import { buildInsuranceReconciliationRule } from '@/lib/aie/adapters/insurance/reconciliation';
import '@/lib/aie/adapters/insurance'; // side-effecting registration (parser + AI-fallback schema)

// A single project-wide mock provider instance — genuinely no external AI
// provider traffic occurs anywhere in this route (matches the generic
// `/api/aie/intake` and AIE-1.3 `fdh-bank/intake` routes' own disclosed
// constraint). Gated by AIE-1.1's global kill switch, defaulted OFF.
const gateway = new AieDocumentAiGateway(new MockAieProvider({ respond: () => JSON.stringify({ fields: [] }) }), {
  isKillSwitchEnabled: () => isAieAiFallbackEnabled(),
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
  });

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
