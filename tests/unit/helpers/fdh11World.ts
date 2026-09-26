/**
 * The shared in-memory "world" for the WP-12 FDH-11 tests: column defaults as
 * the migrations define them (0106 + 0213), the unique keys the bridge relies
 * on, PostgREST's numeric-as-number read-back, and an emulation of 0207's
 * fdh_internal_reclassify_corroborated_leg.
 */
import { FakeDb, type Row } from './fdh11FakeDb';

export const USER = 'user-au-1';
export const OTHER = 'user-au-2';
export const DOC = 'doc-inv-1';

export const FDH11_DEFAULTS: Record<string, Row> = {
  fdh_investment_statements: { approval_status: 'pending', reconciliation_status: 'insufficient_data', canonical_account_id: null },
  // 0213's default; persistAuInvestmentEvidence also sets it explicitly.
  fdh_investment_statement_positions: { apply_status: 'pending', security_match_status: 'not_attempted', matched_instrument_id: null, apply_rejected_reason: null },
  fdh_investment_statement_activities: { apply_status: 'pending', bank_match_status: 'not_attempted', security_match_status: 'not_attempted', matched_instrument_id: null, linked_transaction_id: null },
  ii_accounts: { status: 'active', owner_member_id: null, source_document_id: null },
  ii_holding_snapshots: { quality_status: 'warning', source_document_id: null },
  household_members: { is_active: true },
  ii_instrument_identifiers: { is_active: true },
  investments: { is_active: true },
};

export const FDH11_UNIQUE: Record<string, string[][]> = {
  ii_transactions: [['account_id', 'transaction_fingerprint']],
  ii_holding_snapshots: [['account_id', 'instrument_id', 'as_of_date']],
  ii_fhip_publications: [['idempotency_key']],
};

/** numeric(...) columns: PostgREST reads a written decimal string back as a JSON number. */
export const FDH11_NUMERIC: Record<string, string[]> = {
  fdh_investment_statements: ['opening_portfolio_value', 'closing_portfolio_value', 'cash_balance'],
  fdh_investment_statement_positions: ['quantity', 'unit_price', 'market_value'],
  fdh_investment_statement_activities: ['quantity', 'unit_price', 'amount', 'brokerage_raw'],
  ii_holding_snapshots: ['units', 'value', 'source_nav'],
  ii_transactions: ['units', 'price_per_unit', 'gross_amount', 'fees', 'taxes'],
  investments: ['current_value', 'cost_base'],
  ii_fhip_publications: ['published_value'],
};

/** Emulates 0207's fdh_internal_reclassify_corroborated_leg (never overrides a user-settled row). */
export function reclassifyRpc(name: string, args: Row, db: FakeDb) {
  if (name !== 'fdh_internal_reclassify_corroborated_leg') return { data: null, error: { message: `unknown rpc ${name}` } };
  const t = db.rows('fdh_transactions').find((r) => r.id === args.p_txn && r.user_id === args.p_user);
  if (!t) return { data: null, error: { message: 'RECLASSIFY_NOT_FOUND' } };
  if (t.user_override) return { data: 'skipped_user_override', error: null };
  if (t.economic_transaction_type === args.p_new_type) return { data: 'unchanged', error: null };
  t.economic_transaction_type = args.p_new_type;
  return { data: 'reclassified', error: null };
}

export function world(extra: Record<string, Row[]> = {}): FakeDb {
  return new FakeDb(
    {
      user_profiles: [{ user_id: USER, full_name: 'Alex Citizen', preferred_currency: 'AUD', country_of_residence: 'AU' }],
      fdh_statement_uploads: [{ id: DOC, user_id: USER, document_type: 'investment_statement', processing_status: 'queued' }],
      ...extra,
    },
    { defaults: FDH11_DEFAULTS, unique: FDH11_UNIQUE, rpc: reclassifyRpc, numeric: FDH11_NUMERIC },
  );
}
