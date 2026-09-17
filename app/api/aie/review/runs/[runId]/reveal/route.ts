import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieEvidenceRevealEnabled } from '@/lib/aie/review/featureFlags';
import { revealMaskedToken } from '@/lib/aie/review/reveal';

// POST /api/aie/review/runs/{runId}/reveal
//
// M3 (Phase 4): THIS ENDPOINT NO LONGER REVEALS ANYTHING. The Product
// Owner's 2026-09-15 decision replaced reversible escrowed masking with
// keyed one-way HMAC pseudonyms, so no original value is recoverable by any
// party. The route is kept (rather than deleted) so an existing client gets
// a typed, audited "410 Gone"-shaped answer instead of a bare 404, and so
// the removal is visible at the place the capability used to live. See
// `lib/aie/review/reveal.ts` for the full reasoning.
//
// Still a POST, not a GET, for the original MASK-03/PRIV-02 reason: the
// token travels in the request body and never in a URL that would land in
// access logs or analytics.
export async function POST(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  if (!isAieEvidenceRevealEnabled()) return bad('Evidence reveal is not currently enabled in this environment.', 403);

  const { runId } = await params;
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return bad('invalid request body', 422);
  }
  if (!body.token || typeof body.token !== 'string') return bad('token is required', 422);

  const outcome = await revealMaskedToken({ runId, userId: user.id, token: body.token, actorId: user.id });
  if (!outcome.ok) {
    // 410 Gone for the one-way case specifically, not 404 or 403: the
    // resource is not missing and access is not denied — the capability
    // itself was removed and will not return, which is precisely what 410
    // means. A client can therefore stop retrying and stop offering the
    // affordance, rather than treating it as a transient failure.
    const status = outcome.reason === 'forbidden' ? 403 : outcome.reason === 'not_revealable_one_way_masking' ? 410 : 404;
    const message =
      outcome.reason === 'not_revealable_one_way_masking'
        ? 'Masked identifiers are replaced by one-way codes. The underlying value is not stored and cannot be recovered by anyone, including support.'
        : `could not reveal evidence: ${outcome.reason}`;
    return bad(message, status, outcome.reason);
  }
  return ok({ value: outcome.value });
}
