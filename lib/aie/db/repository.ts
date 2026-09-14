/**
 * AIE-1.1 — persistence layer.
 *
 * Every function here uses the service-role client, matching
 * `lib/financial-data-hub/services/storage.ts` / `services/auditLog.ts`'s
 * own discipline: "every exported function here assumes the caller has
 * ALREADY verified, using the normal RLS-scoped client and the
 * authenticated session, that the acting user owns the record in
 * question." The one exception is `createIntake`, which is written through
 * the RLS-scoped client the caller passes in (matching
 * `aie_document_intake`'s own authenticated INSERT policy in migration
 * 0140) — intake creation does not need a privileged credential.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AieInvalidTransitionError, assertRunTransition, isAllowedIntakeTransition } from '../stateMachine';
import type { AieAuditEventType as AieAuditEventTypeName } from '../audit';
import type {
  AieActorType,
  AieAiOutcome,
  AieDeterministicOutcome,
  AieFieldCandidate,
  AieIntakeStatus,
  AieItemSeverity,
  AieReconciliationOutcome,
  AieReconciliationRunResult,
  AieRunStatus,
  AieSourceModuleHint,
  AieUnresolvedItemInput,
  AieUnresolvedItemStatus,
} from '../types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySupabaseClient = SupabaseClient<any, any, any>;

export async function createIntake(
  rlsClient: AnySupabaseClient,
  params: {
    userId: string;
    declaredMimeType: string;
    byteSize: number;
    displayFilename: string | null;
    sourceModuleHint: AieSourceModuleHint;
  },
): Promise<{ id: string } | { error: string }> {
  const { data, error } = await rlsClient
    .from('aie_document_intake')
    .insert({
      user_id: params.userId,
      declared_mime_type: params.declaredMimeType,
      byte_size: params.byteSize,
      display_filename: params.displayFilename,
      source_module_hint: params.sourceModuleHint,
      status: 'received',
    })
    .select('id')
    .single();
  if (error || !data) return { error: error?.message ?? 'insert failed' };
  return { id: data.id as string };
}

export type UpdateIntakeStatusFailureCode =
  | 'not_found'
  | 'invalid_transition'
  | 'stale_conflict'
  | 'write_failed';

/**
 * M2 (H.1) — this function now ENFORCES the intake state machine.
 *
 * WHAT WAS WRONG. Before M2 this was an unvalidated write primitive: it took
 * no `from` status, called no `assertIntakeTransition`, and performed no
 * compare-and-swap. Because it is the ONLY way any product code changes an
 * intake status, the consequence was that `assertIntakeTransition` — and
 * therefore `AIE_INTAKE_TRANSITIONS`, the declared intake FSM — had **zero
 * production callers**. The FSM was declared, unit-tested, and documented as
 * enforced (see `lib/aie/review/reject.ts`'s own header, which asserted the
 * vocabulary was "honoured exactly as `assertIntakeTransition` enforces it")
 * while in reality nothing enforced it at runtime. Only the DB CHECK
 * constraint applied, and a CHECK constrains the VOCABULARY, never the
 * TRANSITIONS — exactly the division of labour this module's own header
 * describes. An illegal edge was consequently being taken in production
 * (`ready -> rejected`, from both `app/api/aie/intake/route.ts` and
 * `app/api/aie/insurance/intake/route.ts`) and succeeding silently.
 *
 * WHAT IT DOES NOW. Reads the current status, validates the edge against
 * `AIE_INTAKE_TRANSITIONS`, then writes under a compare-and-swap on that
 * same status so a concurrent writer cannot interleave between the check and
 * the write. Failures are TYPED rather than collapsed into a bare message,
 * so a caller can distinguish "this edge is illegal" (a bug) from "someone
 * else moved this row first" (a race) from "the write itself failed".
 *
 * IDEMPOTENCE. A no-op write (`toStatus` already equal to the current
 * status) returns `ok` WITHOUT writing and without consulting the FSM. This
 * is deliberate: no state machine lists a state as its own successor, so a
 * retried request that had already applied its transition would otherwise be
 * reported as an illegal edge. Re-applying a transition that already
 * happened is not an FSM violation, it is a duplicate delivery.
 */
