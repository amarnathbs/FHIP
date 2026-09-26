/**
 * WP-11 (G7): the "Statement history" read model for one liability -- every
 * imported card/loan statement applied to it, every activity on each, and
 * WHAT EACH ACTIVITY BECAME (its canonical ledger row, the allocations of a
 * decomposed loan payment, the bank-settlement state), so imported evidence is
 * user-visible after Apply instead of disappearing with the import panel.
 *
 * Read-only, user-scoped (the caller passes the cookie client; every query is
 * also filtered by user_id). Every list is paged (PostgREST's 1000-row cap) and
 * any failed read fails CLOSED (ReadModelUnavailableError), never "no history".
 *
 * Which statements belong to the liability: those the ledger Apply linked
 * (fdh_liability_statements.liability_id, 0209) PLUS those applied or kept
 * against it before 0209 (via fhip_import_applications / a dismissed-with-
 * target proposal) -- the latter are the ones the user can still "record".
 */
import { fetchAllByIds, fetchAllRows, fetchOne, type ReadModelClient } from '@/lib/read-models/core/paginate';

export interface HistoryLedgerRow {
  transaction_id: string;
  credit_debit: 'credit' | 'debit';
  economic_transaction_type: string;
  amount: number;
  allocations: { economic_transaction_type: string; amount: number }[];
  /** Confirmed settlement from a bank debit (a repayment), if any. */
  settlement_link_status: 'confirmed' | 'pending' | null;
}

export interface HistoryActivity {
  id: string;
  activity_type: string;
  activity_date: string;
  amount: number;
  currency_code: string;
  description_raw: string | null;
  bank_match_status: string;
  ledger_disposition: string | null;
  ledger: HistoryLedgerRow | null;
}

export interface HistoryStatement {
  id: string;
  statement_upload_id: string | null;
  statement_type: string;
  institution_name: string | null;
  masked_identifier: string | null;
  statement_period_start: string | null;
  statement_period_end: string | null;
  currency_code: string;
  closing_balance: number | null;
  closing_principal: number | null;
  purchases_total: number | null;
  payments_total: number | null;
  interest_total: number | null;
  fees_total: number | null;
  drawdowns_total: number | null;
  principal_repayments_total: number | null;
  reconciliation_status: string;
  ledger_status: string;
  ledger_applied_at: string | null;
  ledger_rejected_reason: string | null;
  extraction_warnings: { code: string; row?: number; detail?: string }[];
  /** True when this statement was applied before 0209 and its activity can still be recorded. */
  can_record: boolean;
  activities: HistoryActivity[];
}

export interface LiabilityStatementHistory {
  liability: { id: string; liability_name: string; currency_code: string; source_type: string | null; last_imported_at: string | null };
  statements: HistoryStatement[];
}

const STATEMENT_COLUMNS = 'id, statement_upload_id, statement_type, institution_name, masked_identifier, statement_period_start, statement_period_end, currency_code, closing_balance, closing_principal, purchases_total, payments_total, interest_total, fees_total, drawdowns_total, principal_repayments_total, reconciliation_status, ledger_status, ledger_applied_at, ledger_rejected_reason, extraction_warnings, approval_status';

