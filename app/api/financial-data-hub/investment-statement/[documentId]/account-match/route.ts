import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getUserFullExperienceHomeCountry } from '@/lib/services/jurisdiction';
import { getAuInvestmentStatementIdForDocument } from '@/lib/financial-data-hub/services/investmentStatementProcessingService';
import {
  resolveAndPersistAuStatementAccount,
  confirmNewAuStatementAccount,
  confirmExistingAuStatementAccount,
  setAuAccountOwner,
  describeAuAccounts,
  type AuAccountOwnerChoice,
} from '@/lib/investment-import-bridge/auAccountResolution';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

async function accountHasOwner(userId: string, accountId: string): Promise<boolean> {
  const [described] = await describeAuAccounts(userId, [accountId]);
  return Boolean(described?.ownerRecorded);
}

// WP-12 (INV-G10, PO D-10): who holds the account. `owner_member_id` is one
// of the user's own household members; `owner_self: true` means "me" (the
// member row is created on first use). Required on confirm_new.
const ownerFields = {
  owner_member_id: z.string().uuid().optional(),
  owner_self: z.literal(true).optional(),
};
const ownerOf = (b: { owner_member_id?: string; owner_self?: true }): AuAccountOwnerChoice | null =>
  b.owner_member_id ? { memberId: b.owner_member_id } : b.owner_self ? { self: true } : null;

const bodySchema = z.union([
  z.object({ action: z.literal('resolve'), account_type: z.string().default('broker'), currency_code: z.string().length(3) }),
  z.object({ action: z.literal('confirm_new'), institution_name: z.string().min(1), masked_account_identifier: z.string().nullish(), currency_code: z.string().length(3), ...ownerFields }),
  // WP-12 (INV-G3): the user picks one of the candidates an ambiguous match offered.
  z.object({ action: z.literal('confirm_existing'), account_id: z.string().uuid(), ...ownerFields }),
  // WP-12 (INV-G10): record the holder of the matched account when it has none.
  z.object({ action: z.literal('set_owner'), ...ownerFields }),
]);

