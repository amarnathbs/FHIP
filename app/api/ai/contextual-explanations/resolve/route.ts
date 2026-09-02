// Module 11.5 — POST /api/ai/contextual-explanations/resolve
// (spec sections 54-56).
//
// The ONLY consumer-facing contextual resolution path.
//
// WHAT THIS ENDPOINT ACCEPTS (spec section 54): a registry `target_code`,
// and optionally an owned `target_id` / `context_id`. That is the whole
// allowlist — see `body` destructuring below.
//
// WHAT IT REFUSES TO ACCEPT (spec sections 8, 54, 56): `message`, `prompt`,
// `free_text_question`, `question`, `intent_code`, `standard_question_code`,
// `household_id`, `user_id`, `premium`, `provider_called`. None of these are
// read. They are not merely ignored by omission either — supplying any of
// them is rejected with 422, so a client that believes it can steer this
// endpoint learns immediately that it cannot, and a future refactor cannot
// quietly start honouring one.
//
// Scope comes entirely from resolveHouseholdContext() — never from the body.

import { ok, bad } from '@/lib/api';
import { resolveHouseholdContext } from '@/lib/ai/household/resolveHouseholdContext';
import { AIContextualExplanationService } from '@/lib/ai/contextualExplanations/service';

/**
 * Spec section 56 — client tampering. Any of these in the body is an attempt
 * to supply authority the client does not have, and is refused outright
 * rather than silently dropped.
 */
const FORBIDDEN_BODY_FIELDS = [
  'message',
  'prompt',
  'free_text_question',
  'question',
  'text',
  'intent_code',
  'standard_question_code',
  'question_code',
  'household_id',
  'user_id',
  'premium',
  'entitled',
  'provider_called',
  'custom_quota_consumed',
  'policy',
] as const;

const TARGET_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function POST(req: Request) {
  const { scope, forbidden } = await resolveHouseholdContext();
  if (!scope) return forbidden;

  let body: Record<string, unknown> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return bad('Request body must be valid JSON.', 422);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bad('Request body must be a JSON object.', 422);
  }

  for (const field of FORBIDDEN_BODY_FIELDS) {
    if (field in body) {
      return bad('This endpoint answers approved contextual targets only; it does not accept question text or caller-supplied authority.', 422);
    }
  }

  const targetCode = typeof body.target_code === 'string' ? body.target_code : '';
  if (!TARGET_CODE_PATTERN.test(targetCode)) {
    return bad('Unknown contextual explanation target.', 404);
  }

  // Both ids address rows whose primary keys are uuids. Rejecting a
  // non-uuid before it reaches the service keeps malformed input off the
  // database path entirely.
  const targetId = typeof body.target_id === 'string' && body.target_id ? body.target_id : null;
  if (targetId !== null && !UUID_PATTERN.test(targetId)) {
    return bad('Invalid target id.', 422);
  }
  const contextId = typeof body.context_id === 'string' && body.context_id ? body.context_id : null;
  if (contextId !== null && !UUID_PATTERN.test(contextId)) {
    return bad('Invalid context id.', 422);
  }

  try {
    const result = await AIContextualExplanationService.resolveExplanation(scope.userId, scope.householdId, {
      target_code: targetCode,
      target_id: targetId,
      context_id: contextId,
    });
    if ('unknownTarget' in result) {
      return bad('Unknown contextual explanation target.', 404);
    }
    return ok(result);
  } catch (err) {
    return bad(err instanceof Error ? err.message : 'Failed to resolve this explanation.', 500);
  }
}
