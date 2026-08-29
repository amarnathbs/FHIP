import { createClient } from '@/lib/supabase/server';
import { bad, ok } from '@/lib/api';
import { getCurrentResourceRoles, canManageFaqs } from '@/lib/resources/permissions';
import { getFaqById, getFaqLinkedPosts } from '@/lib/resources/faq/queries';
import { updateFaq, deleteFaqIfUnlinked } from '@/lib/resources/faq/mutations';
import { validateFaq } from '@/lib/resources/faq/validation';
import { getResourceCategoriesForFilter } from '@/lib/resources/admin/queries';
import type { FaqSavePatch } from '@/lib/resources/faq/types';
import { countryConfirmationBlockResponse } from '@/lib/services/countryGate';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const { id } = await params;
  try {
    const faq = await getFaqById(supabase, id);
    if (!faq) return bad('FAQ not found.', 404);
    const [linkedPosts, categories] = await Promise.all([getFaqLinkedPosts(supabase, id), getResourceCategoriesForFilter(supabase)]);
    return ok({ faq, linkedPosts, categories });
  } catch (err) {
    console.error('Resources FAQ load error:', err);
    return bad("We couldn't load this FAQ. Try again.", 500);
  }
}

// PATCH — spec §34/§57-58: stale-write protection via resource_faqs.updated_at.
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageFaqs(current)) return bad("You don't have permission to edit FAQs.", 403);

  const { id } = await params;
  try {
    const body = await request.json();
    const patch: FaqSavePatch = {
      question: typeof body?.question === 'string' ? body.question : '',
      short_answer: typeof body?.short_answer === 'string' ? body.short_answer : '',
      answer_blocks: Array.isArray(body?.answer_blocks) ? body.answer_blocks : [],
      jurisdiction: typeof body?.jurisdiction === 'string' ? body.jurisdiction : 'global',
      is_active: typeof body?.is_active === 'boolean' ? body.is_active : true,
      category_id: typeof body?.category_id === 'string' && body.category_id ? body.category_id : null,
      compliance_classification: typeof body?.compliance_classification === 'string' ? body.compliance_classification : 'green',
    };
    const expectedUpdatedAt = typeof body?.expectedUpdatedAt === 'string' ? body.expectedUpdatedAt : '';
    if (!expectedUpdatedAt) return bad('Malformed save request.', 400);

    const check = validateFaq(patch);
    if (!check.valid) return Response.json({ error: 'Validation failed.', fields: check.errors }, { status: 422 });

    const outcome = await updateFaq(supabase, id, patch, expectedUpdatedAt, user.id);
    if (outcome.status === 'not_found') return bad('FAQ not found.', 404);
    if (outcome.status === 'conflict') return Response.json({ error: 'This FAQ was updated by someone else. Reload before saving your changes.' }, { status: 409 });
    return ok(outcome.faq);
  } catch (err) {
    console.error('Resources FAQ save error:', err);
    return bad('Could not save your changes.', 500);
  }
}

// DELETE — spec §38: linked-content impact must be shown/confirmed by the
// client before this is called; this is also the defence-in-depth backstop
// (deleteFaqIfUnlinked refuses to delete a FAQ with any live links).
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return bad('unauthenticated', 401);

  const countryBlock = await countryConfirmationBlockResponse(supabase, user.id);
  if (countryBlock) return countryBlock;

  const current = await getCurrentResourceRoles();
  if (!canManageFaqs(current)) return bad("You don't have permission to delete FAQs.", 403);

  const { id } = await params;
  try {
    const result = await deleteFaqIfUnlinked(supabase, id);
    if (!result.ok) {
      return Response.json({ error: `This FAQ is linked to ${result.linkedCount} piece${result.linkedCount === 1 ? '' : 's'} of content. Unlink it first, or mark it inactive instead of deleting it.` }, { status: 409 });
    }
    return ok({ deleted: true });
  } catch (err) {
    console.error('Resources FAQ delete error:', err);
    return bad('Could not delete this FAQ.', 500);
  }
}
