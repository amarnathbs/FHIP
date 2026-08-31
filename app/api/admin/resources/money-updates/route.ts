import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff, canCreateSpecialistContent } from '@/lib/resources/permissions';
import { getMoneyUpdateList, type MoneyUpdateListFilters } from '@/lib/resources/money-update/queries';
import { createMoneyUpdateDraft } from '@/lib/resources/money-update/mutations';
import type { MoneyUpdateContentType } from '@/lib/resources/money-update/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

const CONTENT_TYPES: MoneyUpdateContentType[] = ['money_update', 'money_update_template'];

// GET /api/admin/resources/money-updates — list (spec §41). `type` query
// param selects money_update | money_update_template | (default) both.
export async function GET(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  // Phase A Wave 1: narrowed from the former coarse `!current.isSuperAdmin &&
  // current.roles.length === 0` check, which any single Resources role
  // cleared — including Analyst, who then received a misleading RLS-filtered
  // 200 instead of an honest denial (Admin Architecture Standard §4). Same
  // message and status code; only the predicate narrows.
  if (!isResourceStaff(current)) return bad("You don't have permission to access Resources administration.", 403);

  try {
    const { searchParams } = new URL(request.url);
    const typeParam = searchParams.get('type');
    const filters: MoneyUpdateListFilters = {
      search: (searchParams.get('q') ?? '').slice(0, 200),
      jurisdiction: searchParams.get('jurisdiction') ?? 'all',
      compliance: searchParams.get('compliance') ?? 'all',
      status: searchParams.get('status') ?? 'all',
      contentType: typeParam && (CONTENT_TYPES as string[]).includes(typeParam) ? (typeParam as MoneyUpdateContentType) : 'all',
      page: Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1),
      pageSize: Math.min(100, Math.max(1, Number.parseInt(searchParams.get('pageSize') ?? '25', 10) || 25)),
    };
    const result = await getMoneyUpdateList(supabase, filters);
    return ok(result);
  } catch (err) {
    console.error('Resources money update list error:', err);
    return bad("We couldn't load Money Updates. Try again.", 500);
  }
}

// POST { contentType: 'money_update' | 'money_update_template' } — spec §41-44.
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canCreateSpecialistContent(current)) return bad("You don't have permission to create a Money Update.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const contentType = body?.contentType as string;
    if (!CONTENT_TYPES.includes(contentType as MoneyUpdateContentType)) return bad('Invalid content type. Must be money_update or money_update_template.', 400);

    const { id } = await createMoneyUpdateDraft(supabase, contentType as MoneyUpdateContentType, user.id);
    return ok({ id });
  } catch (err) {
    console.error('Resources money update create error:', err);
    return bad('Could not create this Money Update.', 500);
  }
}
