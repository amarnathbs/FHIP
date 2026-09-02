// Module 11.4 — GET /api/ai/standard-questions (spec section 26).
//
// Returns the catalogue with a per-household availability evaluation. Never
// accepts arbitrary prompt text or a client-supplied household id — scope
// comes entirely from resolveHouseholdContext() (spec section 41).

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { AIStandardQuestionService } from '@/lib/ai/standardQuestions/service';

export async function GET() {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  try {
    const { entitled, questions } = await AIStandardQuestionService.listCatalogue(scope.userId, scope.householdId);
    return ok({
      entitled,
      note: 'These standard insights do not use your custom AI question allowance.',
      questions: questions
        .sort((a, b) => a.display_order - b.display_order)
        .map((q) => ({
          standard_question_code: q.standard_question_code,
          question: q.question,
          category: q.category,
          status: q.status,
          related_module: q.related_module,
          action_route: q.action_route,
          requires_target: q.requires_target,
        })),
    });
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to load the standard question library.', 500);
  }
}
