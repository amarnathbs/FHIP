/**
 * AIE-1 closure mission (section 8) — TypeScript wrapper around migration
 * 0148's atomic `aie_reserve_ai_cost`/`aie_settle_ai_cost` Postgres
 * functions. Every actual concurrency-safety guarantee lives in the SQL
 * function (one atomic `UPDATE ... WHERE ... RETURNING`) — this module
 * only shapes the RPC call and estimates the conservative pre-call
 * reservation amount; it performs no read-then-write of its own.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { getAieCostAllowanceUsd, getAieAiMaxInputTokensPerDocument, getAieAiMaxOutputTokensPerDocument, estimateOpenAiCostUsd } from '../config';

export const AIE_COST_LEDGER_ID = 'global';

export interface CostReservation {
  admitted: boolean;
  remainingUsd: number;
  reservedUsd: number;
}

/**
 * Reserve a CONSERVATIVE worst-case cost before the provider call (mission
 * section 8: "reserve a conservative maximum before the provider call").
 * Uses the configured per-document max input/output token ceilings, not an
 * estimate of THIS document's actual masked-text length — the whole point
 * of a conservative reservation is that it never under-reserves.
 */
export async function reserveConservativeAiCost(model: string): Promise<CostReservation> {
  const admin = createAdminClient();
  const reservedUsd = estimateOpenAiCostUsd(getAieAiMaxInputTokensPerDocument(), getAieAiMaxOutputTokensPerDocument(), model);
  const { data, error } = await admin.rpc('aie_reserve_ai_cost', {
    p_ledger_id: AIE_COST_LEDGER_ID,
    p_amount_usd: reservedUsd,
    p_allowance_usd: getAieCostAllowanceUsd(),
  });
  if (error || !data || data.length === 0) {
    // Fail closed: if the ledger RPC itself is unreachable/misconfigured,
    // do not admit the call (mission section 8: "do not rely solely on
    // provider dashboard budgets as hard stops" -- a broken admission gate
    // must not silently become "no gate at all").
    return { admitted: false, remainingUsd: 0, reservedUsd: 0 };
  }
  const row = data[0] as { reserved: boolean; remaining_usd: number };
  return { admitted: row.reserved, remainingUsd: Number(row.remaining_usd), reservedUsd: row.reserved ? reservedUsd : 0 };
}

/**
 * Settle a reservation against the ACTUAL observed cost once the provider
 * call has concluded (success, failure, or timeout) — never for a call the
 * kill switch or PII guard blocked before any reservation was made (there
 * is nothing to settle in that case, since `reserveConservativeAiCost` was
 * never called). `actualInputTokens`/`actualOutputTokens` should be 0 when
 * the provider genuinely produced no billable tokens (e.g. a network error
 * before any response); an UNCERTAIN outcome (e.g. a timeout where the
 * provider may or may not have processed the request) should settle at the
 * full RESERVED amount, per mission section 8's "handle uncertain charges
 * after timeouts conservatively" — callers pass `treatAsFullReservedCost:
 * true` for that case rather than guessing zero.
 */
export async function settleAiCost(params: {
  reservedUsd: number;
  actualInputTokens: number;
  actualOutputTokens: number;
  model: string;
  treatAsFullReservedCost?: boolean;
}): Promise<void> {
  const admin = createAdminClient();
  const actualUsd = params.treatAsFullReservedCost ? params.reservedUsd : estimateOpenAiCostUsd(params.actualInputTokens, params.actualOutputTokens, params.model);
  await admin.rpc('aie_settle_ai_cost', {
    p_ledger_id: AIE_COST_LEDGER_ID,
    p_reserved_usd: params.reservedUsd,
    p_actual_usd: actualUsd,
    p_input_tokens: params.actualInputTokens,
    p_output_tokens: params.actualOutputTokens,
  });
}

/** Read-only dashboard/observability accessor (mission section 8's tracked
 * metrics: cost per attempted document, scan bytes/count belong to a
 * separate malware-side ledger — see `docs/aie-programme/`). */
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

/** Exposed for callers/tests that want the configured allowance without a
 * DB round trip (e.g. to display "pilot allowance: $10.00" in a UI). */
export function getConfiguredCostAllowanceUsd(): number {
  return getAieCostAllowanceUsd();
}
