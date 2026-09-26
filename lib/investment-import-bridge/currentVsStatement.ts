/**
 * FDH-11 bridge — CURRENT (canonical) vs STATEMENT (evidence) comparison
 * (spec section 61). Read-only — never writes anything. Composes canonical
 * `ii_holding_snapshots` (the latest certified quantity per instrument for
 * the resolved account) against the statement's own position evidence, so
 * the review UX can show "+20 BHP explained by BUY" or "unexplained ->
 * REVIEW_REQUIRED" without ever silently overwriting a holding (spec
 * section 62).
 *
 * Canonical-upload WP-12 (INV-G11): both reads page past PostgREST's
 * 1000-row cap (they used to be unbounded single selects, so a large
 * statement or a long snapshot history was silently truncated), the snapshot
 * read is user-scoped, and the panel now shows this comparison before Apply.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { fetchAllRows } from '@/lib/services/investment-intelligence/pagination';

export interface CurrentVsStatementRow {
  instrumentId: string | null;
  securityNameRaw: string;
  currentQuantity: string | null;
  statementQuantity: string;
  matched: boolean;
}

export async function computeCurrentVsStatement(userId: string, statementId: string): Promise<{ accountId: string | null; rows: CurrentVsStatementRow[]; error: string | null }> {
  const admin = createAdminClient();
  const { data: statement, error: stmtErr } = await admin.from('fdh_investment_statements').select('canonical_account_id').eq('id', statementId).eq('user_id', userId).maybeSingle();
  if (stmtErr || !statement) return { accountId: null, rows: [], error: stmtErr?.message ?? 'Statement not found.' };
  const accountId = statement.canonical_account_id as string | null;

  let positions: { security_name_raw: string; quantity: number | string; matched_instrument_id: string | null }[];
  try {
    positions = await fetchAllRows(() =>
      admin
        .from('fdh_investment_statement_positions')
        .select('id, security_name_raw, quantity, matched_instrument_id, source_row_number')
        .eq('statement_id', statementId)
        .eq('user_id', userId)
        .order('source_row_number', { ascending: true })
        .order('id', { ascending: true }),
    );
  } catch (e) {
    return { accountId, rows: [], error: e instanceof Error ? e.message : String(e) };
  }

  const latestByInstrument = new Map<string, string>();
  if (accountId) {
    const snapshots = await fetchAllRows<{ instrument_id: string; units: number | string; as_of_date: string }>(() =>
      admin
        .from('ii_holding_snapshots')
        .select('id, instrument_id, units, as_of_date')
        .eq('user_id', userId)
        .eq('account_id', accountId)
        .order('as_of_date', { ascending: false })
        .order('id', { ascending: true }),
    );
    for (const s of snapshots) {
      if (!latestByInstrument.has(s.instrument_id)) latestByInstrument.set(s.instrument_id, String(s.units));
    }
  }

  const rows: CurrentVsStatementRow[] = positions.map((p) => ({
    instrumentId: p.matched_instrument_id ?? null,
    securityNameRaw: p.security_name_raw,
    currentQuantity: p.matched_instrument_id ? (latestByInstrument.get(p.matched_instrument_id) ?? null) : null,
    statementQuantity: String(p.quantity),
    matched: Boolean(p.matched_instrument_id),
  }));

  return { accountId, rows, error: null };
}
