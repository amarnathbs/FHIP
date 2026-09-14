import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { isAieEvidenceRevealEnabled } from '@/lib/aie/review/featureFlags';
import { revealMaskedToken } from '@/lib/aie/review/reveal';

// POST /api/aie/review/runs/{runId}/reveal — EVID-04/06/10, MASK-01..12.
// Body: { token }. Never a GET (MASK-03/PRIV-02: a token in a query string
// would land in access logs/analytics — this is a POST specifically so the
// token travels only in the request body, never a URL).
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
    const status = outcome.reason === 'forbidden' ? 403 : 404;
    return bad(`could not reveal evidence: ${outcome.reason}`, status, outcome.reason);
  }
  // MASK-07: the client is responsible for automatically remasking after
  // inactivity/tab-change/modal-close — this response carries the value
  // exactly once, with no cache-control override needed beyond this
  // framework's own default (POST responses are not cached by browsers).
  return ok({ value: outcome.value });
}
