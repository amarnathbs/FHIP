/**
 * WP-11 (G4): the card/loan repayment BACK-MATCH, registered in
 * POST_BANK_APPROVAL_MATCHERS.
 *
 * WHY. A statement repayment is matched to its bank debit only once, at
 * extraction time. When the card/loan statement is imported BEFORE the bank
 * statement that paid it (the common order), the repayment stays
 * 'bank_evidence_not_available' for ever and the bank debit is never known to
 * be a transfer. This matcher runs after every successful bank-statement
 * approval, finds the approved debits of THAT statement that settle an open
 * repayment, and records the match through `fdh10_match_liability_payment`
 * ('bank_back_match', migration 0209) -- which re-verifies the debit and, when
 * the repayment is already in the ledger, writes the confirmed settlement link
 * and reclassifies the bank leg to 'transfer' in one transaction.
 *
 * THE MATCHING RULE IS THE CERTIFIED ONE (`matchBankPayment`, bankMatching.ts):
 * never amount alone -- the debit's narrative must name the lender -- and more
 * than one plausible debit is never auto-picked. In addition, a debit that
 * would settle two repayments is not matched to either (one bank debit, one
 * repayment; the 0208 unique index is the backstop).
 *
 * This file imports FDH module code on purpose (the certified matcher and the
 * pagination helper), so it is allow-listed by name in
 * tests/unit/fdh1Isolation.test.ts, exactly like lib/investment-import-bridge/.
 */
import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';
import { matchBankPayment, type BankTransactionCandidate } from '@/lib/financial-data-hub/liability/bankMatching';
import type { PostBankApprovalMatcher, PostBankApprovalMatcherOutcome } from './postBankApprovalMatchers';

export interface OpenRepayment {
  id: string;
  statement_id: string;
  activity_type: string;
  activity_date: string;
  amount: number;
  currency_code: string;
}

export interface ApprovedBankDebit {
  id: string;
  transaction_date: string;
  amount_original: number;
  currency_original: string;
  description_clean: string | null;
  description_raw: string | null;
  merchant_raw: string | null;
}

/** Statuses of a repayment that has no bank debit yet. */
export const OPEN_REPAYMENT_MATCH_STATUSES = ['bank_evidence_not_available', 'no_match', 'not_attempted'] as const;

/**
 * Pure: which (repayment, debit) pairs to record. One-to-one on both sides;
 * a debit claimed by two repayments is dropped for both.
 */
export function planLiabilityBackMatches(
  repayments: readonly OpenRepayment[],
  debits: readonly ApprovedBankDebit[],
  institutionByStatement: ReadonlyMap<string, string | null>,
): { activityId: string; bankTransactionId: string }[] {
  const proposed: { activityId: string; bankTransactionId: string }[] = [];
  for (const r of repayments) {
    const institution = institutionByStatement.get(r.statement_id)?.trim().toLowerCase() || null;
    const candidates: BankTransactionCandidate[] = debits
      .filter((d) => d.currency_original === r.currency_code)
      .map((d) => {
        const narrative = `${d.description_clean ?? ''} ${d.description_raw ?? ''} ${d.merchant_raw ?? ''}`.toLowerCase();
        return {
          transactionId: d.id,
          amount: Number(d.amount_original),
          transactionDate: d.transaction_date,
          institutionOrNarrativeMatches: Boolean(institution && narrative.includes(institution)),
          positivelyWrongFacility: false,
        };
      });
    const match = matchBankPayment({ paymentAmount: Number(r.amount), paymentDate: r.activity_date, currencyCode: r.currency_code }, candidates);
    if (match.outcome === 'matched' && match.matchedTransactionId) proposed.push({ activityId: r.id, bankTransactionId: match.matchedTransactionId });
  }
  const claims = new Map<string, number>();
  for (const p of proposed) claims.set(p.bankTransactionId, (claims.get(p.bankTransactionId) ?? 0) + 1);
  return proposed.filter((p) => claims.get(p.bankTransactionId) === 1);
}