// POST /api/financial-data-hub/investment-statement/{documentId}/account-match
// spec sections 43-46, 76. Existing account match (single_match) / no match
// (offers add new) / ambiguous (review required) — never auto-picked,
// never auto-created without the explicit `confirm_new` action.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();

  // G5-D2 fix: this endpoint used to hardcode countryCode: 'AU' on every
  // call, regardless of who was calling it. requireCountryConfirmedUser()
  // admits any FULL-experience country (AU or IN), so an IN user's own
  // statement could previously be matched/created against the AU-only
  // `ii_accounts` catalogue via lib/investment-import-bridge/
  // auAccountResolution.ts (itself deliberately AU-only by design — see its
  // own file header). Resolve the authoritative country server-side (never
  // trusted from the request body, never inferred from the statement's
  // currency_code) and fail closed with an explicit, honest
  // unavailable/manual-review response for anyone but AU, rather than
  // silently applying or creating a record under the wrong country. India
  // statements are certified only through the separate CAS-based Investment
  // Intelligence import (R1-R6), not this AU-only bridge.
  const homeCountry = await getUserFullExperienceHomeCountry(user.id, supabase);
  if (homeCountry !== 'AU') {
    return bad(
      'Automatic account matching for this statement type is only available for accounts confirmed in Australia. Please use manual review, or the CAS-based Investment Intelligence import for India statements.',
      403,
      'ACCOUNT_MATCH_UNAVAILABLE_FOR_COUNTRY'
    );
  }

  const statementId = await getAuInvestmentStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const body = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!body.success) return bad(body.error.issues[0]?.message ?? 'Invalid request', 422);

  const { data: statement } = await supabase.from('fdh_investment_statements').select('institution_name, masked_account_identifier, canonical_account_id, approval_status').eq('id', statementId).eq('user_id', user.id).maybeSingle();

  // An approved statement's account is fixed: re-pointing it now would send
  // lines already applied and lines still to apply to different accounts.
  if ((body.data.action === 'confirm_new' || body.data.action === 'confirm_existing') && statement?.approval_status === 'approved' && statement?.canonical_account_id) {
    return bad('This statement is already approved against an investment account.', 409, 'ALREADY_APPROVED');
  }

  if (body.data.action === 'confirm_new') {
    const owner = ownerOf(body.data);
    if (!owner) return bad('Choose who holds this account.', 422, 'OWNER_REQUIRED');
    const created = await confirmNewAuStatementAccount(user.id, statementId, {
      institutionName: body.data.institution_name,
      maskedAccountIdentifier: body.data.masked_account_identifier ?? null,
      currencyCode: body.data.currency_code,
      owner,
    });
    if (!created.accountId) return bad(created.error ?? 'Could not create investment account.', 400);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'add_new', accountId: created.accountId } });
    return ok({ outcome: 'add_new', account_id: created.accountId, owner_recorded: true });
  }

  if (body.data.action === 'confirm_existing') {
    const confirmed = await confirmExistingAuStatementAccount(user.id, statementId, body.data.account_id, ownerOf(body.data) ?? undefined);
    if (!confirmed.accountId) return bad(confirmed.error ?? 'Could not use that investment account.', 400);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'user_picked_existing', accountId: confirmed.accountId } });
    return ok({ outcome: 'single_match', account_id: confirmed.accountId, owner_recorded: await accountHasOwner(user.id, confirmed.accountId) });
  }

  if (body.data.action === 'set_owner') {
    const owner = ownerOf(body.data);
    if (!owner) return bad('Choose who holds this account.', 422, 'OWNER_REQUIRED');
    const accountId = (statement?.canonical_account_id as string | null) ?? null;
    if (!accountId) return bad('Match this statement to an investment account first.', 409);
    const set = await setAuAccountOwner(user.id, accountId, owner);
    if (!set.memberId) return bad(set.error ?? 'Could not record the account holder.', 400);
    await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'user', actorId: user.id, metadata: { statementId, outcome: 'owner_recorded', accountId } });
    return ok({ outcome: 'owner_recorded', account_id: accountId, owner_recorded: true });
  }

  // Already matched (by an earlier resolve, a pick or "Add as new account"):
  // report it rather than re-deciding and possibly reporting "no match".
  const existingAccountId = (statement?.canonical_account_id as string | null) ?? null;
  if (existingAccountId) {
    const [described] = await describeAuAccounts(user.id, [existingAccountId]);
    return ok({ outcome: 'single_match', account_id: existingAccountId, candidate_ids: [], candidates: described ? [described] : [], owner_recorded: Boolean(described?.ownerRecorded) });
  }

  const result = await resolveAndPersistAuStatementAccount(user.id, statementId, {
    institutionName: statement?.institution_name ?? null,
    maskedAccountIdentifier: statement?.masked_account_identifier ?? null,
    accountType: body.data.account_type,
    currencyCode: body.data.currency_code,
    // Resolved server-side above and proven === 'AU' before this point is
    // ever reached (never a request-provided or currency-derived value).
    countryCode: homeCountry,
  });
  if (result.error) return bad(result.error, 500);

  await recordDocumentAuditEvent({ userId: user.id, documentId, eventType: 'investment_statement_account_matched', actorType: 'system', metadata: { statementId, outcome: result.outcome, candidateIds: result.candidateIds } });

  // WP-12 (INV-G3): the candidates are described (institution + masked
  // identifier only) so an ambiguous match can be resolved by the user.
  const shown = result.outcome === 'single_match' && result.matchedAccountId ? [result.matchedAccountId] : result.candidateIds;
  const candidates = await describeAuAccounts(user.id, shown);
  return ok({
    outcome: result.outcome,
    account_id: result.matchedAccountId,
    candidate_ids: result.candidateIds,
    candidates,
    owner_recorded: result.matchedAccountId ? Boolean(candidates.find((c) => c.accountId === result.matchedAccountId)?.ownerRecorded) : false,
  });
}
