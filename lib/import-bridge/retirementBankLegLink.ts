/**
 * WP-13 (GAP-RET-07) -- the retirement <-> bank leg bridge.
 *
 * ONE FINANCIAL FACT, ONE ECONOMIC EFFECT. A personal super contribution
 * appears twice in the user's evidence: as a PERSONAL_CONTRIBUTION line on the
 * fund statement and as a debit on the bank statement ("BPAY AustralianSuper
 * $500"). Canonical Retirement is a balance register, so the fund side never
 * posts anything -- but the bank debit is an ordinary approved transaction,
 * and until it is recognised it counts as $500 of household SPENDING while the
 * same $500 also lifts the fund balance. The same shape in reverse: a pension
 * payment or withdrawal credit from the fund.
 *
 * Two pieces, both deliberately narrow:
 *
 *   1. `runRetirementBankRematch` -- registered in POST_BANK_APPROVAL_MATCHERS.
 *      When the user approves a bank statement AFTER the retirement statement
 *      was processed, the still-unmatched retirement lines are matched against
 *      the new bank lines with FDH-12's own certified matcher. It LINKS only;
 *      it never changes what a bank line counts as.
 *
 *   2. `confirmRetirementBankLeg` -- the user's explicit confirmation ("yes,
 *      this bank payment is my contribution into super"). It calls
 *      fdh12_confirm_retirement_bank_leg (migration 0211), which re-verifies
 *      the match and reclassifies the bank leg ONCE through the programme's
 *      shared helper: contribution / withdrawal -> transfer, pension payment
 *      -> income. A line the user categorised themselves is never overridden.
 *
 * The read models need no change: a 'transfer' leg is never spending
 * (lib/read-models/core/spendingRules.ts), so the $500 oracle gives household
 * expense 0 once confirmed.
 */
import { createClient } from '@/lib/supabase/server';
import { rematchRetirementActivitiesAfterBankApproval } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import type { PostBankApprovalContext, PostBankApprovalMatcherOutcome } from './postBankApprovalMatchers';

/** The post-bank-approval matcher (contract: postBankApprovalMatchers.ts). */
export async function runRetirementBankRematch(ctx: PostBankApprovalContext): Promise<PostBankApprovalMatcherOutcome> {
  const { linked } = await rematchRetirementActivitiesAfterBankApproval(ctx.userId);
  // Linking never reclassifies: that needs the user's confirmation.
  return { linked, reclassified: 0 };
}

export const RETIREMENT_BANK_LEG_REFUSAL_CODES = [
  'NOT_FOUND',
  'EVIDENCE_NOT_APPROVED',
  'SMSF_ACCOUNT_NOT_IMPORTABLE',
  'NOT_A_BANK_MOVEMENT',
  'NO_BANK_MATCH',
  'BANK_MATCH_INCONSISTENT',
] as const;
export type RetirementBankLegRefusalCode = (typeof RETIREMENT_BANK_LEG_REFUSAL_CODES)[number];

export type ConfirmRetirementBankLegResult =
  | {
    ok: true;
    code: 'CONFIRMED' | 'ALREADY_CONFIRMED';
    /** 'reclassified' | 'unchanged' | 'skipped_user_override' (absent when already confirmed). */
    outcome: string | null;
    newType: 'transfer' | 'income' | null;
    transactionId: string | null;
  }
  | { ok: false; code: RetirementBankLegRefusalCode | 'WRITE_FAILED'; error: string };

interface RpcResponse {
  ok: boolean;
  code?: string;
  error?: string;
  outcome?: string;
  new_type?: string;
  transaction_id?: string;
}

/** The user confirms one matched line. Runs as the USER (cookie client); the
 * RPC re-derives every check against live rows. */
export async function confirmRetirementBankLeg(activityId: string): Promise<ConfirmRetirementBankLegResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fdh12_confirm_retirement_bank_leg', { p_activity_id: activityId });
  if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message };
  const r = (data ?? {}) as RpcResponse;
  if (!r.ok) {
    const code = (RETIREMENT_BANK_LEG_REFUSAL_CODES as readonly string[]).includes(r.code ?? '')
      ? (r.code as RetirementBankLegRefusalCode)
      : 'WRITE_FAILED';
    return { ok: false, code, error: r.error ?? 'This bank payment could not be confirmed.' };
  }
  return {
    ok: true,
    code: r.code === 'ALREADY_CONFIRMED' ? 'ALREADY_CONFIRMED' : 'CONFIRMED',
    outcome: r.outcome ?? null,
    newType: r.new_type === 'transfer' || r.new_type === 'income' ? r.new_type : null,
    transactionId: r.transaction_id ?? null,
  };
}
