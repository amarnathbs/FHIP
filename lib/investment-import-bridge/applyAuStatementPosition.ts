/**
 * FDH-11 bridge — applying AU statement POSITION evidence as an
 * `ii_holding_snapshots` row (spec section 60: "A statement closing
 * quantity may be stored as statement snapshot / reconciliation evidence
 * without directly overwriting canonical holdings. Reuse existing II
 * snapshot architecture if present.") — it is. `ii_holding_snapshots` IS
 * already the project's snapshot/evidence mechanism (R2); there is no
 * separate "canonical holding" row this could overwrite (confirmed by
 * architecture discovery — see FDH11_REUSE_AND_GAP_AUDIT.md section 10:
 * holdings are ledger-derived, snapshots are point-in-time evidence).
 *
 * Same No-Silent-Apply / compare-and-swap / idempotency discipline as
 * `applyAuStatementActivity.ts` — see that file's header for the full
 * rationale, not repeated verbatim here.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { scaledToDecimalString, parseExactDecimal } from '@/lib/services/investment-intelligence/decimal';
import type { BridgeApplyResult } from './types';

export interface ApplyAuStatementPositionInput {
  userId: string;
  positionId: string;
}

export async function applyAuStatementPosition(input: ApplyAuStatementPositionInput): Promise<BridgeApplyResult> {
  const admin = createAdminClient();
  const { userId, positionId } = input;

  const { data: position, error: fetchErr } = await admin
    .from('fdh_investment_statement_positions')
    .select('*')
    .eq('id', positionId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr) return { ok: false, code: 'UNKNOWN_ERROR', canonicalTransactionId: null, error: fetchErr.message };
  if (!position) return { ok: false, code: 'NOT_FOUND', canonicalTransactionId: null, error: 'Position not found or not owned by this user.' };
  if (position.apply_status === 'applied') {
    return { ok: true, code: 'ALREADY_APPLIED', canonicalTransactionId: position.canonical_holding_snapshot_id as string | null, error: null };
  }

  const { data: statement, error: stmtErr } = await admin
    .from('fdh_investment_statements')
    .select('id, approval_status, canonical_account_id')
    .eq('id', position.statement_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (stmtErr || !statement) return { ok: false, code: 'NOT_FOUND', canonicalTransactionId: null, error: 'Parent statement not found.' };
  if (statement.approval_status !== 'approved') {
    return { ok: false, code: 'NOT_APPROVED', canonicalTransactionId: null, error: 'Statement evidence has not been approved yet.' };
  }
  if (position.security_match_status !== 'matched' || !position.matched_instrument_id) {
    return { ok: false, code: 'NOT_MATCHED', canonicalTransactionId: null, error: 'This position has no confirmed security match.' };
  }
  const canonicalAccountId = statement.canonical_account_id as string | null;
  if (!canonicalAccountId) return { ok: false, code: 'NOT_MATCHED', canonicalTransactionId: null, error: 'No confirmed investment account.' };

  const { data: claimed } = await admin
    .from('fdh_investment_statement_positions')
    .update({ apply_status: 'applying' })
    .eq('id', positionId)
    .eq('apply_status', 'pending')
    .select('id')
    .maybeSingle();
  if (!claimed) {
    const { data: recheck } = await admin.from('fdh_investment_statement_positions').select('apply_status, canonical_holding_snapshot_id').eq('id', positionId).maybeSingle();
    if (recheck?.apply_status === 'applied') {
      return { ok: true, code: 'ALREADY_APPLIED', canonicalTransactionId: recheck.canonical_holding_snapshot_id as string | null, error: null };
    }
    return { ok: false, code: 'ALREADY_APPLYING', canonicalTransactionId: null, error: 'Concurrent apply detected.' };
  }

  try {
    const unitsParsed = parseExactDecimal(String(position.quantity));
    if (!unitsParsed.ok) throw new Error('Position quantity is not a valid exact decimal.');
    const valueParsed = position.market_value !== null ? parseExactDecimal(String(position.market_value)) : null;

    // Upsert-on-conflict, exactly like documentProcessing.ts's own holding
    // snapshot write — a re-uploaded/overlapping statement for the SAME
    // (account, instrument, as_of_date) never creates a duplicate row.
    const { data: snap, error: upsertErr } = await admin
      .from('ii_holding_snapshots')
      .upsert(
        {
          user_id: userId,
          account_id: canonicalAccountId,
          instrument_id: position.matched_instrument_id,
          currency_code: position.currency_code,
          quality_status: 'warning',
          as_of_date: position.valuation_date,
          units: scaledToDecimalString(unitsParsed.scaled),
          value: valueParsed && valueParsed.ok ? scaledToDecimalString(valueParsed.scaled, 2) : '0',
        },
        { onConflict: 'account_id,instrument_id,as_of_date' },
      )
      .select('id')
      .single();
    if (upsertErr || !snap) throw new Error(upsertErr?.message ?? 'Holding snapshot upsert failed.');

    await admin
      .from('fdh_investment_statement_positions')
      .update({ apply_status: 'applied', canonical_holding_snapshot_id: snap.id, applied_at: new Date().toISOString(), applied_by: userId })
      .eq('id', positionId);

    return { ok: true, code: null, canonicalTransactionId: snap.id as string, error: null };
  } catch (e) {
    await admin
      .from('fdh_investment_statement_positions')
      .update({ apply_status: 'pending' })
      .eq('id', positionId)
      .eq('apply_status', 'applying');
    return { ok: false, code: 'UNKNOWN_ERROR', canonicalTransactionId: null, error: e instanceof Error ? e.message : String(e) };
  }
}