export async function updateIntakeStatus(params: {
  intakeId: string;
  toStatus: AieIntakeStatus;
  storageKey?: string;
  detectedMimeType?: string;
  rejectionReason?: string;
  /** Optional explicit CAS guard. When supplied, the update is refused as
   * `stale_conflict` unless the row is in exactly this status — for callers
   * that know which state they believe they are transitioning out of. */
  expectedFromStatus?: AieIntakeStatus;
}): Promise<{ ok: true } | { ok: false; message: string; code: UpdateIntakeStatusFailureCode }> {
  const admin = createAdminClient();

  const { data: current, error: readError } = await admin
    .from('aie_document_intake')
    .select('status')
    .eq('id', params.intakeId)
    .maybeSingle();
  if (readError) return { ok: false, message: readError.message, code: 'write_failed' };
  if (!current) return { ok: false, message: 'intake not found', code: 'not_found' };

  const fromStatus = current.status as AieIntakeStatus;

  if (params.expectedFromStatus !== undefined && params.expectedFromStatus !== fromStatus) {
    return {
      ok: false,
      message: `expected intake to be ${params.expectedFromStatus} but it is ${fromStatus}`,
      code: 'stale_conflict',
    };
  }

  // Duplicate delivery, not a transition -- see IDEMPOTENCE above.
  if (fromStatus === params.toStatus) return { ok: true };

  if (!isAllowedIntakeTransition(fromStatus, params.toStatus)) {
    return {
      ok: false,
      message: new AieInvalidTransitionError(fromStatus, params.toStatus, 'aie intake lifecycle').message,
      code: 'invalid_transition',
    };
  }

  const patch: Record<string, unknown> = { status: params.toStatus, updated_at: new Date().toISOString() };
  if (params.storageKey !== undefined) patch.storage_key = params.storageKey;
  if (params.detectedMimeType !== undefined) patch.detected_mime_type = params.detectedMimeType;
  if (params.rejectionReason !== undefined) patch.rejection_reason = params.rejectionReason;

  // CAS on the status we validated against -- a concurrent writer that moved
  // the row after our read loses this write rather than silently overwriting
  // a state we never checked the edge from.
  const { data: updated, error } = await admin
    .from('aie_document_intake')
    .update(patch)
    .eq('id', params.intakeId)
    .eq('status', fromStatus)
    .select('id');
  if (error) return { ok: false, message: error.message, code: 'write_failed' };
  if (!updated || updated.length === 0) {
    return { ok: false, message: 'intake status changed concurrently', code: 'stale_conflict' };
  }
  return { ok: true };
}

/**
 * AIE-1.3 (FDH bank-statement adapter) only — migration 0145. Persists the
 * caller-supplied `BankCsvUploadMetadataInput` (country_code, currency_code,
 * institution_id?, declared_masked_identifier?, statement_period_start?,
 * statement_period_end?, original_filename_sanitised?) captured at intake
 * time (`app/api/aie/fdh-bank/intake/route.ts`, after its own
 * `bankCsvUploadMetadataSchema.safeParse`), so accept.ts's centralized
 * acceptance gate can re-read it in a LATER request. Deliberately typed as
 * `Record<string, unknown>` here (not `BankCsvUploadMetadataInput`) so
 * AIE-1.1's core persistence layer stays domain-agnostic — the FDH-specific
 * shape is validated at the point of use (route.ts on write, accept.ts's
 * FDH-bank dispatch on read), matching this file's own existing precedent
 * of `targetModule` carrying adapter-specific string values without
 * importing each adapter's own types.
 */
export async function recordFdhBankUploadMetadata(intakeId: string, metadata: Record<string, unknown>): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_document_intake').update({ fdh_bank_upload_metadata: metadata, updated_at: new Date().toISOString() }).eq('id', intakeId);
}

export async function getFdhBankUploadMetadata(intakeId: string): Promise<Record<string, unknown> | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_intake').select('fdh_bank_upload_metadata').eq('id', intakeId).maybeSingle();
  return (data?.fdh_bank_upload_metadata as Record<string, unknown> | null) ?? null;
}

/**
 * Idempotency guard for the FDH-bank accept-time dispatch specifically
 * (see `lib/aie/review/accept.ts`'s own header for why this adapter needs
 * one that Insurance's/Investment Intelligence's own `findExistingLink`
 * checks don't have to provide separately): unlike those two adapters'
 * write.ts files, `commitFdhBankStatementImport()`
 * (`lib/aie/adapters/fdhBankStatement/atomicImport.ts`) has no existing-
 * write check of its OWN before calling FDH-5's `uploadBankPdf` — it relies
 * entirely on its caller never invoking it twice for the same run. Reuses
 * the SAME `aie_write_batch` row that function's own `recordWriteBatch`
 * helper already writes (`target_module: 'fdh_bank'`,
 * `canonical_reference_id` set to the real `fdh_statement_uploads.id` on
 * success) — no new table, no new column beyond what AIE-1.1 core already
 * has for exactly this purpose.
 */
