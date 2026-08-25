import { z } from 'zod';
import { requireUser, ok, bad } from '@/lib/api';
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
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data, error } = await linkSmsfPropertyLoan(id, user.id, parsed.data.liability_id, supabase);
  return error ? bad(error.message) : ok(data);
}
