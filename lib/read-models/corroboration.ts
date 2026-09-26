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
import { fetchAllByIds, type ReadModelClient } from './core/paginate';
import { toMinor, type CorroborationEvidence, type CorroborationKind } from './core/spendingRules';

export interface CorroborationRef extends CorroborationEvidence {
  /** The statement / payroll event the evidence belongs to. */
  parentId: string | null;
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
    add(leg.id, { kind: 'payroll_event', sourceId: e.id, activityType: 'NET_PAY', parentId: e.id });
  }

  const activities: [CorroborationKind, ActivityEvidenceRow[], StatementApprovalRow[]][] = [
    ['liability_activity', raw.liabilityActivities, raw.liabilityStatements],
    ['investment_activity', raw.investmentActivities, raw.investmentStatements],
    ['retirement_activity', raw.retirementActivities, raw.retirementStatements],
  ];
  for (const [kind, rows, statements] of activities) {
    const approved = new Set(statements.filter((s) => s.approval_status === 'approved').map((s) => s.id));
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
      add(txnId, { kind, sourceId: a.id, activityType: a.activity_type, parentId: a.statement_id });
    }
  }
  return index;
}

/** Loads the evidence rows that point at any of the given bank legs. */
export async function loadCorroborationEvidence(userId: string, client: ReadModelClient, bankTxnIds: readonly string[]): Promise<RawCorroborationEvidence> {
  if (bankTxnIds.length === 0) return emptyCorroborationEvidence();
  const payroll = await fetchAllByIds<PayrollEvidenceRow>('fdh_payroll_events', bankTxnIds, (chunk, from, to) =>
    client
      .from('fdh_payroll_events')
      .select('id, bank_match_transaction_id, bank_match_status, approval_status, superseded_by_payroll_event_id, currency_code, net_pay')
      .eq('user_id', userId)
      .in('bank_match_transaction_id', chunk)
      .range(from, to),
  );
  const activity = (table: string) =>
    fetchAllByIds<ActivityEvidenceRow>(table, bankTxnIds, (chunk, from, to) =>
      client
        .from(table)
        .select('id, statement_id, activity_type, amount, currency_code, linked_transaction_id, bank_match_status')
        .eq('user_id', userId)
        .in('linked_transaction_id', chunk)
        .range(from, to),
    );
  const statements = (table: string, rows: ActivityEvidenceRow[]) =>
    fetchAllByIds<StatementApprovalRow>(table, rows.map((r) => r.statement_id), (chunk, from, to) =>
      client.from(table).select('id, approval_status').eq('user_id', userId).in('id', chunk).range(from, to),
    );
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
