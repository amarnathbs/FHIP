import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, isResourceStaff, canManageFaqs } from '@/lib/resources/permissions';
import { getFaqList } from '@/lib/resources/faq/queries';
import { createFaq } from '@/lib/resources/faq/mutations';
import { validateFaq } from '@/lib/resources/faq/validation';
import type { FaqSavePatch } from '@/lib/resources/faq/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

// GET /api/admin/resources/faqs — list (spec §33).
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
    const filters = {
      search: (searchParams.get('q') ?? '').slice(0, 200),
      jurisdiction: searchParams.get('jurisdiction') ?? 'all',
      activeOnly: (searchParams.get('active') as 'all' | 'active' | 'inactive') ?? 'all',
      categoryId: searchParams.get('category') ?? 'all',
      page: Math.max(1, Number.parseInt(searchParams.get('page') ?? '1', 10) || 1),
      pageSize: Math.min(100, Math.max(1, Number.parseInt(searchParams.get('pageSize') ?? '25', 10) || 25)),
    };
    const result = await getFaqList(supabase, filters);
    return ok(result);
  } catch (err) {
    console.error('Resources FAQ list error:', err);
    return bad("We couldn't load FAQs. Try again.", 500);
  }
}

// POST /api/admin/resources/faqs — spec §34/§71. Roles: Resource Admin,
// Author, Editor, Super Admin only (spec §71: "Do not make Publisher a
// general FAQ editor merely because Publisher can publish posts").
export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageFaqs(current)) return bad("You don't have permission to create FAQs.", 403);

  try {
    const body = await request.json().catch(() => ({}));
    const patch: FaqSavePatch = {
      question: typeof body?.question === 'string' ? body.question : '',
      short_answer: typeof body?.short_answer === 'string' ? body.short_answer : '',
      answer_blocks: Array.isArray(body?.answer_blocks) ? body.answer_blocks : [],
      jurisdiction: typeof body?.jurisdiction === 'string' ? body.jurisdiction : 'global',
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
      category_id: typeof body?.category_id === 'string' && body.category_id ? body.category_id : null,
      compliance_classification: typeof body?.compliance_classification === 'string' ? body.compliance_classification : 'green',
    };

    const check = validateFaq(patch);
    if (!check.valid) return Response.json({ error: 'Validation failed.', fields: check.errors }, { status: 422 });

    const result = await createFaq(supabase, patch, user.id);
    return ok(result);
  } catch (err) {
    console.error('Resources FAQ create error:', err);
    return bad('Could not create this FAQ.', 500);
  }
}