export const liabilityBankBackMatcher: PostBankApprovalMatcher = {
  id: 'wp11_liability_repayment_back_match',
  ownerWp: 'WP-11',
  async run({ userId, statementUploadId }): Promise<PostBankApprovalMatcherOutcome> {
    const supabase = await createClient();
    const debits = await fetchAllRows<ApprovedBankDebit>(() =>
      supabase
        .from('fdh_transactions')
        .select('id, transaction_date, amount_original, currency_original, description_clean, description_raw, merchant_raw')
        .eq('user_id', userId)
        .eq('statement_upload_id', statementUploadId)
        .eq('credit_debit', 'debit')
        .eq('approval_status', 'approved')
        .not('dedup_status', 'in', '(duplicate_confirmed,user_confirmed_duplicate)')
        .order('id', { ascending: true }),
    );
    if (debits.length === 0) return { linked: 0, reclassified: 0 };

    const repayments = await fetchAllRows<OpenRepayment>(() =>
      supabase
        .from('fdh_liability_statement_activities')
        .select('id, statement_id, activity_type, activity_date, amount, currency_code')
        .eq('user_id', userId)
        .in('activity_type', ['PAYMENT', 'PRINCIPAL'])
        .in('bank_match_status', [...OPEN_REPAYMENT_MATCH_STATUSES])
        .or('ledger_disposition.is.null,ledger_disposition.eq.ledger_row')
        .order('id', { ascending: true }),
    );
    if (repayments.length === 0) return { linked: 0, reclassified: 0 };

    const statementIds = [...new Set(repayments.map((r) => r.statement_id))];
    const institutionByStatement = new Map<string, string | null>();
    for (let i = 0; i < statementIds.length; i += 200) {
      const { data, error } = await supabase
        .from('fdh_liability_statements')
        .select('id, institution_name, approval_status, ledger_status')
        .eq('user_id', userId)
        .in('id', statementIds.slice(i, i + 200));
      if (error) throw new Error(error.message);
      for (const s of (data ?? []) as Array<{ id: string; institution_name: string | null; approval_status: string; ledger_status: string }>) {
        // Only statements the user approved and did not reject.
        if (s.approval_status === 'approved' && s.ledger_status !== 'rejected') institutionByStatement.set(s.id, s.institution_name);
      }
    }
    const eligible = repayments.filter((r) => institutionByStatement.has(r.statement_id));

    let linked = 0;
    let reclassified = 0;
    for (const pair of planLiabilityBackMatches(eligible, debits, institutionByStatement)) {
      const { data, error } = await supabase.rpc('fdh10_match_liability_payment', {
        p_activity_id: pair.activityId,
        p_bank_transaction_id: pair.bankTransactionId,
        p_method: 'bank_back_match',
      });
      if (error) throw Object.assign(new Error('fdh10_match_liability_payment failed'), { code: error.code ?? 'RPC_ERROR' });
      const result = data as { ok: boolean; link?: string | null };
      if (!result.ok) continue; // re-verification refused it (already matched, out of window, ...): nothing written
      linked += 1;
      if (result.link?.endsWith('+reclassified')) reclassified += 1;
    }
    return { linked, reclassified };
  },
};

/**
 * GOLDEN PAIR GP-D2 (live DEV, 2026-09-27): the FORWARD match -- the other order.
 *
 * The back-match above runs when a BANK statement is approved, and only for card/loan statements that
 * are ALREADY approved. Extraction-time matching only sees APPROVED bank debits. So when the user
 * uploads both, approves the BANK statement first and the card/loan statement afterwards, neither
 * step ever links the repayment: the bank debit keeps whatever the user typed it as (for example
 * "Loan Principal Repayment", which then shows on the Expenses tab next to the loan's own principal
 * line) and the settlement link is never written. Proven live on DEV: the loan's $2,000 repayment
 * stayed 'bank_evidence_not_available' after both approvals and the Apply reported linksCreated 0.
 *
 * This runs when a card/loan statement is approved: every still-open repayment on THAT statement is
 * matched against the user's approved bank debits with the SAME certified rule (planLiabilityBackMatches:
 * amount + date tolerance + the lender named in the narrative, never an auto-pick between two debits,
 * never one debit for two repayments) and recorded through the SAME re-verifying RPC. A debit that
 * already settles another repayment is never offered.
 */
