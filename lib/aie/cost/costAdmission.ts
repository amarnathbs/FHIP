/**
 * AIE-1 closure mission (section 8) — TypeScript wrapper around the atomic
 * `aie_reserve_ai_cost` / `aie_settle_ai_cost(_v2)` Postgres functions. Every
 * actual concurrency-safety guarantee lives in SQL; this module only shapes
 * the RPC call and sizes the conservative pre-call reservation. It performs no
 * read-then-write of its own.
 *
 * AIE-1 final production completion (2026-09-25) changes, with migration 0195:
 *   - The reservation is sized from THIS call: the larger of the configured
 *     per-document input ceiling and an estimate from the prompt length, the
 *     output budget the call will actually request, multiplied by the number
 *     of HTTP attempts the provider may make (1 + transient retries). The old
 *     fixed 4000-in/512-out figure under-reserved line-item calls, which ask
 *     for 4096 output tokens.
 *   - Settlement goes through `aie_settle_ai_cost_v2`, which releases the
 *     amount STORED on the reservation (never a caller figure) and records the
 *     per-call evidence: model, provider request ids, tokens, outcome, and
 *     whether billing is uncertain. If 0195 is not applied yet in an
 *     environment the wrapper falls back to the 0152 function, so deploy order
 *     cannot break settlement.
 *   - A settlement error is no longer ignored: it is reported to the caller
 *     and logged. The reservation then stays held (conservative) until
 *     `aie_release_stale_ai_cost_reservations` settles it at the full amount.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import {
  getAieCostAllowanceUsd,
  getAieAiMaxInputTokensPerDocument,
  getAieAiMaxOutputTokensPerDocument,
  getAieAiMaxTransientRetries,
  estimateOpenAiCostUsd,
} from '../config';

export const AIE_COST_LEDGER_ID = 'global';

export interface CostReservation {
  admitted: boolean;
  remainingUsd: number;
  reservedUsd: number;
}

export interface ReservationSizing {
  /** Total characters of system + user prompt about to be sent. */
  promptChars?: number;
  /** The `max_tokens` the call will request. */
  maxOutputTokens?: number;
}

/**
 * Conservative token estimate for a prompt: one token per 3 characters (real
 * English/number-heavy text is closer to 4) plus a fixed allowance for the
 * chat framing and the JSON schema sent in `response_format`.
 */
export function estimatePromptTokens(promptChars: number): number {
  return Math.ceil(Math.max(0, promptChars) / 3) + 600;
}

export function computeConservativeReservationUsd(model: string, sizing: ReservationSizing = {}): number {
  const inputTokens = Math.max(getAieAiMaxInputTokensPerDocument(), estimatePromptTokens(sizing.promptChars ?? 0));
  const outputTokens = Math.max(getAieAiMaxOutputTokensPerDocument(), sizing.maxOutputTokens ?? 0);
  const attempts = 1 + getAieAiMaxTransientRetries();
  return estimateOpenAiCostUsd(inputTokens, outputTokens, model) * attempts;
}

/**
 * Reserve a CONSERVATIVE worst-case cost before the provider call.
 *
 * `idempotencyKey` must identify ONE logical attempt. Since migration 0195 a
 * key that has been seen before is never admitted again (settled, in flight or
 * refused), so callers must mint a fresh key per attempt.
 */
export async function reserveConservativeAiCost(model: string, idempotencyKey: string, sizing: ReservationSizing = {}): Promise<CostReservation> {
  const admin = createAdminClient();
  const reservedUsd = computeConservativeReservationUsd(model, sizing);
  const { data, error } = await admin.rpc('aie_reserve_ai_cost', {
    p_ledger_id: AIE_COST_LEDGER_ID,
    p_amount_usd: reservedUsd,
    p_allowance_usd: getAieCostAllowanceUsd(),
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data || data.length === 0) {
    // Fail closed: a broken admission gate must not become no gate at all.
    return { admitted: false, remainingUsd: 0, reservedUsd: 0 };
  }
  const row = data[0] as { reserved: boolean; remaining_usd: number };
  return { admitted: row.reserved, remainingUsd: Number(row.remaining_usd), reservedUsd: row.reserved ? reservedUsd : 0 };
}

export interface SettleParams {
  reservedUsd: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  model: string;
  idempotencyKey: string;
  /** Settle at the full reserved amount: the provider may have billed without
   * reporting usage (timeout, or a network failure after the request left). */
  treatAsFullReservedCost?: boolean;
  providerRequestIds?: string[];
  callOutcome?: string;
}

export interface SettleResult {
  settled: boolean;
  alreadySettled: boolean;
  error?: string;
}

function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || /could not find the function/i.test(error.message ?? '');
}

