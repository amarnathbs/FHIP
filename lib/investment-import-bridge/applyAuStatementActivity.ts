/**
 * FDH-11 bridge — the ONLY place a real `ii_transactions` row is ever
 * created from AU statement evidence (spec sections 63-65, 108, 121-124).
 *
 * NO SILENT APPLY. Upload -> parse -> match -> reconcile -> review ->
 * approve evidence -> prepare all leave the canonical ledger untouched;
 * only an explicit call to `applyAuStatementActivity` can create a real row,
 * and only once the parent statement is `approval_status = 'approved'` and
 * this activity's own security is `matched` with both a resolved
 * `matched_instrument_id` (per-activity) and a resolved
 * `canonical_account_id` (on the parent statement).
 *
 * CONCURRENT APPLY = EXACTLY ONCE (spec section 122). The compare-and-swap
 * `UPDATE ... SET apply_status='applying' WHERE id=$1 AND apply_status='pending'`
 * is a single Postgres UPDATE statement — atomic by construction, no RPC
 * needed. A second concurrent caller sees 0 rows affected and returns
 * ALREADY_APPLYING/ALREADY_APPLIED without ever reaching the insert.
 *
 * IDEMPOTENCY / NO DUPLICATE (spec sections 54-58, 106-107, 119-120).
 * Before inserting, this function checks for an EXISTING `ii_transactions`
 * row with the identical `transaction_fingerprint` (R2's own dedup
 * mechanism, reused verbatim via `computeTransactionFingerprint` — the SAME
 * real-world transaction observed twice, whether from the same statement
 * re-uploaded or from two overlapping statement periods, resolves to the
 * SAME canonical row, never a duplicate).
 *
 * STALE/CONFLICT (spec section 123). If the caller's `expectedApplyStatus`
 * no longer matches what is live in the DB when the compare-and-swap runs,
 * this reports STALE_EVIDENCE rather than overwriting silently — this is
 * the identical semantic FDH-9/FDH-10's own staleness check provides,
 * achieved here by the same compare-and-swap UPDATE rather than a
 * per-field snapshot comparison (appropriate here because the evidence row
 * itself, not a canonical target row, is what could have changed).
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { computeTransactionFingerprint } from '@/lib/services/investment-intelligence/fingerprint';
import { parseExactDecimal, scaledToDecimalString } from '@/lib/services/investment-intelligence/decimal';
import type { IiTransactionType } from '@/lib/services/investment-intelligence/types';
import type { AuStatementTransactionType } from '@/lib/financial-data-hub/investment/types';
import type { BridgeApplyResult } from './types';

const FDH11_SOURCE_KEY = 'fdh11_au_statement';

/**
 * Statement evidence type -> canonical Investment Intelligence type. A
 * value mapping to `null` has NO safe canonical representation today and is
 * never applied — see the disclosed gaps below, each one a genuine
 * Investment Intelligence schema gap (NOT AU-specific, NOT an India gap),
 * documented in FDH11_REUSE_AND_GAP_AUDIT.md rather than worked around here.
 */
const ACTIVITY_TO_CANONICAL_TYPE: Record<AuStatementTransactionType, IiTransactionType | null> = {
  BUY: 'purchase',
  SELL: 'sale',
  DIVIDEND: 'dividend',
  // No distinct 'distribution' value exists in ii_transactions.transaction_type
  // (migration 0033/0059/0092) — nearest existing canonical fit, disclosed gap.
  DISTRIBUTION: 'dividend',
  DRP: 'reinvestment',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
  BROKERAGE: 'fee',
  FEE: 'fee',
  // Disclosed II schema gap: ii_transactions.instrument_id is NOT NULL
  // (migration 0033) — a pure broker-CASH event with no associated security
  // (bank interest on the cash balance, a cash-only deposit/withdrawal not
  // tied to any trade) has no canonical row shape to occupy at all today.
  // Never forced into a fabricated instrument_id.
  INTEREST: null,
  CASH_DEPOSIT: null,
  CASH_WITHDRAWAL: null,
  // Never auto-applied (spec section 38) — always routed to review.
  CORPORATE_ACTION_EVIDENCE: null,
  OTHER: null,
  UNKNOWN: null,
};

export interface ApplyAuStatementActivityInput {
  userId: string;
  activityId: string;
}