export async function findCommittedFdhBankWriteForRun(runId: string): Promise<{ canonicalReferenceId: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_write_batch')
    .select('canonical_reference_id')
    .eq('run_id', runId)
    .eq('target_module', 'fdh_bank')
    .eq('status', 'committed')
    .maybeSingle();
  if (!data) return null;
  return { canonicalReferenceId: (data.canonical_reference_id as string | null) ?? null };
}

export async function recordFingerprint(params: {
  intakeId: string;
  userId: string;
  exactSha256: string;
  normalizedHash?: string | null;
}): Promise<{ ok: true; duplicate: boolean } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const { error } = await admin.from('aie_document_fingerprint').insert({
    intake_id: params.intakeId,
    user_id: params.userId,
    exact_sha256: params.exactSha256,
    normalized_hash: params.normalizedHash ?? null,
  });
  if (error) {
    // Postgres unique_violation
    if (error.code === '23505') return { ok: true, duplicate: true };
    return { ok: false, message: error.message };
  }
  return { ok: true, duplicate: false };
}

export async function existingFingerprintHashesForUser(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_fingerprint').select('exact_sha256').eq('user_id', userId);
  return (data ?? []).map((r: { exact_sha256: string }) => r.exact_sha256);
}

export async function createRun(params: { intakeId: string; userId: string; runNumber: number }): Promise<{ id: string } | { error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('aie_extraction_run')
    .insert({ intake_id: params.intakeId, user_id: params.userId, run_number: params.runNumber, status: 'local_extracting' })
    .select('id')
    .single();
  if (error || !data) return { error: error?.message ?? 'insert failed' };
  return { id: data.id as string };
}

export async function recordTransition(params: {
  runId: string;
  intakeId: string;
  userId: string;
  fromState: string;
  toState: AieRunStatus;
  actorType: AieActorType;
  actorId?: string | null;
  reason?: string;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_extraction_run').update({ status: params.toState }).eq('id', params.runId);
  await admin.from('aie_processing_transition').insert({
    run_id: params.runId,
    intake_id: params.intakeId,
    user_id: params.userId,
    from_state: params.fromState,
    to_state: params.toState,
    actor_type: params.actorType,
    actor_id: params.actorId ?? null,
    reason: params.reason ?? null,
  });
}

export async function recordParserAttempt(params: {
  runId: string;
  intakeId: string;
  userId: string;
  adapterId: string;
  documentClass?: string;
  outcome: AieDeterministicOutcome;
  fieldsExtracted: number;
  fieldsMissing: string[];
  parserVersion?: string;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_parser_attempt').insert({
    run_id: params.runId,
    intake_id: params.intakeId,
    user_id: params.userId,
    adapter_id: params.adapterId,
    document_class: params.documentClass ?? null,
    outcome: params.outcome,
    fields_extracted: params.fieldsExtracted,
    fields_missing: params.fieldsMissing,
    parser_version: params.parserVersion ?? null,
  });
}

export async function recordMaskingSummary(params: {
  runId: string;
  intakeId: string;
  userId: string;
  coverageByType: Record<string, number>;
  belowPolicy: boolean;
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_masking_summary').insert({
    run_id: params.runId,
    intake_id: params.intakeId,
    user_id: params.userId,
    coverage_by_type: params.coverageByType,
    below_policy: params.belowPolicy,
  });
}

/**
 * M3 (Phase 4) — `persistMaskTokenMap` WAS HERE AND HAS BEEN REMOVED.
 *
 * It was the only writer of `aie_mask_token_map`, the table holding
 * reversible de-tokenisation material. The Product Owner's 2026-09-15
 * decision replaced the reversible escrow scheme with keyed one-way HMAC
 * pseudonyms (`lib/aie/masking/identifierToken.ts`), so there is nothing
 * left to escrow: `maskText` no longer returns original values at all, and
 * therefore no caller could supply them even if this function still existed.
 *
 * Removed rather than left in place unused, deliberately. A dormant function
 * that writes reversible PII is an invitation for a future adapter to call
 * it "because it was already there", which would silently reintroduce the
 * exact retention defect M2 recorded as H.10/PO-BLOCKER-4.
 *
 * The TABLE is intentionally NOT dropped and its migration is NOT re-emitted
 * — `0140` is already applied to DEV and production (M0 finding MG-1: never
 * renumber or rewrite an applied migration). Instead it is left with no
 * writer at all, plus an unconditional 48-hour TTL sweep over anything that
 * somehow appears in it (`purgeExpiredMaskTokenMaps`,
 * `lib/aie/services/purge.ts`). Verified read-only on 2026-09-15: the table
 * holds ZERO rows in both DEV and production, so no historical row exists to
 * migrate or strand.
 */

