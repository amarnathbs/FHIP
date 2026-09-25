import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieDocumentIntakeEnabled, isAieAiFallbackEnabled, isUserInAiePilotCohort } from '@/lib/aie/featureFlags';
import { isAieIiAdapterEnabled } from '@/lib/aie/adapters/investment-intelligence/featureFlags';
import { getIntakeForUser, listAuditEventsForIntake, updateIntakeStatus } from '@/lib/aie/db/repository';
import { recordAieAuditEvent } from '@/lib/aie/audit';
import { getMalwareScanState } from '@/lib/aie/malware/scanStateRepository';
import { isRealScanAdmissible } from '@/lib/aie/malware/realScanGate';
import { checkPasswordAttemptRateLimit } from '@/lib/financial-data-hub/bank-pdf/password';
import { createDefaultDeps } from '@/lib/aie/orchestrator';
import { AieDocumentAiGateway } from '@/lib/aie/provider/gateway';
import { createAieAiProvider } from '@/lib/aie/provider/providerFactory';
import { reserveConservativeAiCost, settleAiCost } from '@/lib/aie/cost/costAdmission';
import { dispatchInvestmentDocument } from '@/lib/aie/adapters/investment-intelligence/dispatch';
import { resolveHouseholdCountryForUser, UnresolvedHouseholdCountryError } from '@/lib/aie/adapters/investment-intelligence/householdContext';

/**
 * M3 (Phase 4) — `POST /api/aie/investment-intelligence/intake/{intakeId}/process`
 *
 * Resumes processing for a quarantined Investment Intelligence document,
 * optionally supplying the password for an encrypted statement.
 *
 * WHY THIS IS A SECOND ENDPOINT RATHER THAN A PARAMETER ON THE FIRST.
 * M2's H.11 verdict recorded, correctly, that AIE's password capability was
 * unreachable and explained why: "AIE intake is a raw-body byte upload with
 * the filename in the query string, so a password cannot be added to the
 * existing request shape — it needs either a second endpoint or a body/header
 * redesign. That is a new authenticated API surface carrying a secret, and it
 * should be designed and reviewed rather than bolted on." This is that second
 * endpoint, designed to the constraints M2 itself named, and it follows the
 * repository's ONE existing rate-limited precedent
 * (`app/api/financial-data-hub/bank-pdf/[documentId]/process/route.ts`)
 * rather than inventing a new convention:
 *
 *   - the password travels in the JSON BODY of a POST, never in a URL, a
 *     query string or a header, so it cannot land in an access log, a
 *     referrer, browser history or an analytics event;
 *   - it is read into one local, passed once to the decrypt attempt, and
 *     never assigned anywhere that outlives this handler — no database
 *     column, no audit metadata, no response field, no error message;
 *   - the response never echoes it, and the failure path returns a typed
 *     reason rather than anything derived from the attempted value.
 *
 * RATE LIMITING — CLOSING M2-OPEN-8 FOR THIS SURFACE. M2 recorded that the
 * EXISTING Investment Intelligence password endpoint has no rate limiting at
 * all, unlike FDH-5, and called it "a real brute-force exposure on an
 * authenticated endpoint". This new endpoint does not repeat that: it reuses
 * FDH-5's own certified `checkPasswordAttemptRateLimit` decision function
 * unchanged, fed from AIE's own audit trail. The attempt is recorded BEFORE
 * the decrypt is tried, so a crash mid-attempt cannot be used to obtain a
 * free guess. (M2-OPEN-8 itself stays open for the pre-existing
 * `app/api/investment-intelligence/source-documents/[id]/process` route,
 * which is outside M3's scope and is not touched here.)
 */

const gateway = new AieDocumentAiGateway(createAieAiProvider(), {
  isKillSwitchEnabled: () => isAieAiFallbackEnabled(),
  costAdmission: { reserve: reserveConservativeAiCost, settle: settleAiCost },
});

