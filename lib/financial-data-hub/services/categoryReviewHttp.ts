import { CategoryReviewError } from './categoryReviewService';

/** One HTTP mapping for every category-review route: 404 for not-found
 * (including another user's id), 422 for a bad choice, 409 for a state the
 * action cannot be applied in. Unknown errors never leak their message. */
export function categoryReviewErrorResponse(e: unknown, fallback: string): Response {
  if (e instanceof CategoryReviewError) {
    const status = e.code === 'not_found' ? 404 : e.code === 'invalid_input' ? 422 : 409;
    return Response.json({ error: e.message, details: e.details ?? null }, { status });
  }
  return Response.json({ error: fallback }, { status: 500 });
}
