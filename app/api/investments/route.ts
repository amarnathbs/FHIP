import { createClient } from '@/lib/supabase/server';
import { requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { investmentSchema } from '@/lib/validation/investment';
import { assertItemCreationAllowedForUser } from '@/lib/services/jurisdiction';

const registry = makeRegistry('investments');

// Education/Children Investment -> Goal Linkage, spec s.12-13/23/65: these
// catalogue items describe a savings PURPOSE, not a financial instrument
// (migration 0092 retires them from /api/master-items for new selection).
// This is a server-side backstop against a stale cached UI or a direct API
// call still attempting to CREATE a brand-new row under one of them —
// editing an existing legacy row (the upsert resolves to an UPDATE because
// a row for this master_item_key already exists) must keep working
// unchanged (spec s.23: "do not remove legacy row rendering").
const RETIRED_PURPOSE_ONLY_ITEM_KEYS = new Set(['education_fund', 'children_investment']);

export async function GET() {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

// G0-JA-1 Wave 2: app-layer gate for investment catalogue items. Today the
// only investment item with a class in migration 0102 is
// 'australian_shares' (HOME_OR_CROSS_BORDER_COUNTRY, PO-2 clause (c)) —
// but per its explicit approved disposition (03-catalogue-matrix.md) it
// keeps country_applicability=NULL (globally creatable, including by a
// non-AU-home user recording a cross-border holding), so this gate call is
// wired for consistency/future-proofing and currently always resolves
// allowed:true for this category — it is not a no-op change in shape, only
// in today's outcome.
export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = investmentSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();

  if (parsed.data.master_item_key && RETIRED_PURPOSE_ONLY_ITEM_KEYS.has(parsed.data.master_item_key)) {
    const { data: existing } = await supabase
      .from('investments')
      .select('id')
      .eq('user_id', user.id)
      .eq('master_item_key', parsed.data.master_item_key)
      .maybeSingle();
    if (!existing) {
      return bad(
        'Education Fund and Children Investment describe a savings purpose, not an investment type, and are no longer offered for new entries. Record the actual holding (Shares, ETF, Managed Fund, Term Deposit, Bond, or Other Investment) and optionally link it to an Education or Family goal instead.',
        422
      );
    }
  }

  const gate = await assertItemCreationAllowedForUser({
    userId: user.id,
    supabase,
    category: 'investment',
    itemKey: parsed.data.master_item_key,
  });
  if (!gate.allowed) return bad(gate.reason, 403);

  const { data, error } = await registry.save(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
