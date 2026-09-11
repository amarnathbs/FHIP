import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { isAieDocumentIntakeEnabled, isMissingSignatureScannerAllowed } from '@/lib/aie/featureFlags';
import { DEFAULT_AIE_UPLOAD_LIMITS, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';
import { buildQuarantineStorageKey, uploadToQuarantine } from '@/lib/aie/storage';
import { extractPdfTextLocally } from '@/lib/aie/extraction/textExtraction';
import { createIntake, updateIntakeStatus, recordFingerprint, existingFingerprintHashesForUser, createRun } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { classifyDuplicate } from '@/lib/aie/fingerprint';
import { createDefaultDeps, runExtractionPipeline } from '@/lib/aie/orchestrator';
import { noDomainAdapterReconciliationRule } from '@/lib/aie/reconciliation/types';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { MockAieProvider } from '@/lib/aie/provider/mockAieProvider';
import type { AieSourceModuleHint } from '@/lib/aie/types';

const ALLOWED_MODULE_HINTS: readonly (AieSourceModuleHint | null)[] = ['investment_intelligence', 'fdh_bank', 'other', null];

// A single project-wide mock provider instance. Genuinely no external AI
// provider traffic occurs anywhere in this route — see gateway.ts's kill
// switch (defaults OFF) and this pass's explicit constraint against live
// provider calls. A real provider is a separately-authorised future step.
const gateway = new AieDocumentAiGateway(
  new MockAieProvider({
    respond: () => JSON.stringify({ fields: [] }),
  }),
);

// POST /api/aie/intake?filename=...&source_module_hint=...
// AIE-1.1 architecture steps 1-11 in one server-mediated request (same
// server-mediated-upload pattern as
// app/api/financial-data-hub/bank-pdf/upload/route.ts): the request body IS
// the PDF bytes. This is a diagnostic/DEV harness route for AIE-1.1 itself —
// the real production upload UX (chunked/resumable, progress, etc.) is
// explicitly out of scope for this phase.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isAieDocumentIntakeEnabled()) {
    return bad('AIE document intake is not currently enabled in this environment.', 403);
  }

  const url = new URL(req.url);
  const filename = url.searchParams.get('filename');
  const moduleHintRaw = url.searchParams.get('source_module_hint');
  const moduleHint = (moduleHintRaw || null) as AieSourceModuleHint;
  if (!ALLOWED_MODULE_HINTS.includes(moduleHint)) {
    return bad('invalid source_module_hint', 422);
  }

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = DEFAULT_AIE_UPLOAD_LIMITS.maxBytesByMimeType['application/pdf'];
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > maxBytes) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  // UPL-08: sanitise + length-cap the DISPLAY filename; never derive the
  // internal object identity from it.
  const displayFilename = filename ? filename.replace(/[^\w.\- ]/g, '_').slice(0, 120) : null;

  const rlsClient = await createClient();
  const created = await createIntake(rlsClient, {
    userId: user.id,
    declaredMimeType: 'application/pdf',
    byteSize: bytes.byteLength,
    displayFilename,
    sourceModuleHint: moduleHint,
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
    await recordAieAuditEvent({ intakeId, runId: null, userId: user.id, eventType: 'intake_rejected_admission', actorType: 'system', metadata: { failure_code: admission.failureCode } });
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: admission.failureCode });
  }

  // Fingerprint / duplicate handling (DUP-01..12) BEFORE the bytes leave
  // this request for storage — an exact re-upload still gets its own
  // intake row (never silently merged, DUP-06), but is flagged.
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
  await recordAieAuditEvent({ intakeId, runId: null, userId: user.id, eventType: 'intake_quarantined', actorType: 'system' });

  if (admission.passwordRequired) {
    // No secure password-collection flow exists in this pass (out of
    // scope) — the document stays quarantined, unprocessed, rather than
    // guessing or collecting a password insecurely.
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
    reconcile: noDomainAdapterReconciliationRule,
    deps,
  });

  return ok({
    intake_id: intakeId,
    run_id: run.id,
    status: outcome.finalStatus,
    ai_used: outcome.aiWasUsed,
    field_count: outcome.candidates.length,
    unresolved_item_ids: outcome.unresolvedItemIds,
    duplicate_classification: duplicateClassification,
    sparse_page_count: extraction.sparsePageIndexes.length,
  });
}
