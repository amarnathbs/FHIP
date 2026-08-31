import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { getRetirementStatementIdForDocument } from '@/lib/financial-data-hub/services/retirementStatementProcessingService';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';
import { compareCurrentVsStatement } from '@/lib/financial-data-hub/retirement/reconciliation';
import { minorUnitsToDecimalString } from '@/lib/financial-data-hub/retirement/money';

// GET /api/financial-data-hub/retirement-statement/{documentId}
//
// The review payload (spec section 147): statement header, activities,
// investment-option evidence, and the CURRENT vs STATEMENT comparison
// (spec section 55).
//
// READ ONLY. Nothing here mutates anything.

export async function GET(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const statementId = await getRetirementStatementIdForDocument(user.id, documentId);
  if (!statementId) return bad('No statement evidence has been extracted from this document yet.', 404);

  const supabase = await createClient();

  const { data: statement } = await supabase
    .from('fdh_retirement_statements')
    .select('*')
    .eq('id', statementId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (!statement) return bad('That retirement statement could not be found.', 404);

  // PAGINATION (spec sections 138-139): a statement with more than 1000
  // activity rows would otherwise be silently truncated by PostgREST's row
  // cap, showing the user an incomplete statement that still looked complete.
  const activities = await fetchAllRows(() =>
    supabase
      .from('fdh_retirement_statement_activities')
      .select('*')
      .eq('user_id', user.id)
      .eq('statement_id', statementId)
      .order('source_row_number', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true }));

  const positions = await fetchAllRows(() =>
    supabase
      .from('fdh_retirement_statement_positions')
      .select('*')
      .eq('user_id', user.id)
      .eq('statement_id', statementId)
      .order('source_row_number', { ascending: true, nullsFirst: false })
      .order('id', { ascending: true }));

  // --- CURRENT vs STATEMENT (spec section 55) ------------------------------
  // Shown whenever the statement has been matched to a canonical account. The
  // canonical balance is READ here and nothing more.
  let currentVsStatement: {
    current: string | null;
    statement: string | null;
    difference: string | null;
    identical: boolean;
    account_name: string | null;
  } | null = null;

  if (statement.canonical_account_id) {
    const { data: account } = await supabase
      .from('retirement_accounts')
      .select('id, account_name, current_balance')
      .eq('id', statement.canonical_account_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (account) {
      const cmp = compareCurrentVsStatement(
        account.current_balance as string | number | null,
        (statement.closing_balance as string | null) ?? null,
      );
      currentVsStatement = {
        current: cmp.currentMinorUnits === null ? null : minorUnitsToDecimalString(cmp.currentMinorUnits),
        statement: cmp.statementMinorUnits === null ? null : minorUnitsToDecimalString(cmp.statementMinorUnits),
        difference: cmp.differenceMinorUnits === null ? null : minorUnitsToDecimalString(cmp.differenceMinorUnits),
        identical: cmp.identical,
        account_name: account.account_name as string,
      };
    }
  }

  // The household members a statement may be attached to. Used by the review
  // UI's member picker — a statement's member is chosen explicitly, never
  // inferred (spec sections 15, 112).
  const { data: members } = await supabase
    .from('retirement_members')
    .select('id, member_type, target_retirement_age')
    .eq('user_id', user.id)
    .eq('is_active', true)
    .order('member_type', { ascending: true });

  // Candidate accounts, for the disambiguation picker. SMSF rows are excluded
  // so an SMSF account can never even be offered as a target (spec section 10).
  const accounts = await fetchAllRows(() =>
    supabase
      .from('retirement_accounts')
      .select('id, account_name, account_type, current_balance, currency_code, owner, master_item_key')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('account_name', { ascending: true }));

  return ok({
    statement,
    activities: activities ?? [],
    positions: positions ?? [],
    current_vs_statement: currentVsStatement,
    members: members ?? [],
    accounts: (accounts ?? []).filter((a) => a.master_item_key !== 'smsf'),
  });
}
