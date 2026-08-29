import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { investmentPatchSchema } from '@/lib/validation/investment';

const registry = makeRegistry('investments');

// R3 spec section 38 — direct-edit protection. Fields Investment
// Intelligence certifies from a source document/canonical position must not
// become independently editable in the FHIP grid in a way that breaks
// canonical truth (never let II value=500,000 and a manually-changed FHIP
// value=700,000 coexist as if both were authoritative). Corrections to
// these fields must route back through Investment Intelligence's own
// republish/correction flow instead.
const PROTECTED_ON_PUBLISHED_ROWS = ['investment_name', 'investment_type', 'current_value', 'currency_code', 'country_code', 'institution', 'cost_base', 'owner', 'risk_profile', 'master_item_key'] as const;

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = investmentPatchSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  const { data: existing } = await supabase.from('investments').select('source_type').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (existing && (existing as { source_type: string }).source_type === 'investment_intelligence_published') {
    const attemptedProtectedFields = Object.keys(parsed.data).filter((key) => (PROTECTED_ON_PUBLISHED_ROWS as readonly string[]).includes(key));
    if (attemptedProtectedFields.length > 0) {
      return bad(
        `This row is imported via Investment Intelligence — ${attemptedProtectedFields.join(', ')} cannot be edited directly here. Use Investment Intelligence's refresh/correction flow, or unpublish this position first.`,
        409
      );
    }
  }

  const { data, error } = await registry.update(user.id, id, parsed.data);
  return error ? bad(error.message) : ok(data);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const supabase = await createClient();
  const { data: existing } = await supabase.from('investments').select('source_type').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (existing && (existing as { source_type: string }).source_type === 'investment_intelligence_published') {
    return bad('This row is imported via Investment Intelligence and cannot be deleted directly — use Unpublish in Investment Intelligence instead, which preserves canonical history and updates net worth safely.', 409);
  }

  const { error } = await registry.archive(user.id, id);
  return error ? bad(error.message) : ok({ archived: true });
}
