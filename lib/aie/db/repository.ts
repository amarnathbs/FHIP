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
import { encryptTokenValue } from '../masking/tokenMapCrypto';
import type {
  AieActorType,
  AieAiOutcome,
  AieDeterministicOutcome,
  AieFieldCandidate,
  AieIntakeStatus,
  AieItemSeverity,
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

export async function updateIntakeStatus(params: {
  intakeId: string;
  toStatus: AieIntakeStatus;
  storageKey?: string;
  detectedMimeType?: string;
  rejectionReason?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  const admin = createAdminClient();
  const patch: Record<string, unknown> = { status: params.toStatus, updated_at: new Date().toISOString() };
  if (params.storageKey !== undefined) patch.storage_key = params.storageKey;
  if (params.detectedMimeType !== undefined) patch.detected_mime_type = params.detectedMimeType;
  if (params.rejectionReason !== undefined) patch.rejection_reason = params.rejectionReason;
  const { error } = await admin.from('aie_document_intake').update(patch).eq('id', params.intakeId);
  if (error) return { ok: false, message: error.message };
  return { ok: true };
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

/** PII-08: encrypts every value before it ever reaches the database. */
export async function persistMaskTokenMap(params: { runId: string; reversibleTokenMap: Record<string, string> }): Promise<void> {
  const entries = Object.entries(params.reversibleTokenMap);
  if (entries.length === 0) return;
  const admin = createAdminClient();
  const rows = entries.map(([token, rawValue]) => ({
    run_id: params.runId,
    token,
    ciphertext: encryptTokenValue(rawValue),
  }));
  await admin.from('aie_mask_token_map').insert(rows);
}

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
