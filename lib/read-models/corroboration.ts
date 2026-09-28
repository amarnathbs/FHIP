/**
 * Corroboration index: which bank legs another APPROVED document already
 * accounts for (one financial fact -> one economic effect).
 *
 * Sources (all user-scoped, all require the evidence to be approved and the
 * match to be a real one-to-one bank match):
 *  - payroll:     fdh_payroll_events.bank_match_transaction_id -- the net-pay
 *                 credit of an approved, non-superseded payslip (GAP-01).
 *  - liability:   fdh_liability_statement_activities.linked_transaction_id --
 *                 the bank debit of a card/loan PAYMENT (G4).
 *  - investment:  fdh_investment_statement_activities.linked_transaction_id --
 *                 BUY funding debit, SELL proceeds / DIVIDEND credit (INV-G4).
 *  - retirement:  fdh_retirement_statement_activities.linked_transaction_id --
 *                 personal contribution debit, withdrawal / pension credit
 *                 (GAP-RET-07). Recorded for display only: re-bucketing a
 *                 retirement leg needs the user's confirmation (WP-13).
 *
 * Direction, currency and amount are re-checked here (the extraction-time
 * matchers do not always check them -- INV-G4 / G4), so a weak match can never
 * re-bucket a leg: a mismatch simply produces no corroboration.
 */
import { fetchAllRows, type ReadModelClient } from './core/paginate';
import { toMinor, type CorroborationEvidence, type CorroborationKind } from './core/spendingRules';

export interface CorroborationRef extends CorroborationEvidence {
  /** The statement / payroll event the evidence belongs to. */
  parentId: string | null;
  /** When that statement was approved (null when unknown / payroll). The ledger lets approved
   *  evidence re-bucket a user-decided line only when this is LATER than the user's last
   *  decision on the line (security/integrity review, the rule-9 residual). */
  approvedAt: string | null;
}

export interface BankLegFacts {
  id: string;
  credit_debit: string;
  currency_original: string;
  amount_original: number;
}

/** Raw evidence rows, as loaded. */
export interface PayrollEvidenceRow {
  id: string;
  bank_match_transaction_id: string | null;
  bank_match_status: string;
  approval_status: string;
  superseded_by_payroll_event_id: string | null;
  currency_code: string;
  net_pay: number | null;
}
export interface ActivityEvidenceRow {
  id: string;
  statement_id: string;
  activity_type: string;
  amount: number;
  currency_code: string;
  linked_transaction_id: string | null;
  bank_match_status: string;
}
export interface StatementApprovalRow {
  id: string;
  approval_status: string;
  approved_at?: string | null;
}

export interface RawCorroborationEvidence {
  payroll: PayrollEvidenceRow[];
  liabilityActivities: ActivityEvidenceRow[];
  liabilityStatements: StatementApprovalRow[];
  investmentActivities: ActivityEvidenceRow[];
  investmentStatements: StatementApprovalRow[];
  retirementActivities: ActivityEvidenceRow[];
  retirementStatements: StatementApprovalRow[];
}

export function emptyCorroborationEvidence(): RawCorroborationEvidence {
  return { payroll: [], liabilityActivities: [], liabilityStatements: [], investmentActivities: [], investmentStatements: [], retirementActivities: [], retirementStatements: [] };
}

/** Which bank direction each evidence activity type must have. */
const EXPECTED_DIRECTION: Record<CorroborationKind, Record<string, 'credit' | 'debit'>> = {
  payroll_event: {},
  liability_activity: { PAYMENT: 'debit' },
  investment_activity: { BUY: 'debit', SELL: 'credit', DIVIDEND: 'credit', DISTRIBUTION: 'credit', CASH_DEPOSIT: 'debit', CASH_WITHDRAWAL: 'credit', INTEREST: 'credit' },
  retirement_activity: { PERSONAL_CONTRIBUTION: 'debit', SALARY_SACRIFICE: 'debit', WITHDRAWAL: 'credit', PENSION_PAYMENT: 'credit' },
};

const amountsMatch = (a: number, b: number) => Math.abs(toMinor(a) - toMinor(b)) <= 100; // 0.01

/**
 * Builds bankTxnId -> evidence. Pure. Only one-to-one, approved, direction-,
 * currency- and amount-consistent evidence is indexed.
 */
