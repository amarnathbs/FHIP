import { z } from 'zod';
import { requireCountryConfirmedUser as requireUser, ok, bad, badValidation } from '@/lib/api';
import { createClient } from '@/lib/supabase/server';
import { linkSmsfPropertyLoan, listSmsfPropertyLoanLinks } from '@/lib/services/smsfData';

const bodySchema = z.object({ liability_id: z.string().uuid() });

// List this fund's active SMSF-property-loan link(s) — the UI needs this to
// render "Associated Debt" state and the reconciliation panel's Linked SMSF
// Liabilities total (spec s.22-24).
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const supabase = await createClient();
  const { data, error } = await listSmsfPropertyLoanLinks(id, user.id, supabase);
  return error ? bad(error.message) : ok(data);
}

// SMSF-5: link a liability as this fund's property loan, reusing the
// certified Property<->Liability architecture (migration 0078) exactly as
// designed. This migration does not modify 0078 -- it only ever inserts a
// row shaped exactly like any other property_liability_links row, using
// the link_type/linked_retirement_id combination that migration already
// reserved for this. Fund-level granularity, not per-holding (see
// lib/services/smsfData.ts comment) -- a disclosed limitation for
// multi-property funds in this release.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);

  const supabase = await createClient();
  // Entity-level liabilities (migration 0289): an itemised fund records its debts on the fund itself, so a personal liability is no
  // longer linked to it (that would be a second place for the same debt). Net-value-only funds keep the earlier link.
  const { data: fund } = await supabase.from('smsf_funds').select('mode').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (fund?.mode === 'detailed') {
    return bad(
      'This fund is recorded as itemised, so its debts are entered on the fund itself under Liabilities. Add the debt there, or use Move to the fund on a debt that is already linked.',
      409,
      'ENTITY_USE_FUND_LIABILITIES',
    );
  }
  const { data, error } = await linkSmsfPropertyLoan(id, user.id, parsed.data.liability_id, supabase);
  return error ? bad(error.message) : ok(data);
}
