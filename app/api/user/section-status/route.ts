// Phase 0C: canonical per-section review status. GET returns the explicit
// confirmations a user has set (loadSectionStatus in the page/dashboard
// services combines these with real row presence); PUT sets or clears one
// section's confirmation. Auth-scoped via the request-bound Supabase client
// (RLS enforces the "own rows only" boundary — no service-role client here).
import { createClient } from '@/lib/supabase/server';
import { ok, bad, requireCountryConfirmedUser as requireUser } from '@/lib/api';
import { setSectionConfirmation } from '@/lib/services/financialSectionStatusData';
import { ALL_SECTIONS, type FinancialSection, type ExplicitSectionConfirmation } from '@/lib/engines/financialSectionStatus';

const VALID_SECTIONS = new Set<string>(ALL_SECTIONS);
// Phase 0C.1: 'reviewed_with_data' added — the positive-data-section
// "I've added everything relevant to me" confirmation, alongside the
// original zero/not-applicable confirmations.
const VALID_CONFIRMATIONS = new Set<string>(['reviewed_zero', 'not_applicable', 'reviewed_with_data']);

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated) return unauthenticated;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from('user_financial_section_status')
    .select('section, status')
    .eq('user_id', user.id);

  return error ? bad(error.message) : ok(data);
}

export async function PUT(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (unauthenticated) return unauthenticated;

  const body = await req.json().catch(() => null);
  const section = body?.section as string | undefined;
  // null explicitly clears the confirmation (Phase 0C §34 — every explicit
  // confirmation must be reversible, e.g. "No liabilities" -> "Yes, I have
  // liabilities").
  const status = body?.status as ExplicitSectionConfirmation | null | undefined;

  if (!section || !VALID_SECTIONS.has(section)) return bad('Invalid or missing section', 422);
  if (status !== null && (!status || !VALID_CONFIRMATIONS.has(status))) {
    return bad('status must be "reviewed_zero", "not_applicable", "reviewed_with_data", or null', 422);
  }

  const supabase = await createClient();
  try {
    await setSectionConfirmation(user.id, section as FinancialSection, status ?? null, supabase);
    return ok({ section, status: status ?? null });
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Failed to save section status', 500);
  }
}
