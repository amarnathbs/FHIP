import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { isAieDocumentIntakeEnabled, isMissingSignatureScannerAllowed, isUserInAiePilotCohort } from '@/lib/aie/featureFlags';
import { isAieIiAdapterEnabled } from '@/lib/aie/adapters/investment-intelligence/featureFlags';
import { DEFAULT_AIE_UPLOAD_LIMITS, validateUploadForAdmission } from '@/lib/aie/validation/fileValidation';
import { buildQuarantineStorageKey, uploadToQuarantine } from '@/lib/aie/storage';
import { createIntake, updateIntakeStatus, recordFingerprint, existingFingerprintHashesForUser } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { classifyDuplicate } from '@/lib/aie/fingerprint';
import { dispatchInvestmentDocument } from '@/lib/aie/adapters/investment-intelligence/dispatch';
import { resolveHouseholdCountryForUser, UnresolvedHouseholdCountryError } from '@/lib/aie/adapters/investment-intelligence/householdContext';
import { createDefaultDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { isAieAiFallbackEnabled } from '@/lib/aie/featureFlags';
import { reserveConservativeAiCost, settleAiCost } from '@/lib/aie/cost/costAdmission';

// One shared gateway per process, matching the other AIE intake routes. The
// provider is constructed HERE, in the route, not inside the adapter —
// AIE-1.2's prohibition P2 forbids any file under
// `lib/aie/adapters/investment-intelligence/` from importing a provider or
// provider-selection module, and `tests/unit/aieIiAdapterProhibitions.test.ts`
// enforces it. The kill switch defaults OFF, so no AI fallback can fire
// unless an operator has explicitly enabled it.
const gateway = new AieDocumentAiGateway(createAieAiProvider(), {
  isKillSwitchEnabled: () => isAieAiFallbackEnabled(),
  costAdmission: { reserve: reserveConservativeAiCost, settle: settleAiCost },
});

/**
 * M3 (Phase 4), item I.1 — THE REAL AUTHENTICATED INVESTMENT INTELLIGENCE
 * DISPATCH ROUTE.
 *
 * `POST /api/aie/investment-intelligence/intake?filename=...`
 * Request body IS the PDF bytes (same server-mediated-upload shape as the
 * three existing AIE intake routes and FDH-5's own bank-pdf upload).
 *
 * WHY A DEDICATED ROUTE RATHER THAN A FLAG ON THE GENERIC ONE. The generic
 * `/api/aie/intake` route takes a `source_module_hint` query parameter, and
 * M0 recorded — correctly — that this is caller metadata and nothing more:
 * that route runs `noDomainAdapterReconciliationRule` regardless of the
 * hint, registers no domain adapter, and therefore can never reach an
 * investment parser. The dispatch is explicit that
 * `source_module_hint=investment_intelligence` must not be treated as
 * dispatch. Widening the generic route to branch on the hint would have made
 * a metadata field load-bearing for routing, which is the same mistake in a
 * new place; `accept.ts` already made the opposite choice deliberately,
 * dispatching on the run's recorded `adapter_id` and never on the hint.
 *
 * THE HINT IS STILL RECORDED, and still is not authority: `createIntake`
 * below stores `source_module_hint: 'investment_intelligence'` because it is
 * true and useful for querying, while the actual adapter binding comes from
 * the deterministic parser that claims the document and is written to
 * `aie_parser_attempt.adapter_id` — the one fact `accept.ts` dispatches on.
 *
 * NO CANONICAL WRITE HAPPENS HERE (I.9, and M2-OPEN-6's anti-pattern). See
 * `dispatch.ts`'s header. This route stops at reporting the extraction
 * outcome; `POST /api/aie/review/runs/{runId}/accept` is the only path to a
 * canonical Investment Intelligence row.
 */
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  // Three independent gates, all defaulting OFF, checked before a single byte
  // is read: the adapter's own switch, AIE's master intake switch, and the
  // pilot cohort. Matching the Insurance route's ordering so an operator sees
  // the most specific refusal first.
  if (!isAieIiAdapterEnabled()) {
    return bad('The AIE-fronted Investment Intelligence adapter is not currently enabled in this environment.', 403);
  }
  if (!isAieDocumentIntakeEnabled()) {
    return bad('AIE document intake is not currently enabled in this environment.', 403);
  }
  if (!isUserInAiePilotCohort({ userId: user.id, email: user.email })) {
    return bad('AIE is currently limited to an allowlisted pilot cohort.', 403);
  }

  const url = new URL(req.url);
  const filename = url.searchParams.get('filename');
  const ownerMemberIdParam = url.searchParams.get('owner_member_id');

  const contentLength = Number(req.headers.get('content-length') ?? '0');
  const maxBytes = DEFAULT_AIE_UPLOAD_LIMITS.maxBytesByMimeType['application/pdf'];
  if (!contentLength || contentLength <= 0) return bad('File upload incomplete.', 422);
  if (contentLength > maxBytes) return bad('File too large.', 413);

  const arrayBuffer = await req.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.byteLength === 0) return bad('File upload incomplete.', 422);

  // UPL-08: the display filename is sanitised and length-capped, and is NEVER
  // the internal object identity — that is `buildQuarantineStorageKey`'s
  // UUID-derived key. This is item I.2's requirement at the storage layer:
  // two uploads of the same filename with different bytes get two distinct,
  // non-colliding objects and two distinct intake rows.
  const displayFilename = filename ? filename.replace(/[^\w.\- ]/g, '_').slice(0, 120) : null;

  const rlsClient = await createClient();
  const created = await createIntake(rlsClient, {
    userId: user.id,
    declaredMimeType: 'application/pdf',
    byteSize: bytes.byteLength,
    displayFilename,
    sourceModuleHint: 'investment_intelligence',
  });
  if ('error' in created) return bad('could not create intake', 500);
  const intakeId = created.id;
  await recordAieAuditEvent({ intakeId, runId: null, userId: user.id, eventType: 'intake_created', actorType: 'user', actorId: user.id });

  // --- Admission / quarantine gate ---------------------------------------
  // The real scan this application has today: declared-vs-detected MIME,
  // size, structural checks and signature-scanner availability, all failing
  // CLOSED. It is NOT malware scanning; see `dispatch.ts`'s header for why
  // S3 + GuardDuty remains blocked infrastructure rather than something this
  // route quietly claims.
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

  // DUP-06: an exact re-upload still gets its OWN intake row and is never
  // silently merged — it is classified and reported. Item I.2's "same user,
  // same filename, different bytes" case separates here on the content hash.
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
    // The document stays quarantined and unprocessed. Unlike the three
    // pre-M3 routes, this is no longer a dead end: the caller supplies the
    // password to the companion `process` route, which resumes from the
    // SAME quarantined bytes. See that route for the security properties.
    return ok({
      intake_id: intakeId,
      status: 'quarantined',
      password_required: true,
      duplicate_classification: duplicateClassification,
      next: `/api/aie/investment-intelligence/intake/${intakeId}/process`,
    });
  }

  // Jurisdiction comes from the authenticated profile and FAILS CLOSED —
  // never from the document's own origin. See `householdContext.ts` for why
  // "a CAMS statement means IN" is wrong even though it is true of every
  // fixture. Resolved BEFORE admitting the document to `ready`, so an
  // unresolvable country leaves the intake quarantined and retryable rather
  // than stranded mid-pipeline.
  let country: string;
  try {
    country = await resolveHouseholdCountryForUser(user.id);
  } catch (err) {
    if (err instanceof UnresolvedHouseholdCountryError) {
      return bad('Your home country is not set yet, so this statement cannot be attributed to a jurisdiction.', 409, 'home_country_unresolved');
    }
    throw err;
  }

  await updateIntakeStatus({ intakeId, toStatus: 'ready' });

  const outcome = await dispatchInvestmentDocument({
    intakeId,
    userId: user.id,
    storageKey,
    countryCode: country,
    ownerMemberId: ownerMemberIdParam,
    deps: createDefaultDeps(gateway),
  });

  if (!outcome.ok) {
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: outcome.reason, duplicate_classification: duplicateClassification });
  }

  // NOTE the deliberate absence of a `finalizeDocumentBinaryAfterRun` call
  // here, unlike the generic and Insurance routes. Investment Intelligence's
  // canonical write re-fetches the ORIGINAL bytes from quarantine at ACCEPT
  // time (`write.ts` -> `downloadFromQuarantine`), so deleting them now would
  // break acceptance outright. `accept.ts` deletes them immediately after the
  // write succeeds, and the 24-hour hard backstop
  // (`enforceAieRawFileHardBackstop`) catches an abandoned document that is
  // never accepted. This is item I.10's "retained only as long as required"
  // applied honestly rather than by deleting early and breaking the journey.
  return ok({
    intake_id: intakeId,
    run_id: outcome.runId,
    status: outcome.finalStatus,
    ai_used: outcome.aiWasUsed,
    field_count: outcome.candidateCount,
    unresolved_item_ids: outcome.unresolvedItemIds,
    parser_code: outcome.parserCode,
    document_class: outcome.documentClass,
    certified_document_class: outcome.certifiedDocumentClass,
    duplicate_classification: duplicateClassification,
  });
}