export async function recordAiCompletionAttempt(params: {
  runId: string;
  intakeId: string;
  userId: string;
  providerName: string;
  model: string;
  schemaName: string;
  schemaVersion: string;
  requestedFields: string[];
  idempotencyKey: string;
  outcome: AieAiOutcome;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
}): Promise<{ id: string } | { error: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('aie_ai_completion_attempt')
    .insert({
      run_id: params.runId,
      intake_id: params.intakeId,
      user_id: params.userId,
      provider_name: params.providerName,
      model: params.model,
      schema_name: params.schemaName,
      schema_version: params.schemaVersion,
      requested_fields: params.requestedFields,
      idempotency_key: params.idempotencyKey,
      outcome: params.outcome,
      input_tokens: params.inputTokens ?? null,
      output_tokens: params.outputTokens ?? null,
      latency_ms: params.latencyMs ?? null,
    })
    .select('id')
    .single();
  if (error || !data) return { error: error?.message ?? 'insert failed' };
  return { id: data.id as string };
}

export async function recordSchemaValidationResult(params: {
  attemptId: string;
  intakeId: string;
  userId: string;
  valid: boolean;
  errorCodes?: string[];
}): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_schema_validation_result').insert({
    attempt_id: params.attemptId,
    intake_id: params.intakeId,
    user_id: params.userId,
    valid: params.valid,
    error_codes: params.errorCodes ?? null,
  });
}

export async function recordFieldCandidates(params: { runId: string; intakeId: string; userId: string; candidates: AieFieldCandidate[] }): Promise<void> {
  if (params.candidates.length === 0) return;
  const admin = createAdminClient();
  await admin.from('aie_field_candidate').insert(
    params.candidates.map((c) => ({
      run_id: params.runId,
      intake_id: params.intakeId,
      user_id: params.userId,
      field_name: c.fieldName,
      value_raw: c.valueRaw,
      source_method: c.sourceMethod,
      source_reference: c.sourceReference ?? null,
      is_null: c.isNull,
      null_reason: c.nullReason ?? null,
    })),
  );
}

export async function recordReconciliationRuns(params: { runId: string; intakeId: string; userId: string; results: AieReconciliationRunResult[] }): Promise<void> {
  if (params.results.length === 0) return;
  const admin = createAdminClient();
  await admin.from('aie_reconciliation_run').insert(
    params.results.map((r) => ({
      run_id: params.runId,
      intake_id: params.intakeId,
      user_id: params.userId,
      rule_id: r.ruleId,
      rule_version: r.ruleVersion,
      outcome: r.outcome,
      delta: r.delta ?? null,
      tolerance: r.tolerance ?? null,
      materiality: r.materiality ?? null,
    })),
  );
}

export async function createUnresolvedItems(params: { runId: string; intakeId: string; userId: string; items: AieUnresolvedItemInput[] }): Promise<string[]> {
  if (params.items.length === 0) return [];
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('aie_unresolved_item')
    .insert(
      params.items.map((i) => ({
        run_id: params.runId,
        intake_id: params.intakeId,
        user_id: params.userId,
        reason_code: i.reasonCode,
        severity: i.severity,
        display_candidate: i.displayCandidate ?? null,
        evidence_ref: i.evidenceRef ?? null,
        permitted_action_types: i.permittedActionTypes,
      })),
    )
    .select('id');
  if (error || !data) return [];
  return data.map((r: { id: string }) => r.id);
}

export async function listOpenUnresolvedItemsForUser(userId: string): Promise<
  { id: string; runId: string; reasonCode: string; severity: AieItemSeverity; status: AieUnresolvedItemStatus; displayCandidate: string | null; itemVersion: number }[]
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_unresolved_item')
    .select('id, run_id, reason_code, severity, status, display_candidate, item_version')
    .eq('user_id', userId)
    .in('status', ['open', 'in_review']);
  return (data ?? []).map((r) => ({
    id: r.id,
    runId: r.run_id,
    reasonCode: r.reason_code,
    severity: r.severity,
    status: r.status,
    displayCandidate: r.display_candidate,
    itemVersion: r.item_version,
  }));
}

export type DecisionOutcome = { ok: true } | { ok: false; reason: 'not_found' | 'stale_conflict' | 'db_error' };

/**
 * EXC-05/EXC-08: server-validated, idempotent, version-checked decision
 * recording. The ONLY way an `aie_unresolved_item` row's status changes —
 * matches AIE-1.5's own "no direct client mutation of status" principle,
 * enforced here a phase early since AIE-1.1 already owns the table.
 *
 * AIE-1.5 addition: three optional `correction*` params, persisted to the
 * additive columns migration 0144 adds to this same table (no second
 * table) — populated only for a `decisionType` of `'correct'`, by a caller
 * that has ALREADY run both field-name-allowlist and typed-value
 * validation (lib/aie/review/decide.ts + validation.ts). This function
 * itself does not re-validate them — it is the persistence boundary, not
 * the policy boundary, exactly like every other function in this file.
 */
