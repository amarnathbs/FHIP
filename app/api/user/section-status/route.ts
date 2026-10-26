// Phase 0C: canonical per-section review status. GET returns the explicit
// confirmations a user has set (loadSectionStatus in the page/dashboard
// services combines these with real row presence); PUT sets or clears one
// section's confirmation. Auth-scoped via the request-bound Supabase client
// (RLS enforces the "own rows only" boundary — no service-role client here).
import { createClient } from '@/lib/supabase/server';
import { ok, bad, requireCountryConfirmedUser as requireUser, requireCountryConfirmedUserAllowingGeneric } from '@/lib/api';
import { setSectionConfirmation } from '@/lib/services/financialSectionStatusData';
import { ALL_SECTIONS, type FinancialSection, type ExplicitSectionConfirmation } from '@/lib/engines/financialSectionStatus';
import {
  isRetirementDeclarationDbRefusal,
  loadRetirementDeclarationBlockers,
  refuseRetirementDeclarationIfConflicting,
  retirementDeclarationConflictResponse,
} from '@/lib/services/retirementDeclarationGuard';

const VALID_SECTIONS = new Set<string>(ALL_SECTIONS);
// Phase 0C.1: 'reviewed_with_data' added — the positive-data-section
// "I've added everything relevant to me" confirmation, alongside the
// original zero/not-applicable confirmations.
const VALID_CONFIRMATIONS = new Set<string>(['reviewed_zero', 'not_applicable', 'reviewed_with_data']);

// G4 closure item 4 (Product Owner, 2026-09-05, found via live browser
// certification): FinancialDataGrid.tsx's load() calls this GET for every
// config.reviewSection module — including the three newly-certified-
// universal grids (Income/Expenses/Insurance) — and this used to require
// the STRICT requireCountryConfirmedUser() gate, producing a visible 403
// console error on every page load for a GENERIC user even though it was
// harmlessly caught (`.catch(() => [])`) and never broke the page. Reading
// this is always safe for GENERIC: RLS already scopes the query to the
// caller's own rows, and a GENERIC user structurally cannot hold any
// section-status row of their own yet regardless (empty result either way).
// PUT (the actual write) deliberately keeps the strict gate — item 2's
// write-certification boundary — the "mark reviewed" button that would call
// it is also unreachable in practice (it only renders once `included.length
// > 0`, and a GENERIC user cannot have an included/active row).
export async function GET() {
  const { user, unauthenticated } = await requireCountryConfirmedUserAllowingGeneric();
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

  // PO-D24-02 (21-10-2026): the retirement "I don't have any retirement savings" confirmation (not_applicable) is refused, with a readable 409,
  // while an active retirement account or SMSF exists. Same rule as PUT /api/user/profile (lib/services/retirementDeclarationGuard.ts).
  const declaringNoRetirement = section === 'retirement' && status === 'not_applicable';
  let previousConfirmation: ExplicitSectionConfirmation | null = null;
  if (declaringNoRetirement) {
    const refusal = await refuseRetirementDeclarationIfConflicting(supabase, user.id);
    if (refusal) return refusal;
    const { data: before } = await supabase
      .from('user_financial_section_status')
      .select('status')
      .eq('user_id', user.id)
      .eq('section', 'retirement')
      .maybeSingle();
    previousConfirmation = ((before as { status?: ExplicitSectionConfirmation } | null)?.status ?? null) as ExplicitSectionConfirmation | null;
  }

  try {
    await setSectionConfirmation(user.id, section as FinancialSection, status ?? null, supabase);
  } catch (e) {
    // Migration 0298 refuses the same transition inside the database: answer with the same readable 409.
    if (isRetirementDeclarationDbRefusal(e instanceof Error ? { message: e.message } : null)) {
      return retirementDeclarationConflictResponse(await loadRetirementDeclarationBlockers(supabase, user.id));
    }
    return bad(e instanceof Error ? e.message : 'Failed to save section status', 500);
  }

  // Re-check after the write (an account or SMSF added in between): put the confirmation back exactly as it was.
  if (declaringNoRetirement) {
    const after = await loadRetirementDeclarationBlockers(supabase, user.id);
    if (after.total > 0) {
      try {
        await setSectionConfirmation(user.id, 'retirement', previousConfirmation, supabase);
      } catch {
        /* the refusal below is still returned; the reconciling page will show the contradiction notice */
      }
      return retirementDeclarationConflictResponse(after);
    }
  }
  return ok({ section, status: status ?? null });
}
