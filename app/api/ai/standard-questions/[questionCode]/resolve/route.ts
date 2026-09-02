// Module 11.4 — POST /api/ai/standard-questions/{questionCode}/resolve
// (spec sections 26-28).
//
// The ONLY consumer-facing resolution path. Accepts a catalogue
// `standard_question_code` (from the URL) and, for the one question that
// needs it (SQ-AI-021), a controlled `goal_id` in the JSON body — never
// arbitrary prompt text (spec sections 6-7, 27). Ownership of `goal_id` is
// verified server-side inside AIStandardQuestionService (never trusted from
// the request) — see resolveGoalRiskQuestion()'s header comment.

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { AIStandardQuestionService } from '@/lib/ai/standardQuestions/service';

interface ResolveBody {
  goal_id?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ questionCode: string }> }) {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  const { questionCode } = await params;
  if (!questionCode || !/^SQ-AI-\d{3}$/.test(questionCode)) {
    return bad('Unknown standard question code.', 404);
  }

  let body: ResolveBody = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as ResolveBody;
  } catch {
    return bad('Request body must be valid JSON.', 422);
  }
  // Explicit allowlist — nothing else in the body is ever read (spec section 6-7).
  const goalId = typeof body.goal_id === 'string' ? body.goal_id : undefined;

  try {
    const result = await AIStandardQuestionService.resolveQuestion(scope.userId, scope.householdId, questionCode, { goalId });
    return ok(result);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to resolve this standard question.', 500);
  }
}