export async function recordReviewDecision(params: {
  itemId: string;
  intakeId: string;
  userId: string;
  expectedItemVersion: number;
  decisionType: string;
  rationale?: string;
  idempotencyKey: string;
  actorId?: string;
  newStatus: AieUnresolvedItemStatus;
  correctionFieldName?: string;
  correctionValueRaw?: string;
  correctionValueNormalized?: string;
}): Promise<DecisionOutcome> {
  const admin = createAdminClient();
  const { data: item } = await admin.from('aie_unresolved_item').select('item_version').eq('id', params.itemId).maybeSingle();
  if (!item) return { ok: false, reason: 'not_found' };
  if (item.item_version !== params.expectedItemVersion) return { ok: false, reason: 'stale_conflict' };

  const { error: decisionError } = await admin.from('aie_review_decision').insert({
    item_id: params.itemId,
    intake_id: params.intakeId,
    user_id: params.userId,
    item_version_at_decision: params.expectedItemVersion,
    decision_type: params.decisionType,
    rationale: params.rationale ?? null,
    idempotency_key: params.idempotencyKey,
    actor_id: params.actorId ?? null,
    correction_field_name: params.correctionFieldName ?? null,
    correction_value_raw: params.correctionValueRaw ?? null,
    correction_value_normalized: params.correctionValueNormalized ?? null,
  });
  if (decisionError) {
    if (decisionError.code === '23505') return { ok: true }; // idempotent replay
    return { ok: false, reason: 'db_error' };
  }

  const { error: updateError } = await admin
    .from('aie_unresolved_item')
    .update({ status: params.newStatus, item_version: params.expectedItemVersion + 1, updated_at: new Date().toISOString() })
    .eq('id', params.itemId)
    .eq('item_version', params.expectedItemVersion);
  if (updateError) return { ok: false, reason: 'db_error' };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// AIE-1.5 additions below — read/transition helpers the review layer needs.
// Same discipline as every function above: service-role only, caller has
// already proven ownership via an RLS-scoped read or an explicit userId
// filter in the query itself.
// ---------------------------------------------------------------------------

export interface AieRunRow {
  id: string;
  intakeId: string;
  userId: string;
  status: AieRunStatus;
  aiUsed: boolean;
  startedAt: string;
}

/** Ownership-scoped by construction (`.eq('user_id', userId)`) — never
 * trusts a bare runId alone as proof of access (VALID-03 / PRIV-06: IDOR
 * protection). */
export async function getRunForUser(runId: string, userId: string): Promise<AieRunRow | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_extraction_run').select('id, intake_id, user_id, status, ai_used, started_at').eq('id', runId).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  return { id: data.id, intakeId: data.intake_id, userId: data.user_id, status: data.status as AieRunStatus, aiUsed: data.ai_used, startedAt: data.started_at };
}

export async function listRunsForUser(userId: string, limit = 50): Promise<AieRunRow[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_extraction_run')
    .select('id, intake_id, user_id, status, ai_used, started_at')
    .eq('user_id', userId)
    .order('started_at', { ascending: false })
    .limit(Math.min(limit, 100));
  return (data ?? []).map((r) => ({ id: r.id, intakeId: r.intake_id, userId: r.user_id, status: r.status as AieRunStatus, aiUsed: r.ai_used, startedAt: r.started_at }));
}

/**
 * M3 (Phase 4) — ownership-scoped intake read for the Investment
 * Intelligence password-unlock route. Scoped by `user_id` in the query
 * itself, never by a bare `intakeId`, so a guessed id cannot be used to
 * discover whether someone else's document exists (PRIV-06 / IDOR).
 */
export async function getIntakeForUser(
  intakeId: string,
  userId: string,
): Promise<{ id: string; status: AieIntakeStatus; storageKey: string | null; displayFilename: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_intake').select('id, status, storage_key, display_filename').eq('id', intakeId).eq('user_id', userId).maybeSingle();
  if (!data) return null;
  return { id: data.id, status: data.status as AieIntakeStatus, storageKey: data.storage_key ?? null, displayFilename: data.display_filename ?? null };
}