/**
 * Settle a reservation against the ACTUAL observed cost once the provider call
 * has concluded (success, failure or timeout). Never throws: a settlement
 * failure is returned and logged, and the reservation remains held.
 */
export async function settleAiCost(params: SettleParams): Promise<SettleResult> {
  const admin = createAdminClient();
  const actualUsd = params.treatAsFullReservedCost
    ? params.reservedUsd
    : estimateOpenAiCostUsd(params.actualInputTokens, params.actualOutputTokens, params.model);

  const v2 = await admin.rpc('aie_settle_ai_cost_v2', {
    p_ledger_id: AIE_COST_LEDGER_ID,
    p_idempotency_key: params.idempotencyKey,
    p_actual_usd: actualUsd,
    p_input_tokens: params.actualInputTokens,
    p_output_tokens: params.actualOutputTokens,
    p_model: params.model,
    p_provider_request_ids: params.providerRequestIds ?? [],
    p_call_outcome: params.callOutcome ?? null,
    p_billing_uncertain: params.treatAsFullReservedCost === true,
  });

  if (!v2.error) {
    const row = (Array.isArray(v2.data) ? v2.data[0] : v2.data) as { settled?: boolean; already_settled?: boolean } | null;
    return { settled: row?.settled === true, alreadySettled: row?.already_settled === true };
  }

  if (isMissingFunctionError(v2.error as { code?: string; message?: string })) {
    // Migration 0195 not applied in this environment yet: the 0152 function.
    const v1 = await admin.rpc('aie_settle_ai_cost', {
      p_ledger_id: AIE_COST_LEDGER_ID,
      p_reserved_usd: params.reservedUsd,
      p_actual_usd: actualUsd,
      p_input_tokens: params.actualInputTokens,
      p_output_tokens: params.actualOutputTokens,
      p_idempotency_key: params.idempotencyKey,
    });
    if (!v1.error) return { settled: true, alreadySettled: false };
    console.error(`aie cost settlement failed (0152 path) for key ${params.idempotencyKey}: ${v1.error.message}`);
    return { settled: false, alreadySettled: false, error: v1.error.message };
  }

  console.error(`aie cost settlement failed for key ${params.idempotencyKey}: ${v2.error.message}`);
  return { settled: false, alreadySettled: false, error: v2.error.message };
}

/**
 * Settle every admitted reservation older than `olderThanMinutes` that was
 * never settled, conservatively (full reserved amount, billing uncertain).
 * Called from the AIE purge sweep. Returns the number released, or null when
 * the function is unavailable (0195 not applied).
 */
export async function releaseStaleAiCostReservations(olderThanMinutes = 60): Promise<number | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc('aie_release_stale_ai_cost_reservations', { p_older_than_minutes: olderThanMinutes });
  if (error) {
    if (!isMissingFunctionError(error as { code?: string; message?: string })) {
      console.error(`aie stale cost reservation release failed: ${error.message}`);
    }
    return null;
  }
  return typeof data === 'number' ? data : Number(data ?? 0);
}

/** Read-only dashboard/observability accessor. */
export async function getAieCostLedgerSnapshot(): Promise<{
  allowanceUsd: number;
  reservedUsd: number;
  settledUsd: number;
  remainingUsd: number;
  totalAttempts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
} | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('aie_ai_cost_ledger')
    .select('allowance_usd, reserved_usd, settled_usd, total_attempts, total_input_tokens, total_output_tokens')
    .eq('id', AIE_COST_LEDGER_ID)
    .maybeSingle();
  if (!data) return null;
  const allowanceUsd = Number(data.allowance_usd);
  const reservedUsd = Number(data.reserved_usd);
  const settledUsd = Number(data.settled_usd);
  return {
    allowanceUsd,
    reservedUsd,
    settledUsd,
    remainingUsd: Math.max(allowanceUsd - reservedUsd - settledUsd, 0),
    totalAttempts: Number(data.total_attempts),
    totalInputTokens: Number(data.total_input_tokens),
    totalOutputTokens: Number(data.total_output_tokens),
  };
}

/** Exposed for callers/tests that want the configured allowance without a DB
 * round trip. Since 0195 the stored ledger column is the ceiling; this value
 * can only lower it. */
export function getConfiguredCostAllowanceUsd(): number {
  return getAieCostAllowanceUsd();
}