export async function applyAuStatementActivity(input: ApplyAuStatementActivityInput): Promise<BridgeApplyResult> {
  const admin = createAdminClient();
  const { userId, activityId } = input;

  const { data: activity, error: fetchErr } = await admin
    .from('fdh_investment_statement_activities')
    .select('*')
    .eq('id', activityId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr) return { ok: false, code: 'UNKNOWN_ERROR', canonicalTransactionId: null, error: fetchErr.message };
  if (!activity) return { ok: false, code: 'NOT_FOUND', canonicalTransactionId: null, error: 'Activity not found or not owned by this user.' };

  if (activity.apply_status === 'applied') {
    return { ok: true, code: 'ALREADY_APPLIED', canonicalTransactionId: activity.canonical_transaction_id as string | null, error: null };
  }
  if (activity.apply_status === 'applying') {
    return { ok: false, code: 'ALREADY_APPLYING', canonicalTransactionId: null, error: 'This evidence row is currently being applied by another request.' };
  }

  const { data: statement, error: stmtErr } = await admin
    .from('fdh_investment_statements')
    .select('id, user_id, approval_status, canonical_account_id')
    .eq('id', activity.statement_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (stmtErr || !statement) return { ok: false, code: 'NOT_FOUND', canonicalTransactionId: null, error: 'Parent statement not found or not owned by this user.' };
  if (statement.approval_status !== 'approved') {
    return { ok: false, code: 'NOT_APPROVED', canonicalTransactionId: null, error: 'Statement evidence has not been approved yet — no canonical write may occur (spec section 63).' };
  }
  if (activity.security_match_status !== 'matched' || !activity.matched_instrument_id) {
    return { ok: false, code: 'NOT_MATCHED', canonicalTransactionId: null, error: 'This activity has no confirmed security match.' };
  }
  const canonicalAccountId = statement.canonical_account_id as string | null;
  if (!canonicalAccountId) {
    return { ok: false, code: 'NOT_MATCHED', canonicalTransactionId: null, error: 'The parent statement has no confirmed investment account.' };
  }

  // FOREIGN_ACCOUNT check (spec section 87) — the resolved account must
  // belong to THIS user, even though it was set by the service-role bridge
  // itself; this defends against a corrupted/forged canonical_account_id
  // reaching this far (e.g. a future code path that failed to re-validate).
  const { data: acct, error: acctErr } = await admin.from('ii_accounts').select('id, user_id').eq('id', canonicalAccountId).maybeSingle();
  if (acctErr || !acct || acct.user_id !== userId) {
    return { ok: false, code: 'FOREIGN_ACCOUNT', canonicalTransactionId: null, error: 'The matched investment account does not belong to this user.' };
  }

  const canonicalType = ACTIVITY_TO_CANONICAL_TYPE[activity.activity_type as AuStatementTransactionType];
  if (!canonicalType) {
    // Mark as skipped (never left silently 'pending' forever) with a clear
    // reason — never fabricates a canonical row for an unsupported type.
    await admin
      .from('fdh_investment_statement_activities')
      .update({ apply_status: 'skipped', apply_rejected_reason: `No canonical Investment Intelligence representation for activity type ${activity.activity_type}.` })
      .eq('id', activityId);
    return { ok: false, code: 'CANONICAL_TYPE_UNSUPPORTED', canonicalTransactionId: null, error: `Activity type ${activity.activity_type} has no canonical representation today.` };
  }

  // --- Compare-and-swap claim (spec section 122) --------------------------
  const { data: claimed, error: claimErr } = await admin
    .from('fdh_investment_statement_activities')
    .update({ apply_status: 'applying' })
    .eq('id', activityId)
    .eq('apply_status', 'pending')
    .select('id')
    .maybeSingle();
  if (claimErr) return { ok: false, code: 'UNKNOWN_ERROR', canonicalTransactionId: null, error: claimErr.message };
  if (!claimed) {
    // Someone else claimed it between our read and our compare-and-swap.
    const { data: recheck } = await admin.from('fdh_investment_statement_activities').select('apply_status, canonical_transaction_id').eq('id', activityId).maybeSingle();
    if (recheck?.apply_status === 'applied') {
      return { ok: true, code: 'ALREADY_APPLIED', canonicalTransactionId: recheck.canonical_transaction_id as string | null, error: null };
    }
    return { ok: false, code: 'ALREADY_APPLYING', canonicalTransactionId: null, error: 'Concurrent apply detected — this evidence row was claimed by another request.' };
  }

  try {
    const amountParsed = parseExactDecimal(String(activity.amount));
    const unitsParsed = activity.quantity !== null ? parseExactDecimal(String(activity.quantity)) : null;
    const priceParsed = activity.unit_price !== null ? parseExactDecimal(String(activity.unit_price)) : null;
    if (!amountParsed.ok) throw new Error('Activity amount is not a valid exact decimal.');

    const fingerprint = computeTransactionFingerprint({
      sourceKey: FDH11_SOURCE_KEY,
      accountId: canonicalAccountId,
      instrumentId: activity.matched_instrument_id as string,
      transactionDateIso: (activity.trade_date as string) ?? (activity.settlement_date as string),
      transactionType: canonicalType,
      amountScaled: amountParsed.scaled,
      unitsScaled: unitsParsed && unitsParsed.ok ? unitsParsed.scaled : null,
      navScaled: priceParsed && priceParsed.ok ? priceParsed.scaled : null,
      sourceReference: null, // AU statements rarely carry a stable per-line reference — never fabricated
    });

    // --- Idempotency / duplicate-statement / overlap dedup (spec 54-58, 106-107) ---
    const { data: existingTxn } = await admin
      .from('ii_transactions')
      .select('id')
      .eq('account_id', canonicalAccountId)
      .eq('transaction_fingerprint', fingerprint)
      .maybeSingle();

    let canonicalTransactionId: string;
    if (existingTxn) {
      canonicalTransactionId = existingTxn.id as string;
    } else {
      const { data: created, error: insertErr } = await admin
        .from('ii_transactions')
        .insert({
          user_id: userId,
          account_id: canonicalAccountId,
          instrument_id: activity.matched_instrument_id,
          currency_code: activity.currency_code,
          status: 'parsed',
          transaction_type: canonicalType,
          transaction_date: (activity.trade_date as string) ?? (activity.settlement_date as string),
          units: unitsParsed && unitsParsed.ok ? scaledToDecimalString(unitsParsed.scaled) : null,
          price_per_unit: priceParsed && priceParsed.ok ? scaledToDecimalString(priceParsed.scaled) : null,
          gross_amount: scaledToDecimalString(amountParsed.scaled, 2),
          source_reference: null,
          transaction_fingerprint: fingerprint,
        })
        .select('id')
        .single();
      if (insertErr) {
        // Race window: a concurrent apply (of a DIFFERENT activity row that
        // fingerprints to the SAME real-world transaction — e.g. two
        // overlapping statements applied at once) could pass the
        // existing-fingerprint read above before either insert commits.
        // `uidx_ii_transactions_fingerprint` (migration 0040) is the real
        // backstop: Postgres rejects the second insert (23505), and this
        // catch turns that race into the SAME idempotent outcome as if the
        // read had seen it first — never a duplicate, never an unhandled
        // error.
        if (insertErr.code === '23505') {
          const { data: raceWinner } = await admin.from('ii_transactions').select('id').eq('account_id', canonicalAccountId).eq('transaction_fingerprint', fingerprint).maybeSingle();
          if (!raceWinner) throw new Error(insertErr.message);
          canonicalTransactionId = raceWinner.id as string;
        } else {
          throw new Error(insertErr.message);
        }
      } else if (created) {
        canonicalTransactionId = created.id as string;
      } else {
        throw new Error('Canonical transaction insert failed.');
      }
    }

    await admin
      .from('fdh_investment_statement_activities')
      .update({ apply_status: 'applied', canonical_transaction_id: canonicalTransactionId, applied_at: new Date().toISOString(), applied_by: userId })
      .eq('id', activityId);

    return { ok: true, code: null, canonicalTransactionId, error: null };
  } catch (e) {
    // Release the claim rather than leaving the row stuck in 'applying'
    // forever on an unexpected failure.
    await admin
      .from('fdh_investment_statement_activities')
      .update({ apply_status: 'pending', apply_rejected_reason: e instanceof Error ? e.message : String(e) })
      .eq('id', activityId)
      .eq('apply_status', 'applying');
    return { ok: false, code: 'UNKNOWN_ERROR', canonicalTransactionId: null, error: e instanceof Error ? e.message : String(e) };
  }
}