/**
 * M3 (Phase 4) — audit events of one type for one intake, newest first.
 *
 * Exists so AIE can rate-limit password attempts the SAME way FDH-5 already
 * does, by counting recorded attempts rather than by storing anything about
 * them. `lib/financial-data-hub/bank-pdf/password.ts`'s own header makes the
 * distinction that licenses this: "an AUDIT EVENT RECORDING 'an attempt
 * occurred' is not the password". This function returns only `event_type`
 * and `created_at` — deliberately not `metadata` — so the rate-limit path
 * cannot read attempt metadata even by accident.
 */
export async function listAuditEventsForIntake(params: { intakeId: string; eventType: AieAuditEventTypeName; limit?: number }): Promise<{ event_type: string; created_at: string }[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_audit_event')
    .select('event_type, created_at')
    .eq('intake_id', params.intakeId)
    .eq('event_type', params.eventType)
    .order('created_at', { ascending: false })
    .limit(Math.min(params.limit ?? 50, 200));
  return (data ?? []).map((r) => ({ event_type: r.event_type as string, created_at: r.created_at as string }));
}

export async function getIntakeDisplayFilename(intakeId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_intake').select('display_filename').eq('id', intakeId).maybeSingle();
  return data?.display_filename ?? null;
}

/**
 * AIE-1.2 accept-time dispatch — the ORIGINAL upload's own storage
 * location + declared metadata, already persisted at intake time by
 * `createIntake`/`updateIntakeStatus` (AIE-1.1 core). Nothing new is
 * persisted here: `storage_key` is set once, at intake, when the bytes are
 * first written to quarantine (`app/api/aie/intake/route.ts`'s own
 * `uploadToQuarantine` call), and never changes afterwards — an accept-time
 * caller needing the original bytes (Investment Intelligence's
 * `write.ts`'s own `downloadFromQuarantine` call) re-fetches from the SAME
 * quarantine object this row already names, rather than re-uploading or
 * persisting a second copy of anything.
 */
export async function getIntakeUploadMetadata(intakeId: string): Promise<{ storageKey: string; declaredMimeType: string; displayFilename: string | null } | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_document_intake').select('storage_key, declared_mime_type, display_filename').eq('id', intakeId).maybeSingle();
  if (!data?.storage_key) return null;
  return { storageKey: data.storage_key, declaredMimeType: data.declared_mime_type, displayFilename: data.display_filename ?? null };
}

/**
 * CONC-01/02: compare-and-swap run-status transition. Returns `false`
 * (never throws) when `fromStatus` no longer matches the current row —
 * the caller's own stale-conflict signal, identical in spirit to
 * `recordReviewDecision`'s item-version check, at the run level instead of
 * the item level.
 */
export async function transitionRunStatusCas(params: { runId: string; fromStatus: AieRunStatus; toStatus: AieRunStatus }): Promise<boolean> {
  assertRunTransition(params.fromStatus, params.toStatus);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('aie_extraction_run')
    .update({ status: params.toStatus })
    .eq('id', params.runId)
    .eq('status', params.fromStatus)
    .select('id');
  if (error) return false;
  return (data ?? []).length > 0;
}

export async function recordRunTransitionAudit(params: { runId: string; intakeId: string; userId: string; fromState: string; toState: AieRunStatus; actorType: AieActorType; actorId?: string | null; reason?: string }): Promise<void> {
  const admin = createAdminClient();
  await admin.from('aie_processing_transition').insert({
    run_id: params.runId,
    intake_id: params.intakeId,
    user_id: params.userId,
    from_state: params.fromState,
    to_state: params.toState,
    actor_type: params.actorType,
    actor_id: params.actorId ?? null,
    reason: params.reason ?? null,
  });
}

export async function listFieldCandidatesForRun(runId: string): Promise<AieFieldCandidate[]> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_field_candidate').select('field_name, value_raw, is_null, null_reason, source_method, source_reference').eq('run_id', runId);
  return (data ?? []).map((r) => ({
    fieldName: r.field_name,
    valueRaw: r.value_raw,
    isNull: r.is_null,
    nullReason: r.null_reason ?? undefined,
    sourceMethod: r.source_method as AieFieldCandidate['sourceMethod'],
    sourceReference: r.source_reference ?? undefined,
  }));
}

export interface LatestCorrectionRow {
  fieldName: string;
  valueNormalized: string;
  valueRaw: string;
  decisionId: string;
  actorId: string | null;
}

/** Returns the LATEST accepted correction per field name for this run,
 * across every item belonging to it — the effective override set
 * `lib/aie/review/candidateMerge.ts` applies on top of the original,
 * never-mutated field candidates (VALID-12). */
