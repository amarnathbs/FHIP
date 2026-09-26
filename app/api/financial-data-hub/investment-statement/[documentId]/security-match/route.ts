import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { resolveAndPersistAuSecurityMatch, createProvisionalAuSecurity, resolveAuSecurity, describeInstruments } from '@/lib/investment-import-bridge/auSecurityResolution';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';
import { createAdminClient } from '@/lib/supabase/admin';

const bodySchema = z.object({
  table: z.enum(['fdh_investment_statement_positions', 'fdh_investment_statement_activities']),
  row_id: z.string().uuid(),
  confirm_new_security: z.boolean().optional(),
  instrument_class: z.enum(['equity', 'etf', 'mutual_fund']).optional(),
  // WP-12 (INV-G3): the user's pick among the candidates an AMBIGUOUS match
  // offered. Accepted only if it is one of the candidates the server itself
  // recomputes for this row -- never an arbitrary instrument id.
  confirm_instrument_id: z.string().uuid().optional(),
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
  const { data: statement } = await supabase.from('fdh_investment_statements').select('approval_status').eq('id', statementId).eq('user_id', user.id).maybeSingle();
  // WP-12: an approved statement's matches are fixed -- changing a security
  // after approval would apply a line the user never reviewed against it.
  if (statement?.approval_status === 'approved') return bad('This statement is already approved.', 409, 'ALREADY_APPROVED');

  const isPositionsTable = body.data.table === 'fdh_investment_statement_positions';
  const { data: rowData, error: rowErr } = isPositionsTable
    ? await supabase.from(body.data.table).select('isin, ticker_raw, exchange, security_name_raw').eq('id', body.data.row_id).eq('statement_id', statementId).eq('user_id', user.id).maybeSingle()
    : await supabase.from(body.data.table).select('isin, ticker_raw, security_name_raw').eq('id', body.data.row_id).eq('statement_id', statementId).eq('user_id', user.id).maybeSingle();
  if (rowErr) return bad(rowErr.message, 500);
  if (!rowData) return bad('Evidence row not found on this statement.', 404);
  const row = rowData as { isin: string | null; ticker_raw: string | null; security_name_raw: string | null; exchange?: string | null };
  const admin = createAdminClient();

  if (body.data.confirm_new_security) {
    if (!row.security_name_raw && !row.ticker_raw) return bad('This line has no security name or code to create a security from.', 422);
    const created = await createProvisionalAuSecurity({
      instrumentName: (row.security_name_raw ?? row.ticker_raw) as string,
      instrumentClass: body.data.instrument_class ?? 'equity',
      isin: row.isin ?? undefined,
      asxTicker: row.ticker_raw ?? undefined,
    });
    if (!created.instrumentId) return bad(created.error ?? 'Could not create security.', 500);
    await admin.from(body.data.table).update({ security_match_status: 'matched', matched_instrument_id: created.instrumentId }).eq('id', body.data.row_id).eq('user_id', user.id);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_security_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'created_provisional', instrumentId: created.instrumentId } });
    return ok({ outcome: 'matched', matched_instrument_id: created.instrumentId, created: true });
  }

  const query = { isin: row.isin ?? undefined, tickerRaw: row.ticker_raw ?? undefined, exchange: row.exchange ?? 'ASX' };

  if (body.data.confirm_instrument_id) {
    const recomputed = await resolveAuSecurity(query);
    if (recomputed.error) return bad(recomputed.error, 500);
    if (!recomputed.candidateInstrumentIds.includes(body.data.confirm_instrument_id)) {
      return bad('That security is not one of the matches found for this line.', 422, 'NOT_A_CANDIDATE');
    }
    await admin.from(body.data.table).update({ security_match_status: 'matched', matched_instrument_id: body.data.confirm_instrument_id }).eq('id', body.data.row_id).eq('user_id', user.id);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_security_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'user_picked_candidate', instrumentId: body.data.confirm_instrument_id } });
    return ok({ outcome: 'matched', matched_instrument_id: body.data.confirm_instrument_id });
  }

  const result = await resolveAndPersistAuSecurityMatch(user.id, body.data.table, body.data.row_id, query);
  if (result.error) return bad(result.error, 500);

  await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_security_matched', actorType: 'system', metadata: { statementId, outcome: result.outcome } });

  return ok({
    outcome: result.outcome,
    matched_instrument_id: result.matchedInstrumentId,
    candidate_instrument_ids: result.candidateInstrumentIds,
    // WP-12 (INV-G3): names for the ambiguous-candidate picker.
    candidates: result.outcome === 'ambiguous' ? await describeInstruments(result.candidateInstrumentIds) : [],
  });
}
