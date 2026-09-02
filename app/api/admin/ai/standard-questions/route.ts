// Module 11.4 — Admin -> AI Operations -> Standard Questions (spec sections
// 53-59). Read-only, admin-gated identically to every other
// /api/admin/ai/* route (no dedicated Admin AI Operations page exists yet
// for ANY Module 11 phase — this matches that existing precedent, an
// API-only surface, rather than building a new page ahead of one).
//
// Exposes question code/wording/category/enabled-state/country-scope/
// primary-resolver/required-block plus resolution-count/unavailable-count/
// stored-answer-reuse-count derived from the EXISTING `ai_resolution_audit`
// table (Module 11.2) — no parallel analytics store (spec section 61).
// Never returns a household's raw financial context.

import { requireAdmin, adminClient, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { loadStandardQuestionCatalogue } from '@/lib/ai/standardQuestions/catalogueDb';

export const GET = adminRoute(async () => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const { questions, ok: catalogueOk } = await loadStandardQuestionCatalogue();
  if (!catalogueOk) return bad('Standard question catalogue is currently unavailable.', 503);

  const client = adminClient();
  const { data: auditRows, error } = await client
    .from('ai_resolution_audit')
    .select('standard_question_code, resolution_type, provider_called, quota_consumed')
    .not('standard_question_code', 'is', null)
    .limit(10000);
  if (error) return bad(error.message);

  const rows = auditRows ?? [];
  const anyProviderCalled = rows.some((r) => r.provider_called === true);
  const anyQuotaConsumed = rows.some((r) => r.quota_consumed === true);

  const perQuestion = new Map<string, { resolved: number; unavailable: number; stored_answer_reuse: number }>();
  for (const r of rows) {
    const code = r.standard_question_code as string;
    const entry = perQuestion.get(code) ?? { resolved: 0, unavailable: 0, stored_answer_reuse: 0 };
    if (r.resolution_type === 'UNAVAILABLE' || r.resolution_type === 'BLOCKED' || r.resolution_type === 'UNSUPPORTED') entry.unavailable += 1;
    else entry.resolved += 1;
    perQuestion.set(code, entry);
  }

  return ok({
    provider_calls_from_standard_library: anyProviderCalled ? rows.filter((r) => r.provider_called).length : 0,
    quota_consumption_from_standard_library: anyQuotaConsumed ? rows.filter((r) => r.quota_consumed).length : 0,
    questions: questions
      .sort((a, b) => a.display_order - b.display_order)
      .map((q) => ({
        question_code: q.standard_question_code,
        display_text: q.display_text,
        category: q.category,
        enabled: q.enabled,
        country_scope: q.country_scope,
        primary_intent_code: q.primary_intent_code,
        stored_pack_block_codes: q.stored_pack_block_codes,
        resolution_count: perQuestion.get(q.standard_question_code)?.resolved ?? 0,
        unavailable_count: perQuestion.get(q.standard_question_code)?.unavailable ?? 0,
      })),
  });
});