export async function listLatestCorrectionsForRun(runId: string): Promise<LatestCorrectionRow[]> {
  const admin = createAdminClient();
  const { data: items } = await admin.from('aie_unresolved_item').select('id').eq('run_id', runId);
  const itemIds = (items ?? []).map((i: { id: string }) => i.id);
  if (itemIds.length === 0) return [];
  const { data } = await admin
    .from('aie_review_decision')
    .select('id, item_id, correction_field_name, correction_value_raw, correction_value_normalized, actor_id, created_at')
    .in('item_id', itemIds)
    .eq('decision_type', 'correct')
    .order('created_at', { ascending: true });
  const latestByField = new Map<string, LatestCorrectionRow>();
  for (const row of data ?? []) {
    if (!row.correction_field_name || row.correction_value_normalized === null) continue;
    latestByField.set(row.correction_field_name, {
      fieldName: row.correction_field_name,
      valueNormalized: row.correction_value_normalized,
      valueRaw: row.correction_value_raw ?? row.correction_value_normalized,
      decisionId: row.id,
      actorId: row.actor_id ?? null,
    });
  }
  return Array.from(latestByField.values());
}

export async function getAdapterIdForRun(runId: string): Promise<string | null> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_parser_attempt').select('adapter_id').eq('run_id', runId).order('created_at', { ascending: false }).limit(1).maybeSingle();
  return data?.adapter_id ?? null;
}

export async function listOpenUnresolvedItemsForRun(runId: string): Promise<
  { id: string; reasonCode: string; severity: AieItemSeverity; status: AieUnresolvedItemStatus; displayCandidate: string | null; evidenceRef: Record<string, unknown> | null; itemVersion: number }[]
> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_unresolved_item')
    .select('id, reason_code, severity, status, display_candidate, evidence_ref, item_version')
    .eq('run_id', runId)
    .in('status', ['open', 'in_review']);
  return (data ?? []).map((r) => ({ id: r.id, reasonCode: r.reason_code, severity: r.severity, status: r.status, displayCandidate: r.display_candidate, evidenceRef: r.evidence_ref, itemVersion: r.item_version }));
}

/**
 * Broader than `listOpenUnresolvedItemsForRun`'s `open`/`in_review` filter
 * ON PURPOSE — a `deferred` item is a deliberate "not now" (ACT-06: "never
 * creating false completion"), not a resolution, so it must still count
 * toward "this run cannot be accepted yet" (section 35: "Needs your
 * review" permits defer without granting Ready-to-accept). Only `resolved`
 * and `superseded`/`rejected` items are excluded. Used by both
 * `computeUserFacingState`'s caller and the accept-gate (ACPT-02).
 */
export async function countItemsBlockingAcceptanceForRun(runId: string): Promise<number> {
  const admin = createAdminClient();
  const { count } = await admin
    .from('aie_unresolved_item')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', runId)
    .eq('severity', 'blocking')
    .in('status', ['open', 'in_review', 'deferred']);
  return count ?? 0;
}

export async function latestReconciliationOutcomesForRun(runId: string): Promise<{ ruleId: string; outcome: AieReconciliationOutcome }[]> {
  const admin = createAdminClient();
  const { data } = await admin.from('aie_reconciliation_run').select('rule_id, outcome, created_at').eq('run_id', runId).order('created_at', { ascending: true });
  const latestByRule = new Map<string, AieReconciliationOutcome>();
  for (const row of data ?? []) latestByRule.set(row.rule_id, row.outcome as AieReconciliationOutcome);
  return Array.from(latestByRule.entries()).map(([ruleId, outcome]) => ({ ruleId, outcome }));
}

/** System-actor resolution of an item made moot by revalidation (a
 * correction elsewhere already fixed the underlying condition, or a rule
 * that used to fail now passes) — goes through the EXACT SAME
 * version-checked `aie_review_decision` audit trail as a human decision,
 * with `actorId` left null and `decisionType` naming the system event, so
 * the audit history never implies a human clicked something they did not
 * (AUD-01/ACT-12). */
export async function resolveItemBySystem(params: { itemId: string; intakeId: string; userId: string; expectedItemVersion: number; decisionType: 'superseded_by_revalidation' | 'auto_resolved_by_revalidation'; idempotencyKey: string; rationale?: string }): Promise<DecisionOutcome> {
  return recordReviewDecision({
    itemId: params.itemId,
    intakeId: params.intakeId,
    userId: params.userId,
    expectedItemVersion: params.expectedItemVersion,
    decisionType: params.decisionType,
    rationale: params.rationale,
    idempotencyKey: params.idempotencyKey,
    newStatus: params.decisionType === 'superseded_by_revalidation' ? 'superseded' : 'resolved',
  });
}