export async function POST(req: Request, { params }: { params: Promise<{ intakeId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  if (!isAieIiAdapterEnabled()) return bad('The AIE-fronted Investment Intelligence adapter is not currently enabled in this environment.', 403);
  if (!isAieDocumentIntakeEnabled()) return bad('AIE document intake is not currently enabled in this environment.', 403);
  if (!isUserInAiePilotCohort({ userId: user.id, email: user.email })) return bad('AIE is currently limited to an allowlisted pilot cohort.', 403);

  const { intakeId } = await params;

  let body: { password?: unknown; owner_member_id?: unknown };
  try {
    body = await req.json();
  } catch {
    // An empty body is legitimate — this endpoint also resumes a document
    // that simply was not processed yet and needs no password.
    body = {};
  }
  const password = typeof body.password === 'string' && body.password.length > 0 ? body.password : undefined;
  const ownerMemberId = typeof body.owner_member_id === 'string' && body.owner_member_id.length > 0 ? body.owner_member_id : null;

  // Ownership is checked by the query itself, not by comparing a returned
  // user_id — a guessed intake id belonging to someone else is simply "not
  // found", giving no existence oracle.
  const intake = await getIntakeForUser(intakeId, user.id);
  if (!intake) return bad('not found', 404);
  if (!intake.storageKey) return bad('this document has no stored object to process', 409, 'no_stored_object');
  if (intake.status !== 'quarantined') {
    // `ready`/`deleted`/`rejected` all mean this endpoint has nothing to do.
    // Refusing loudly is better than re-running a pipeline over a document
    // that already has a run, which would create a second run for one
    // document and break the one-run-per-intake assumption acceptance relies
    // on.
    return bad(`this document is not awaiting processing (status: ${intake.status})`, 409, 'not_awaiting_processing');
  }

  // AIE-1 final completion (2026-09-25). DEFECT: the intake route leaves a
  // document whose real scan is still PENDING in `quarantined` -- the same
  // status this route treats as "ready to process" -- and nothing here looked
  // at the scan, so the II pipeline read and parsed bytes GuardDuty had not
  // cleared (or had blocked, if the sweep later decided it). Only a clean
  // verdict (or the scan switched off entirely) is admitted now; a pending
  // scan is a retryable 409, never processing.
  const scan = await getMalwareScanState('aie_document_intake', intakeId);
  if (!isRealScanAdmissible(scan?.status)) {
    if (scan?.status === 'pending') {
      return bad('This document is still being scanned for safety. Please try again in a moment.', 409, 'malware_scan_pending');
    }
    return bad('This file could not be cleared by our security scan, so it cannot be processed.', 422, 'malware_scan_blocked');
  }

  if (password !== undefined) {
    const priorAttempts = await listAuditEventsForIntake({ intakeId, eventType: 'aie_pdf_password_attempt' });
    // FDH-5's decision function counts events named `pdf_password_required`.
    // The mapping below feeds AIE's own event stream into that unchanged,
    // certified logic rather than reimplementing the rolling-window count —
    // the bound (8 per document per hour) therefore stays defined in exactly
    // one place in this codebase.
    const rateLimit = checkPasswordAttemptRateLimit({
      recentAuditEvents: priorAttempts.map((e) => ({ event_type: 'pdf_password_required', created_at: e.created_at })),
      nowIso: new Date().toISOString(),
    });
    if (!rateLimit.allowed) {
      await recordAieAuditEvent({
        intakeId,
        runId: null,
        userId: user.id,
        eventType: 'aie_pdf_password_rate_limited',
        actorType: 'system',
        metadata: { attempts_in_window: rateLimit.attemptsInWindow },
      });
      return bad('Too many password attempts for this document. Please try again later.', 429, 'password_rate_limited');
    }
    // Recorded BEFORE the decrypt attempt, deliberately: an attempt that
    // crashes or times out must still count, or a caller could obtain
    // unlimited free guesses by aborting each request. Metadata carries no
    // information about the value attempted.
    await recordAieAuditEvent({ intakeId, runId: null, userId: user.id, eventType: 'aie_pdf_password_attempt', actorType: 'user', actorId: user.id });
  }

  let countryCode: string;
  try {
    countryCode = await resolveHouseholdCountryForUser(user.id);
  } catch (err) {
    if (err instanceof UnresolvedHouseholdCountryError) {
      return bad('Your home country is not set yet, so this statement cannot be attributed to a jurisdiction.', 409, 'home_country_unresolved');
    }
    throw err;
  }

  // The intake moves to `ready` only once there is a genuine attempt to
  // process it, and only from `quarantined` — `updateIntakeStatus` enforces
  // the edge and does a compare-and-swap, so two concurrent unlock requests
  // cannot both proceed to create a run.
  const admitted = await updateIntakeStatus({ intakeId, toStatus: 'ready', expectedFromStatus: 'quarantined' });
  if (!admitted.ok) {
    return bad('this document is already being processed', 409, admitted.code);
  }

  const outcome = await dispatchInvestmentDocument({
    intakeId,
    userId: user.id,
    storageKey: intake.storageKey,
    countryCode,
    ownerMemberId,
    password,
    deps: createDefaultDeps(gateway),
  });

  if (!outcome.ok) {
    if (outcome.reason === 'password_required' || outcome.reason === 'wrong_password') {
      // Put the document back in quarantine so the user can try again. The
      // response distinguishes the two cases by TYPE — never by
      // string-matching an error message — preserving PC4-INV-17's own
      // classification discipline on this new surface.
      await updateIntakeStatus({ intakeId, toStatus: 'quarantined', expectedFromStatus: 'ready' });
      return bad(
        outcome.reason === 'wrong_password' ? 'The password did not open this document.' : 'This document is password-protected.',
        422,
        outcome.reason,
      );
    }
    return ok({ intake_id: intakeId, status: 'rejected', failure_code: outcome.reason });
  }

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
  });
}
