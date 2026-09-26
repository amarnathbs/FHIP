import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { fetchAllRows } from '@/lib/financial-data-hub/bank-csv/pagination';

// GET /api/financial-data-hub/retirement-statement?page=1&page_size=10
//
// WP-13 (GAP-RET-03 / GAP-RET-04): the Retirement tab's statement history.
//
// Canonical Retirement is a SUMMARY-BALANCE register: applying a statement
// changes one retirement_accounts row and nothing else. Everything else the
// statement said -- contributions, rollovers, earnings, fees, insurance, tax,
// the investment options inside the fund -- is EVIDENCE (disposition C), and
// evidence must stay USER-VISIBLE after Apply. Before WP-13 the only reader of
// that evidence was the in-flow review screen, so once a statement was applied
// it vanished from the user's view.
//
// READ ONLY, USER-SCOPED, PAGED. One page of the user's APPROVED statements
// (an SMSF-routed statement can never be approved, so the SMSF boundary holds
// here too), each with EVERY activity line and EVERY holding (paginated past
// PostgREST's silent 1000-row cap), the account it was applied to, and the
// Apply outcome. Nothing here is summed into Net Worth: holdings in super are
// already inside the fund's balance.

const MAX_PAGE_SIZE = 20;

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  const n = value === null ? NaN : Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function chunks<T>(list: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const url = new URL(req.url);
  const page = intParam(url.searchParams.get('page'), 1, 1, 10_000);
  const pageSize = intParam(url.searchParams.get('page_size'), 10, 1, MAX_PAGE_SIZE);
  const from = (page - 1) * pageSize;

  const supabase = await createClient();

  const { count, error: countError } = await supabase
    .from('fdh_retirement_statements')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('approval_status', 'approved');
  if (countError) return bad('Could not load your imported statements.', 500);

  const { data: statements, error: pageError } = await supabase
    .from('fdh_retirement_statements')
    .select('*')
    .eq('user_id', user.id)
    .eq('approval_status', 'approved')
    .order('statement_end_date', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .range(from, from + pageSize - 1);
  if (pageError) return bad('Could not load your imported statements.', 500);

  const rows = statements ?? [];
  const ids = rows.map((s) => s.id as string);
  if (ids.length === 0) {
    return ok({ statements: [], page, page_size: pageSize, total: count ?? 0, has_more: false });
  }

  const activities: Record<string, unknown>[] = [];
  const positions: Record<string, unknown>[] = [];
  const applications: Record<string, unknown>[] = [];
  const proposals: Record<string, unknown>[] = [];
  for (const chunk of chunks(ids)) {
    activities.push(...await fetchAllRows(() =>
      supabase
        .from('fdh_retirement_statement_activities')
        .select('*')
        .eq('user_id', user.id)
        .in('statement_id', chunk)
        .order('statement_id', { ascending: true })
        .order('source_row_number', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })));
    positions.push(...await fetchAllRows(() =>
      supabase
        .from('fdh_retirement_statement_positions')
        .select('*')
        .eq('user_id', user.id)
        .in('statement_id', chunk)
        .order('statement_id', { ascending: true })
        .order('source_row_number', { ascending: true, nullsFirst: false })
        .order('id', { ascending: true })));
    applications.push(...await fetchAllRows(() =>
      supabase
        .from('fhip_import_applications')
        .select('id, source_retirement_statement_id, target_entity_id, apply_mode, applied_fields, applied_at')
        .eq('user_id', user.id)
        .in('source_retirement_statement_id', chunk)
        .order('applied_at', { ascending: true })
        .order('id', { ascending: true })));
    proposals.push(...await fetchAllRows(() =>
      supabase
        .from('fhip_import_proposals')
        .select('id, source_retirement_statement_id, status')
        .eq('user_id', user.id)
        .in('source_retirement_statement_id', chunk)
        .order('id', { ascending: true })));
  }

  // The bank payment each matched line was linked to -- shown so the user can
  // see WHICH payment it is before confirming it (GAP-RET-07).
  const legIds = [...new Set(activities.map((a) => a.linked_transaction_id as string | null).filter((v): v is string => !!v))];
  const bankLegs = new Map<string, Record<string, unknown>>();
  for (const chunk of chunks(legIds)) {
    const legs = await fetchAllRows(() =>
      supabase
        .from('fdh_transactions')
        .select('id, transaction_date, description_clean, amount_original, currency_original, credit_debit')
        .eq('user_id', user.id)
        .in('id', chunk)
        .order('id', { ascending: true }));
    for (const l of legs) bankLegs.set(l.id as string, l);
  }

  const accountIds = [...new Set([
    ...rows.map((s) => s.canonical_account_id as string | null),
    ...applications.map((a) => a.target_entity_id as string | null),
  ].filter((v): v is string => !!v))];
  const accountNames = new Map<string, string>();
  for (const chunk of chunks(accountIds)) {
    const accounts = await fetchAllRows(() =>
      supabase
        .from('retirement_accounts')
        .select('id, account_name')
        .eq('user_id', user.id)
        .in('id', chunk)
        .order('id', { ascending: true }));
    for (const a of accounts) accountNames.set(a.id as string, a.account_name as string);
  }

  const byStatement = <T extends Record<string, unknown>>(list: T[], key: string) => {
    const m = new Map<string, T[]>();
    for (const r of list) {
      const k = r[key] as string;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };
  const activitiesBy = byStatement(activities, 'statement_id');
  const positionsBy = byStatement(positions, 'statement_id');
  const applicationsBy = byStatement(applications, 'source_retirement_statement_id');
  const proposalsBy = byStatement(proposals, 'source_retirement_statement_id');

  const items = rows.map((s) => {
    const id = s.id as string;
    const application = (applicationsBy.get(id) ?? []).slice(-1)[0] ?? null;
    const kept = (proposalsBy.get(id) ?? []).some((p) => p.status === 'dismissed');
    const accountId = (application?.target_entity_id as string | undefined) ?? (s.canonical_account_id as string | null) ?? null;
    return {
      statement: s,
      activities: (activitiesBy.get(id) ?? []).map((a) => ({
        ...a,
        bank_leg: a.linked_transaction_id ? bankLegs.get(a.linked_transaction_id as string) ?? null : null,
      })),
      positions: positionsBy.get(id) ?? [],
      account_name: accountId ? accountNames.get(accountId) ?? null : null,
      application: application
        ? { applied_at: application.applied_at, apply_mode: application.apply_mode, applied_fields: application.applied_fields, target_entity_id: application.target_entity_id }
        : null,
      outcome: application ? 'applied' : kept ? 'kept_existing' : 'not_applied',
    };
  });

  const total = count ?? items.length;
  return ok({ statements: items, page, page_size: pageSize, total, has_more: from + items.length < total });
}