/**
 * ACPT-07: "create a stable canonical-write batch/idempotency identity."
 * Populates AIE-1.1 core's own `aie_write_batch` SCAFFOLD table (migration
 * 0140 — "a future domain adapter will populate, not a canonical table")
 * exactly as that table's header always intended, rather than inventing a
 * new tracking row. Idempotent by construction: `idempotency_key` is
 * unique, so a retry with the SAME key returns the EXISTING row instead of
 * creating a second one (FAIL-03/04/10).
 */
export async function findOrCreateWriteBatch(params: { runId: string; intakeId: string; userId: string; targetModule: 'investment_intelligence' | 'fdh_bank' | 'other'; idempotencyKey: string }): Promise<{ id: string; status: 'pending' | 'committed' | 'failed' }> {
  const admin = createAdminClient();
  const { data: existing } = await admin.from('aie_write_batch').select('id, status').eq('idempotency_key', params.idempotencyKey).maybeSingle();
  if (existing) return { id: existing.id, status: existing.status };
  const { data, error } = await admin
    .from('aie_write_batch')
    .insert({ run_id: params.runId, intake_id: params.intakeId, user_id: params.userId, target_module: params.targetModule, idempotency_key: params.idempotencyKey, status: 'pending' })
    .select('id, status')
    .single();
  if (error || !data) {
    // Lost a race with a concurrent identical request — read back the row
    // the other request just created rather than failing outright.
    const { data: raced } = await admin.from('aie_write_batch').select('id, status').eq('idempotency_key', params.idempotencyKey).maybeSingle();
    if (raced) return { id: raced.id, status: raced.status };
    throw new Error(`aie_write_batch: could not create or find batch for ${params.idempotencyKey}`);
  }
  return { id: data.id, status: data.status };
}

/** Distinguishes "this run's terminal/retryable state came from an actual
 * write attempt" from "this run never got that far" (e.g. the user
 * rejected the document, or admission failed) — `aie_write_batch` rows are
 * created ONLY by `lib/aie/review/accept.ts`, never by rejection/cancellation,
 * so its mere existence for a run is an unambiguous signal, used by
 * `userState.ts`'s `hasEverReachedWritePending` input. */
export async function hasWriteBatchForRun(runId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { count } = await admin.from('aie_write_batch').select('id', { count: 'exact', head: true }).eq('run_id', runId);
  return (count ?? 0) > 0;
}

export async function markWriteBatchStatus(batchId: string, status: 'committed' | 'failed'): Promise<void> {
  const admin = createAdminClient();
  await admin
    .from('aie_write_batch')
    .update({ status, committed_at: status === 'committed' ? new Date().toISOString() : null })
    .eq('id', batchId);
}

/**
 * M3 (Phase 4) — `findMaskTokenCiphertext` WAS HERE AND HAS BEEN REMOVED,
 * for the same reason as `persistMaskTokenMap` above: with one-way HMAC
 * pseudonyms there is no ciphertext to look up, and `lib/aie/review/reveal.ts`
 * now refuses every reveal request structurally rather than attempting a
 * decrypt that could never succeed.
 */

/**
 * M3 (Phase 4) — unconditional retention enforcement over
 * `aie_mask_token_map`, implementing the Product Owner's 2026-09-15
 * decision: "FIXED SHORT TTL (24-48 hours), independent of document
 * lifecycle state", with 48 hours taken as the decided default.
 *
 * DELIBERATELY NOT LIFECYCLE-AWARE. It does not join to
 * `aie_document_intake`, does not consider `status`, `purge_status`, run
 * state, or whether a review is still open. The Product Owner explicitly
 * accepted that a document still under review past the TTL loses this
 * transient data; building a lifecycle-aware retention rule instead would
 * be substituting a different policy for the one that was decided.
 *
 * NO SCHEMA CHANGE WAS NEEDED. `aie_mask_token_map.created_at` already
 * exists (`0140:312`, `not null default now()`), so the TTL is expressed
 * against it rather than by adding an `expires_at` column. That matters
 * practically, not just aesthetically: this environment has no way to apply
 * DDL to DEV or production (M0 operator item OA-3 — no SQL-execution RPC is
 * exposed on either project), so a column-based TTL would have shipped as an
 * unapplied migration and the retention guarantee would have been a
 * statement of intent rather than something that actually runs.
 */
export async function purgeExpiredMaskTokenMapRows(ttlHours: number): Promise<{ deleted: number }> {
  const admin = createAdminClient();
  const cutoffIso = new Date(Date.now() - ttlHours * 3600_000).toISOString();
  const { data, error } = await admin.from('aie_mask_token_map').delete().lt('created_at', cutoffIso).select('id');
  if (error) return { deleted: 0 };
  return { deleted: (data ?? []).length };
}
