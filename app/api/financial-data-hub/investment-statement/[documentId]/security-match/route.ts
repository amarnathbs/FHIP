import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { resolveAndPersistAuSecurityMatch, createProvisionalAuSecurity } from '@/lib/investment-import-bridge/auSecurityResolution';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { createAdminClient } from '@/lib/supabase/admin';

const bodySchema = z.object({
  table: z.enum(['fdh_investment_statement_positions', 'fdh_investment_statement_activities']),
  row_id: z.string().uuid(),
  confirm_new_security: z.boolean().optional(),
  instrument_class: z.enum(['equity', 'etf', 'mutual_fund']).optional(),
});

// POST /api/financial-data-hub/investment-statement/{documentId}/security-match
// spec sections 39-42, 90, 104. ISIN/ASX-ticker matching only — no
// fuzzy-name tier. `confirm_new_security: true` is the ONLY path that
// creates a new provisional ii_instruments row (spec section 42).
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return bad(body.error.issues[0]?.message ?? 'Invalid request', 422);

  // `exchange` exists only on fdh_investment_statement_positions (migration
  // 0106) — fdh_investment_statement_activities has no such column.
  // Selecting it unconditionally on both tables silently failed the query
  // (PostgREST rejects an unknown column) and this route mistook that
  // failure for "row not found" 404 — reproduced live, fixed here by
  // selecting per-table.
  const supabase = await createClient();
  const isPositionsTable = body.data.table === 'fdh_investment_statement_positions';
  const { data: rowData, error: rowErr } = isPositionsTable
    ? await supabase.from(body.data.table).select('isin, ticker_raw, exchange, security_name_raw').eq('id', body.data.row_id).eq('statement_id', statementId).eq('user_id', user.id).maybeSingle()
    : await supabase.from(body.data.table).select('isin, ticker_raw, security_name_raw').eq('id', body.data.row_id).eq('statement_id', statementId).eq('user_id', user.id).maybeSingle();
  if (rowErr) return bad(rowErr.message, 500);
  if (!rowData) return bad('Evidence row not found on this statement.', 404);
  const row = rowData as { isin: string | null; ticker_raw: string | null; security_name_raw: string; exchange?: string | null };

  if (body.data.confirm_new_security) {
    const created = await createProvisionalAuSecurity({
      instrumentName: row.security_name_raw as string,
      instrumentClass: body.data.instrument_class ?? 'equity',
      isin: (row.isin as string | null) ?? undefined,
      asxTicker: (row.ticker_raw as string | null) ?? undefined,
    });
    if (!created.instrumentId) return bad(created.error ?? 'Could not create security.', 500);
    const admin = createAdminClient();
    await admin.from(body.data.table).update({ security_match_status: 'matched', matched_instrument_id: created.instrumentId }).eq('id', body.data.row_id);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_security_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'created_provisional', instrumentId: created.instrumentId } });
    return ok({ outcome: 'matched', matched_instrument_id: created.instrumentId, created: true });
  }

  const result = await resolveAndPersistAuSecurityMatch(user.id, body.data.table, body.data.row_id, {
    isin: (row.isin as string | null) ?? undefined,
    tickerRaw: (row.ticker_raw as string | null) ?? undefined,
    exchange: (row.exchange as string | null) ?? 'ASX',
  });
  if (result.error) return bad(result.error, 500);

  await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_security_matched', actorType: 'system', metadata: { statementId, outcome: result.outcome } });

  return ok({ outcome: result.outcome, matched_instrument_id: result.matchedInstrumentId, candidate_instrument_ids: result.candidateInstrumentIds });
}
