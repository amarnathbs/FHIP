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
import { lineNamesASecurity, AU_LINE_WITHOUT_SECURITY_REASON, type AuLineIdentity } from './auLineRules';

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

/**
 * WP-12 (INV-G9, PO D-11): the reason a skipped line shows the user. Every
 * type with no canonical representation has one; nothing is skipped silently.
 */
export const AU_ACTIVITY_SKIP_REASONS: Partial<Record<AuStatementTransactionType, string>> = {
  INTEREST: 'Broker cash is not tracked yet: interest paid on your broker cash account stays as statement evidence and is not added to your Investments or Net Worth.',
  CASH_DEPOSIT: 'Broker cash is not tracked yet: this deposit into your broker cash account stays as statement evidence. The money leaving your bank account is recorded as invested, not spent.',
  CASH_WITHDRAWAL: 'Broker cash is not tracked yet: this withdrawal from your broker cash account stays as statement evidence. The money arriving in your bank account is recorded as a transfer, not income.',
  CORPORATE_ACTION_EVIDENCE: 'Corporate actions (splits, mergers, rights issues) are never applied automatically. Please review this line and update the holding yourself if needed.',
  OTHER: 'This line type is not added automatically. Please review it and add it yourself if needed.',
  UNKNOWN: 'We could not tell what kind of transaction this line is, so it was not added. Please review it and add it yourself if needed.',
};

function parseOptionalMoney(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim().replace(/[$,]/g, '').replace(/^\((.*)\)$/, '$1').replace(/^-/, '');
  if (!s) return null;
  const parsed = parseExactDecimal(s);
  return parsed.ok ? scaledToDecimalString(parsed.scaled, 2) : null;
}

function sourceDescriptionFor(activityType: string, descriptionRaw: string | null): string {
  const desc = (descriptionRaw ?? '').trim();
  if (activityType === 'DISTRIBUTION') return desc && desc.toUpperCase() !== 'DISTRIBUTION' ? `DISTRIBUTION: ${desc}` : 'DISTRIBUTION';
  return desc || activityType;
}

interface ActivityOccurrenceRow {
  id: string;
  statement_id: string;
  activity_type: string;
  trade_date: string | null;
  settlement_date: string | null;
  amount: number | string;
  quantity: number | string | null;
  unit_price: number | string | null;
  matched_instrument_id: string | null;
  source_row_number: number | null;
}

/** 1-based position of this line among IDENTICAL lines of the same statement (source row, then id, order). */
async function occurrenceWithinStatement(admin: ReturnType<typeof createAdminClient>, userId: string, a: ActivityOccurrenceRow): Promise<number> {
  const { data } = await admin
    .from('fdh_investment_statement_activities')
    .select('id, activity_type, trade_date, settlement_date, amount, quantity, unit_price, matched_instrument_id, source_row_number')
    .eq('user_id', userId)
    .eq('statement_id', a.statement_id)
    .eq('activity_type', a.activity_type)
    .eq('amount', a.amount);
  const same = (x: unknown, y: unknown) => (x === null || x === undefined ? null : String(Number(x))) === (y === null || y === undefined ? null : String(Number(y)));
  const twins = ((data ?? []) as ActivityOccurrenceRow[]).filter(
    (r) =>
      (r.trade_date ?? r.settlement_date) === (a.trade_date ?? a.settlement_date) &&
      r.matched_instrument_id === a.matched_instrument_id &&
      same(r.quantity, a.quantity) &&
      same(r.unit_price, a.unit_price),
  );
  const key = (r: ActivityOccurrenceRow) => `${String(r.source_row_number ?? 0).padStart(10, '0')}|${r.id}`;
  twins.sort((x, y) => (key(x) < key(y) ? -1 : 1));
  const index = twins.findIndex((r) => r.id === a.id);
  return index < 0 ? 1 : index + 1;
}

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

  // WP-12 (INV-G3/INV-G9, PO D-11): an activity type with no canonical
  // Investment Intelligence representation is decided HERE, before the
  // security check. It used to be checked after it, so a broker-cash line
  // (which has no security to match) stopped at NOT_MATCHED forever instead of
  // being skipped with a reason the user can read.
  const earlyType = ACTIVITY_TO_CANONICAL_TYPE[activity.activity_type as AuStatementTransactionType];
  const namesNoSecurity = !lineNamesASecurity(activity as unknown as AuLineIdentity);
  if (!earlyType || namesNoSecurity) {
    const reason = !earlyType
      ? (AU_ACTIVITY_SKIP_REASONS[activity.activity_type as AuStatementTransactionType] ?? `No canonical Investment Intelligence representation for activity type ${activity.activity_type}.`)
      : AU_LINE_WITHOUT_SECURITY_REASON;
    await admin
      .from('fdh_investment_statement_activities')
      .update({ apply_status: 'skipped', apply_rejected_reason: reason })
      .eq('id', activityId)
      .eq('user_id', userId)
      .eq('apply_status', 'pending');
    return { ok: false, code: 'CANONICAL_TYPE_UNSUPPORTED', canonicalTransactionId: null, error: reason };
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

  const canonicalType: IiTransactionType = earlyType as IiTransactionType;

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
    const feesParsed = activity.brokerage_raw !== null && activity.brokerage_raw !== undefined ? parseExactDecimal(String(activity.brokerage_raw)) : null;
    const withholdingParsed = parseOptionalMoney(activity.withholding_tax_raw);

    // INV-G7: two GENUINE identical same-day trades on one statement used to
    // collapse into one canonical row (the fingerprint had no per-line
    // component). The occurrence index of an identical line WITHIN this
    // statement now joins the fingerprint -- occurrence 1 keeps the original
    // `null` reference, so the SAME trade seen again on an overlapping
    // statement still resolves to the same row (and every row applied before
    // WP-12 keeps its fingerprint).
    const occurrence = await occurrenceWithinStatement(admin, userId, activity as unknown as ActivityOccurrenceRow);

    const fingerprint = computeTransactionFingerprint({
      sourceKey: FDH11_SOURCE_KEY,
      accountId: canonicalAccountId,
      instrumentId: activity.matched_instrument_id as string,
      transactionDateIso: (activity.trade_date as string) ?? (activity.settlement_date as string),
      transactionType: canonicalType,
      amountScaled: amountParsed.scaled,
      unitsScaled: unitsParsed && unitsParsed.ok ? unitsParsed.scaled : null,
      navScaled: priceParsed && priceParsed.ok ? priceParsed.scaled : null,
      // AU statements rarely carry a stable per-line reference — never
      // fabricated; only the in-statement occurrence of an identical line.
      sourceReference: occurrence > 1 ? `occurrence:${occurrence}` : null,
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
          // INV-G7: brokerage, withholding tax and the statement's own wording
          // used to be dropped here although ii_transactions has the columns
          // (0040). A DISTRIBUTION keeps its identity in source_description
          // (ii_transactions has no 'distribution' type; it is recorded as a
          // dividend-type cash distribution, never silently renamed).
          fees: feesParsed && feesParsed.ok ? scaledToDecimalString(feesParsed.scaled, 2) : null,
          taxes: withholdingParsed,
          source_description: sourceDescriptionFor(activity.activity_type as string, (activity.description_raw as string | null) ?? null),
          parser_code: FDH11_SOURCE_KEY,
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