export async function runLiabilityStatementForwardMatch(userId: string, statementId: string): Promise<PostBankApprovalMatcherOutcome> {
  const supabase = await createClient();
  const { data: statement, error: stErr } = await supabase
    .from('fdh_liability_statements')
    .select('id, institution_name, approval_status, ledger_status')
    .eq('user_id', userId)
    .eq('id', statementId)
    .maybeSingle();
  if (stErr) throw new Error(stErr.message);
  const st = statement as { id: string; institution_name: string | null; approval_status: string; ledger_status: string } | null;
  if (!st || st.approval_status !== 'approved' || st.ledger_status === 'rejected') return { linked: 0, reclassified: 0 };

  const repayments = await fetchAllRows<OpenRepayment>(() =>
    supabase
      .from('fdh_liability_statement_activities')
      .select('id, statement_id, activity_type, activity_date, amount, currency_code')
      .eq('user_id', userId)
      .eq('statement_id', statementId)
      .in('activity_type', ['PAYMENT', 'PRINCIPAL'])
      .in('bank_match_status', [...OPEN_REPAYMENT_MATCH_STATUSES])
      .or('ledger_disposition.is.null,ledger_disposition.eq.ledger_row')
      .order('id', { ascending: true }),
  );
  if (repayments.length === 0) return { linked: 0, reclassified: 0 };

  const shift = (d: string, days: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + days); return t.toISOString().slice(0, 10); };
  const dates = repayments.map((r) => r.activity_date).sort();
  const currencies = [...new Set(repayments.map((r) => r.currency_code))];
  const debits = await fetchAllRows<ApprovedBankDebit & { dedup_status?: string }>(() =>
    supabase
      .from('fdh_transactions')
      .select('id, transaction_date, amount_original, currency_original, description_clean, description_raw, merchant_raw')
      .eq('user_id', userId)
      .eq('credit_debit', 'debit')
      .eq('approval_status', 'approved')
      .in('currency_original', currencies)
      .gte('transaction_date', shift(dates[0], -7))
      .lte('transaction_date', shift(dates[dates.length - 1], 7))
      .not('dedup_status', 'in', '(duplicate_confirmed,user_confirmed_duplicate)')
      .order('id', { ascending: true }),
  );
  if (debits.length === 0) return { linked: 0, reclassified: 0 };

  // A debit that already settles another repayment is never a candidate.
  const taken = new Set<string>();
  const ids = debits.map((d) => d.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('fdh_liability_statement_activities')
      .select('linked_transaction_id')
      .eq('user_id', userId)
      .eq('bank_match_status', 'matched')
      .in('linked_transaction_id', ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const t of (data ?? []) as Array<{ linked_transaction_id: string | null }>) if (t.linked_transaction_id) taken.add(t.linked_transaction_id);
  }
  const free = debits.filter((d) => !taken.has(d.id));

  let linked = 0;
  let reclassified = 0;
  for (const pair of planLiabilityBackMatches(repayments, free, new Map([[st.id, st.institution_name]]))) {
    const { data, error } = await supabase.rpc('fdh10_match_liability_payment', {
      p_activity_id: pair.activityId,
      p_bank_transaction_id: pair.bankTransactionId,
      p_method: 'bank_back_match',
    });
    if (error) throw Object.assign(new Error('fdh10_match_liability_payment failed'), { code: error.code ?? 'RPC_ERROR' });
    const result = data as { ok: boolean; link?: string | null };
    if (!result.ok) continue;
    linked += 1;
    if (result.link?.endsWith('+reclassified')) reclassified += 1;
  }
  return { linked, reclassified };
}
