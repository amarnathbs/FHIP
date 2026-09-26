/**
 * WP-09 (GAP-10) -- re-match payslips to salary credits when a bank statement
 * is approved.
 *
 * WHY. A payslip is matched to its bank deposit once, when it is processed.
 * If the bank statement arrives (or is approved) LATER, the payslip stayed
 * `no_match` forever, so the payslip's Income row and the approved salary
 * credit were two income effects for one pay run. The canonical Income read
 * model (lib/read-models/income.ts) counts a corroborated credit ONCE -- it
 * needs the link. This matcher creates it, automatically, for every approved
 * statement: payslip 5,000 + bank 5,000 = one income event, by construction
 * rather than by a manual "tracked via import" tick.
 *
 * HOW. Registered in POST_BANK_APPROVAL_MATCHERS (the WP-01 seam), so it runs
 * after the three bank approval routes succeed. For the statement just
 * approved:
 *   1. its APPROVED INCOME CREDITS (paged -- no 1,000-row cap);
 *   2. this user's payslips paid within a week of those credits that have no
 *      deposit yet (not_attempted / no_match / multiple_candidates) and are
 *      not superseded;
 *   3. each payslip is scored by the SAME certified matcher processing uses
 *      (lib/<fdh>/payslip/bankMatch.ts: amount is necessary, never sufficient;
 *      exactly one corroborated candidate or nothing), against the credits no
 *      other payslip already claims;
 *   4. a match is written ONLY through fdh9_restamp_payroll_bank_match (0210),
 *      which re-checks ownership, approval, direction, currency, amount, date
 *      and one-deposit-one-pay-run inside the database and audits
 *      `payroll_bank_match_restamped`.
 * Idempotent: an already-matched payslip is never a candidate, so approving,
 * reopening and re-approving a statement links nothing twice.
 */
import { createClient } from '@/lib/supabase/server';
import { matchSalaryDeposit, type BankCandidate } from '@/lib/financial-data-hub/payslip/bankMatch';
import type { PostBankApprovalContext, PostBankApprovalMatcherOutcome } from './postBankApprovalMatchers';

type Client = Awaited<ReturnType<typeof createClient>>;

const PAGE = 1000;
/** The window processing uses to load candidates (payslipProcessingService). */
const WINDOW_DAYS = 7;
const UNMATCHED_STATUSES = ['not_attempted', 'no_match', 'multiple_candidates'];
const CREDIT_COLUMNS =
  'id, transaction_date, amount_original, currency_original, credit_debit, description_clean, description_raw, merchant_raw, economic_transaction_type, transaction_type_hint, financial_account_id';

interface UnmatchedPayslip {
  id: string;
  employer_name: string | null;
  currency_code: string;
  net_pay: number | null;
  payment_date: string | null;
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const daysApart = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

async function approvedIncomeCredits(client: Client, userId: string, statementUploadId: string): Promise<BankCandidate[]> {
  const out: BankCandidate[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('fdh_transactions')
      .select(CREDIT_COLUMNS)
      .eq('user_id', userId)
      .eq('statement_upload_id', statementUploadId)
      .eq('credit_debit', 'credit')
      .eq('approval_status', 'approved')
      .eq('economic_transaction_type', 'income')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw Object.assign(new Error('credits_read_failed'), { name: 'PayslipRematchReadError' });
    const rows = (data ?? []) as BankCandidate[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/** Runs the re-match for one approved statement. Never throws on "nothing to do". */
export async function runPayslipBankRematch(
  ctx: Pick<PostBankApprovalContext, 'userId' | 'statementUploadId'>,
  deps: { client?: Client } = {},
): Promise<PostBankApprovalMatcherOutcome> {
  const client = deps.client ?? (await createClient());
  const credits = await approvedIncomeCredits(client, ctx.userId, ctx.statementUploadId);
  if (credits.length === 0) return { linked: 0 };

  const dates = credits.map((c) => c.transaction_date).sort();
  const { data: eventRows, error: eventError } = await client
    .from('fdh_payroll_events')
    .select('id, employer_name, currency_code, net_pay, payment_date')
    .eq('user_id', ctx.userId)
    .in('bank_match_status', UNMATCHED_STATUSES)
    .is('superseded_by_payroll_event_id', null)
    .not('net_pay', 'is', null)
    .gte('payment_date', shiftDays(dates[0], -WINDOW_DAYS))
    .lte('payment_date', shiftDays(dates[dates.length - 1], WINDOW_DAYS))
    .order('payment_date', { ascending: true })
    .limit(500);
  if (eventError) throw Object.assign(new Error('payslips_read_failed'), { name: 'PayslipRematchReadError' });
  const payslips = (eventRows ?? []) as UnmatchedPayslip[];
  if (payslips.length === 0) return { linked: 0 };

  // Deposits another payslip already corroborates are not candidates.
  const { data: claimedRows, error: claimedError } = await client
    .from('fdh_payroll_events')
    .select('bank_match_transaction_id')
    .eq('user_id', ctx.userId)
    .in('bank_match_transaction_id', credits.map((c) => c.id));
  if (claimedError) throw Object.assign(new Error('claims_read_failed'), { name: 'PayslipRematchReadError' });
  const claimed = new Set(((claimedRows ?? []) as Array<{ bank_match_transaction_id: string | null }>).map((r) => r.bank_match_transaction_id));

  let linked = 0;
  for (const payslip of payslips) {
    if (payslip.net_pay == null || !payslip.payment_date) continue;
    const candidates = credits.filter((c) => !claimed.has(c.id) && daysApart(c.transaction_date, payslip.payment_date!) <= WINDOW_DAYS);
    if (candidates.length === 0) continue;
    const match = matchSalaryDeposit({
      netPay: Number(payslip.net_pay),
      currencyCode: payslip.currency_code,
      paymentDate: payslip.payment_date,
      employerName: payslip.employer_name ?? undefined,
      candidates,
    });
    if (match.status !== 'matched' || !match.transactionId) continue;
    const { data, error } = await client.rpc('fdh9_restamp_payroll_bank_match', {
      p_payroll_event_id: payslip.id,
      p_transaction_id: match.transactionId,
      p_confidence: match.confidence,
    });
    if (error) throw Object.assign(new Error('restamp_failed'), { name: 'PayslipRematchWriteError', code: error.code });
    const result = data as { ok: boolean; outcome?: string } | null;
    if (result?.ok) {
      claimed.add(match.transactionId);
      if (result.outcome === 'matched') linked += 1;
    }
  }
  return { linked };
}