export function buildCorroborationIndex(raw: RawCorroborationEvidence, bankLegs: readonly BankLegFacts[]): Map<string, CorroborationRef[]> {
  const legs = new Map(bankLegs.map((l) => [l.id, l] as const));
  const index = new Map<string, CorroborationRef[]>();
  const add = (txnId: string, ref: CorroborationRef) => {
    if (!index.has(txnId)) index.set(txnId, []);
    index.get(txnId)!.push(ref);
  };

  for (const e of raw.payroll) {
    if (!e.bank_match_transaction_id || e.bank_match_status !== 'matched') continue;
    if (e.approval_status !== 'approved' || e.superseded_by_payroll_event_id) continue;
    const leg = legs.get(e.bank_match_transaction_id);
    if (!leg || leg.credit_debit !== 'credit' || leg.currency_original !== e.currency_code) continue;
    add(leg.id, { kind: 'payroll_event', sourceId: e.id, activityType: 'NET_PAY', parentId: e.id, approvedAt: null });
  }

  const activities: [CorroborationKind, ActivityEvidenceRow[], StatementApprovalRow[]][] = [
    ['liability_activity', raw.liabilityActivities, raw.liabilityStatements],
    ['investment_activity', raw.investmentActivities, raw.investmentStatements],
    ['retirement_activity', raw.retirementActivities, raw.retirementStatements],
  ];
  for (const [kind, rows, statements] of activities) {
    const approved = new Set(statements.filter((s) => s.approval_status === 'approved').map((s) => s.id));
    const approvedAt = new Map(statements.map((s) => [s.id, s.approved_at ?? null] as const));
    // One-to-one: a bank leg claimed by two activities of the same kind is ambiguous -> not indexed.
    const claims = new Map<string, ActivityEvidenceRow[]>();
    for (const a of rows) {
      if (!a.linked_transaction_id || a.bank_match_status !== 'matched' || !approved.has(a.statement_id)) continue;
      if (!claims.has(a.linked_transaction_id)) claims.set(a.linked_transaction_id, []);
      claims.get(a.linked_transaction_id)!.push(a);
    }
    for (const [txnId, claimants] of claims) {
      if (claimants.length !== 1) continue;
      const a = claimants[0];
      const leg = legs.get(txnId);
      if (!leg || leg.currency_original !== a.currency_code || !amountsMatch(leg.amount_original, a.amount)) continue;
      const expected = EXPECTED_DIRECTION[kind][a.activity_type];
      if (!expected || leg.credit_debit !== expected) continue;
      add(txnId, { kind, sourceId: a.id, activityType: a.activity_type, parentId: a.statement_id, approvedAt: approvedAt.get(a.statement_id) ?? null });
    }
  }
  return index;
}

/**
 * Loads the evidence rows that point at any of the given bank legs.
 *
 * PERFORMANCE (mission section 9 / SPD-14): every query here is already
 * scoped to `user_id`, and each of these tables only ever holds a row for a
 * transaction that has actual matched evidence (a payroll bank-match, a
 * liability/investment/retirement activity link) -- a small, naturally
 * bounded subset of a user's transactions, never one row per transaction.
 * Fetching the whole per-user table (paged at 1000 rows) and filtering the
 * known bank-leg-id set client-side therefore replaces what used to be
 * ceil(bankTxnIds.length / 100) round trips PER TABLE (up to 10 each at a
 * 1,000-transaction window, x 7 tables here) with 1 round trip per table in
 * the overwhelmingly common case, with no change to which rows are returned
 * (the .not(...,'is',null) filters below narrow the payload, but the
 * client-side Set membership check is the actual correctness boundary, not
 * an assumption about row counts).
 */
export async function loadCorroborationEvidence(userId: string, client: ReadModelClient, bankTxnIds: readonly string[]): Promise<RawCorroborationEvidence> {
  if (bankTxnIds.length === 0) return emptyCorroborationEvidence();
  const bankIdSet = new Set(bankTxnIds);
  const payrollAll = await fetchAllRows<PayrollEvidenceRow>('fdh_payroll_events', (from, to) =>
    client
      .from('fdh_payroll_events')
      .select('id, bank_match_transaction_id, bank_match_status, approval_status, superseded_by_payroll_event_id, currency_code, net_pay')
      .eq('user_id', userId)
      .not('bank_match_transaction_id', 'is', null)
      .range(from, to),
  );
  const payroll = payrollAll.filter((r) => r.bank_match_transaction_id !== null && bankIdSet.has(r.bank_match_transaction_id));
  const activity = async (table: string) => {
    const rows = await fetchAllRows<ActivityEvidenceRow>(table, (from, to) =>
      client
        .from(table)
        .select('id, statement_id, activity_type, amount, currency_code, linked_transaction_id, bank_match_status')
        .eq('user_id', userId)
        .not('linked_transaction_id', 'is', null)
        .range(from, to),
    );
    return rows.filter((r) => r.linked_transaction_id !== null && bankIdSet.has(r.linked_transaction_id));
  };
  const statements = async (table: string, rows: ActivityEvidenceRow[]) => {
    const wantedIds = new Set(rows.map((r) => r.statement_id));
    if (wantedIds.size === 0) return [];
    const all = await fetchAllRows<StatementApprovalRow>(table, (from, to) =>
      client.from(table).select('id, approval_status, approved_at').eq('user_id', userId).range(from, to),
    );
    return all.filter((s) => wantedIds.has(s.id));
  };
  const liabilityActivities = await activity('fdh_liability_statement_activities');
  const investmentActivities = await activity('fdh_investment_statement_activities');
  const retirementActivities = await activity('fdh_retirement_statement_activities');
  return {
    payroll,
    liabilityActivities,
    liabilityStatements: await statements('fdh_liability_statements', liabilityActivities),
    investmentActivities,
    investmentStatements: await statements('fdh_investment_statements', investmentActivities),
    retirementActivities,
    retirementStatements: await statements('fdh_retirement_statements', retirementActivities),
  };
}
