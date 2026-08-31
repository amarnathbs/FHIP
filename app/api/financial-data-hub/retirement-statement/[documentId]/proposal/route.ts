import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { retirementAdapter, type ExistingRetirementRow, type RetirementEvidence } from '@/lib/import-bridge/adapters/retirementAdapter';
import { persistRetirementProposal } from '@/lib/import-bridge/supabaseStore';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';
import { recordDocumentAuditEvent } from '@/lib/financial-data-hub/services/auditLog';

// POST /api/financial-data-hub/retirement-statement/{documentId}/proposal
//   -> generate the Current vs Proposed comparison
// GET  same path
//   -> read the live proposal back
//
// A PROPOSAL IS INERT (spec section 56). Generating one changes nothing in
// canonical Retirement. Only `fdh12_apply_retirement_proposal()`, reached
// through the sibling `/apply` route when the USER presses Apply, can.

async function loadEvidence(userId: string, statementId: string) {
  const supabase = await createClient();
  const { data: statement } = await supabase
    .from('fdh_retirement_statements')
    .select('*')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle();
  return statement;
}

export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const statement = await loadEvidence(user.id, statementId);
  if (!statement) return bad('That retirement statement could not be found.', 404);

  // SMSF NEVER REACHES THE BRIDGE (spec sections 10-11). Refused here as well
  // as at approval and inside the apply RPC — three independent refusals.
  if (statement.smsf_classification !== 'not_smsf') {
    return bad(
      'This looks like a self-managed super fund statement. SMSFs are managed in the SMSF section of the Retirement page.',
      409,
    );
  }
  // NO SILENT APPLY (spec section 56): evidence must be approved before a
  // proposal can be prepared from it.
  if (statement.approval_status !== 'approved') {
    return bad('Approve the statement evidence before comparing it with your retirement accounts.', 409);
  }

  const supabase = await createClient();

  const accounts = await fetchAllRows(() =>
    supabase
      .from('retirement_accounts')
      .select('id, account_name, account_type, current_balance, currency_code, country_code, owner, master_item_key, retirement_member_id, employer_contribution, personal_contribution, contribution_frequency, updated_at')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('id', { ascending: true }));

  // Which household member the statement resolved to. Read, never inferred.
  let memberType: 'self' | 'spouse' | undefined;
  if (statement.retirement_member_id) {
    const { data: member } = await supabase
      .from('retirement_members')
      .select('member_type')
      .eq('id', statement.retirement_member_id)
      .eq('user_id', user.id)
      .maybeSingle();
    memberType = (member?.member_type as 'self' | 'spouse' | undefined) ?? undefined;
  }

  const reviewReasons: string[] = [];
  if (statement.reconciliation_status === 'variance') reviewReasons.push('statement_does_not_balance_review_the_figures');
  if (statement.reconciliation_status === 'insufficient_data') reviewReasons.push('statement_lacks_enough_detail_to_check_the_balance');
  if (statement.account_match_status === 'multiple_candidates') reviewReasons.push('more_than_one_account_could_match_this_statement');

  const evidence: RetirementEvidence = {
    statementId,
    jurisdiction: statement.retirement_jurisdiction as 'AU' | 'IN',
    accountType: statement.account_type as string,
    fundName: (statement.fund_name as string | null) ?? undefined,
    maskedAccountIdentifier: (statement.masked_account_identifier as string | null) ?? undefined,
    currencyCode: statement.currency_code as string,
    countryCode: statement.retirement_jurisdiction as string,
    // `?? undefined` and never `?? '0'`: a statement that did not show a
    // closing balance proposes NO balance change at all (spec section 94).
    closingBalance: (statement.closing_balance as string | null) ?? undefined,
    employerContributions: (statement.employer_contributions as string | null) ?? undefined,
    personalContributions: (statement.personal_contributions as string | null) ?? undefined,
    memberType,
    isSmsf: false,
    reviewReasons,
  };

  // The account-match decision made earlier is AUTHORITATIVE over the
  // adapter's own re-derivation: the user may have explicitly picked an
  // account or chosen ADD NEW, and re-guessing here would silently discard
  // that choice.
  const existing = (accounts ?? []) as unknown as ExistingRetirementRow[];
  const scoped: ExistingRetirementRow[] =
    statement.account_match_status === 'new_account_confirmed'
      ? []
      : statement.canonical_account_id
        ? existing.filter((a) => a.id === statement.canonical_account_id)
        : existing;

  const draft = retirementAdapter.buildProposal(evidence, scoped);
  const proposalId = await persistRetirementProposal(user.id, draft, statementId);

  await recordDocumentAuditEvent({
    userId: user.id,
    documentId,
    eventType: 'retirement_proposal_generated',
    actorType: 'user',
    actorId: user.id,
    metadata: { statementId, proposalId, mode: draft.recommendedApplyMode },
  });

  return ok({
    proposal_id: proposalId,
    statement_id: statementId,
    recommended_apply_mode: draft.recommendedApplyMode,
    target_entity_id: draft.targetEntityId,
    fields: draft.fields,
    summary: draft.summary,
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const supabase = await createClient();
  const { data: proposal } = await supabase
    .from('fhip_import_proposals')
    .select('id, status, recommended_apply_mode, target_entity_id, currency_code')
    .eq('user_id', user.id)
    .eq('source_retirement_statement_id', statementId)
    .eq('status', 'ready')
    .maybeSingle();
  if (!proposal) return ok({ proposal: null, fields: [] });

  const { data: fields } = await supabase
    .from('fhip_import_proposal_fields')
    .select('field_name, value_kind, proposed_value, existing_value, is_recommended, requires_confirmation, confidence, reason_code')
    .eq('user_id', user.id)
    .eq('proposal_id', proposal.id)
    .order('field_name', { ascending: true });

  return ok({ proposal, fields: fields ?? [] });
}
