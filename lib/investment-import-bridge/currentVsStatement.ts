/**
 * FDH-11 bridge — CURRENT (canonical) vs STATEMENT (evidence) comparison
 * (spec section 61). Read-only — never writes anything. Composes canonical
 * `ii_holding_snapshots` (the latest certified quantity per instrument for
 * the resolved account) against the statement's own position evidence, so
 * the review UX can show "+20 BHP explained by BUY" or "unexplained ->
 * REVIEW_REQUIRED" without ever silently overwriting a holding (spec
 * section 62).
 */

import { createAdminClient } from '@/lib/supabase/admin';

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

  const { data: positions, error: posErr } = await admin
    .from('fdh_investment_statement_positions')
    .select('security_name_raw, quantity, matched_instrument_id')
    .eq('statement_id', statementId)
    .eq('user_id', userId);
  if (posErr) return { accountId, rows: [], error: posErr.message };

  const latestByInstrument = new Map<string, string>();
  if (accountId) {
    const { data: snapshots } = await admin
      .from('ii_holding_snapshots')
      .select('instrument_id, units, as_of_date')
      .eq('account_id', accountId)
      .order('as_of_date', { ascending: false });
    for (const s of snapshots ?? []) {
      const key = s.instrument_id as string;
      if (!latestByInstrument.has(key)) latestByInstrument.set(key, String(s.units));
    }
  }

  const rows: CurrentVsStatementRow[] = (positions ?? []).map((p) => ({
    instrumentId: (p.matched_instrument_id as string | null) ?? null,
    securityNameRaw: p.security_name_raw as string,
    currentQuantity: p.matched_instrument_id ? (latestByInstrument.get(p.matched_instrument_id as string) ?? null) : null,
    statementQuantity: String(p.quantity),
    matched: Boolean(p.matched_instrument_id),
  }));

  return { accountId, rows, error: null };
}
