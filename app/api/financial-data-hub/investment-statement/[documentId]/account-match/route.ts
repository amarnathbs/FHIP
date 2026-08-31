import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import { resolveAndPersistAuStatementAccount, confirmNewAuStatementAccount } from '@/lib/investment-import-bridge/auAccountResolution';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

const bodySchema = z.union([
  z.object({ action: z.literal('resolve'), account_type: z.string().default('broker'), currency_code: z.string().length(3) }),
  z.object({ action: z.literal('confirm_new'), institution_name: z.string().min(1), masked_account_identifier: z.string().nullish(), currency_code: z.string().length(3) }),
]);

// POST /api/financial-data-hub/investment-statement/{documentId}/account-match
// spec sections 43-46, 76. Existing account match (single_match) / no match
// (offers add new) / ambiguous (review required) — never auto-picked,
// never auto-created without the explicit `confirm_new` action.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return bad(body.error.issues[0]?.message ?? 'Invalid request', 422);

  const supabase = await createClient();
  const { data: statement } = await supabase.from('fdh_investment_statements').select('institution_name, masked_account_identifier').eq('id', statementId).eq('user_id', user.id).maybeSingle();

  if (body.data.action === 'confirm_new') {
    const created = await confirmNewAuStatementAccount(user.id, statementId, {
      institutionName: body.data.institution_name,
      maskedAccountIdentifier: body.data.masked_account_identifier ?? null,
      currencyCode: body.data.currency_code,
    });
    if (!created.accountId) return bad(created.error ?? 'Could not create investment account.', 500);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'add_new', accountId: created.accountId } });
    return ok({ outcome: 'add_new', account_id: created.accountId });
  }

  const result = await resolveAndPersistAuStatementAccount(user.id, statementId, {
    institutionName: statement?.institution_name ?? null,
    maskedAccountIdentifier: statement?.masked_account_identifier ?? null,
    accountType: body.data.account_type,
    currencyCode: body.data.currency_code,
    countryCode: 'AU',
  });
  if (result.error) return bad(result.error, 500);

  await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'system', metadata: { statementId, outcome: result.outcome, candidateIds: result.candidateIds } });

  return ok({ outcome: result.outcome, account_id: result.matchedAccountId, candidate_ids: result.candidateIds });
}