/** Returns null when the liability is not the user's (the route answers 404). */
export async function loadLiabilityStatementHistory(client: ReadModelClient, userId: string, liabilityId: string): Promise<LiabilityStatementHistory | null> {
  const liability = await fetchOne<LiabilityStatementHistory['liability']>('liabilities', () =>
    client.from('liabilities').select('id, liability_name, currency_code, source_type, last_imported_at').eq('id', liabilityId).eq('user_id', userId).maybeSingle());
  if (!liability) return null;

  const linked = await fetchAllRows<Record<string, unknown>>('fdh_liability_statements', (from, to) =>
    client.from('fdh_liability_statements').select(STATEMENT_COLUMNS).eq('user_id', userId).eq('liability_id', liabilityId).order('id', { ascending: true }).range(from, to));
  const applications = await fetchAllRows<{ source_liability_statement_id: string | null }>('fhip_import_applications', (from, to) =>
    client.from('fhip_import_applications').select('source_liability_statement_id').eq('user_id', userId).eq('target_domain', 'liability').eq('target_entity_id', liabilityId).order('id', { ascending: true }).range(from, to));
  const kept = await fetchAllRows<{ source_liability_statement_id: string | null }>('fhip_import_proposals', (from, to) =>
    client.from('fhip_import_proposals').select('source_liability_statement_id').eq('user_id', userId).eq('target_domain', 'liability').eq('target_entity_id', liabilityId).eq('status', 'dismissed').order('id', { ascending: true }).range(from, to));
  const known = new Set(linked.map((s) => s.id as string));
  const earlierIds = [...applications, ...kept].map((r) => r.source_liability_statement_id).filter((id): id is string => Boolean(id) && !known.has(id as string));
  const earlier = await fetchAllByIds<Record<string, unknown>>('fdh_liability_statements', earlierIds, (chunk, from, to) =>
    client.from('fdh_liability_statements').select(STATEMENT_COLUMNS).eq('user_id', userId).in('id', chunk).order('id', { ascending: true }).range(from, to));
  const statements = [...linked, ...earlier];

  const activities = await fetchAllByIds<Record<string, unknown>>('fdh_liability_statement_activities', statements.map((s) => s.id as string), (chunk, from, to) =>
    client
      .from('fdh_liability_statement_activities')
      .select('id, statement_id, activity_type, activity_date, amount, currency_code, description_raw, bank_match_status, ledger_disposition, ledger_transaction_id, ledger_duplicate_of_transaction_id, source_row_number')
      .eq('user_id', userId)
      .in('statement_id', chunk)
      .order('id', { ascending: true })
      .range(from, to));
  const ledgerIds = activities.map((a) => (a.ledger_transaction_id ?? a.ledger_duplicate_of_transaction_id) as string | null).filter((id): id is string => Boolean(id));
  const ledgerRows = await fetchAllByIds<{ id: string; credit_debit: 'credit' | 'debit'; economic_transaction_type: string; amount_original: number }>('fdh_transactions', ledgerIds, (chunk, from, to) =>
    client.from('fdh_transactions').select('id, credit_debit, economic_transaction_type, amount_original').eq('user_id', userId).in('id', chunk).order('id', { ascending: true }).range(from, to));
  const allocations = await fetchAllByIds<{ transaction_id: string; allocation_sequence: number; economic_transaction_type: string; amount: number }>('fdh_transaction_allocations', ledgerIds, (chunk, from, to) =>
    client.from('fdh_transaction_allocations').select('transaction_id, allocation_sequence, economic_transaction_type, amount').eq('user_id', userId).in('transaction_id', chunk).order('transaction_id', { ascending: true }).range(from, to));
  const links = await fetchAllByIds<{ transaction_id_to: string; status: string; link_type: string }>('fdh_transaction_links', ledgerIds, (chunk, from, to) =>
    client.from('fdh_transaction_links').select('transaction_id_to, status, link_type').eq('user_id', userId).in('transaction_id_to', chunk).order('transaction_id_to', { ascending: true }).range(from, to));

  const rowById = new Map(ledgerRows.map((r) => [r.id, r] as const));
  const allocationsById = new Map<string, { economic_transaction_type: string; amount: number; seq: number }[]>();
  for (const a of allocations) {
    if (!allocationsById.has(a.transaction_id)) allocationsById.set(a.transaction_id, []);
    allocationsById.get(a.transaction_id)!.push({ economic_transaction_type: a.economic_transaction_type, amount: Number(a.amount), seq: a.allocation_sequence });
  }
  const settlementById = new Map<string, 'confirmed' | 'pending'>();
  for (const l of links) {
    if (l.link_type !== 'credit_card_settlement' && l.link_type !== 'loan_payment') continue;
    if (l.status === 'confirmed' || (l.status === 'pending' && !settlementById.has(l.transaction_id_to))) settlementById.set(l.transaction_id_to, l.status as 'confirmed' | 'pending');
  }

  const activitiesByStatement = new Map<string, HistoryActivity[]>();
  const sorted = [...activities].sort((a, b) => (Number(a.source_row_number ?? 0) - Number(b.source_row_number ?? 0)) || String(a.id).localeCompare(String(b.id)));
  for (const a of sorted) {
    const ledgerId = (a.ledger_transaction_id as string | null) ?? null;
    const row = ledgerId ? rowById.get(ledgerId) : undefined;
    const item: HistoryActivity = {
      id: a.id as string,
      activity_type: a.activity_type as string,
      activity_date: a.activity_date as string,
      amount: Number(a.amount),
      currency_code: a.currency_code as string,
      description_raw: (a.description_raw as string | null) ?? null,
      bank_match_status: a.bank_match_status as string,
      ledger_disposition: (a.ledger_disposition as string | null) ?? null,
      ledger: row
        ? {
            transaction_id: row.id,
            credit_debit: row.credit_debit,
            economic_transaction_type: row.economic_transaction_type,
            amount: Number(row.amount_original),
            allocations: (allocationsById.get(row.id) ?? []).sort((x, y) => x.seq - y.seq).map(({ economic_transaction_type, amount }) => ({ economic_transaction_type, amount })),
            settlement_link_status: settlementById.get(row.id) ?? null,
          }
        : null,
    };
    const key = a.statement_id as string;
    if (!activitiesByStatement.has(key)) activitiesByStatement.set(key, []);
    activitiesByStatement.get(key)!.push(item);
  }

  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    liability,
    statements: statements
      .map((s) => ({
        id: s.id as string,
        statement_upload_id: (s.statement_upload_id as string | null) ?? null,
        statement_type: s.statement_type as string,
        institution_name: (s.institution_name as string | null) ?? null,
        masked_identifier: (s.masked_identifier as string | null) ?? null,
        statement_period_start: (s.statement_period_start as string | null) ?? null,
        statement_period_end: (s.statement_period_end as string | null) ?? null,
        currency_code: s.currency_code as string,
        closing_balance: num(s.closing_balance),
        closing_principal: num(s.closing_principal),
        purchases_total: num(s.purchases_total),
        payments_total: num(s.payments_total),
        interest_total: num(s.interest_total),
        fees_total: num(s.fees_total),
        drawdowns_total: num(s.drawdowns_total),
        principal_repayments_total: num(s.principal_repayments_total),
        reconciliation_status: s.reconciliation_status as string,
        ledger_status: (s.ledger_status as string | undefined) ?? 'not_applied',
        ledger_applied_at: (s.ledger_applied_at as string | null) ?? null,
        ledger_rejected_reason: (s.ledger_rejected_reason as string | null) ?? null,
        extraction_warnings: Array.isArray(s.extraction_warnings) ? (s.extraction_warnings as HistoryStatement['extraction_warnings']) : [],
        can_record: (s.ledger_status ?? 'not_applied') === 'not_applied' && s.approval_status === 'approved',
        activities: activitiesByStatement.get(s.id as string) ?? [],
      }))
      .sort((a, b) => String(b.statement_period_end ?? '').localeCompare(String(a.statement_period_end ?? '')) || a.id.localeCompare(b.id)),
  };
}
