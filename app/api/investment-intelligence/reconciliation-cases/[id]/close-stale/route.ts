import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { closeStaleCases } from '@/lib/services/investment-intelligence/staleCases';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

// Document2 (4) WP-B (F5/F6/F14) -- the governed "Close stale case".
//
// Only for a case whose resolution needs information that no longer exists (a deleted raw statement file) or that belongs to
// a discarded statement. The server re-derives that from the live document state; the browser's claim is never trusted. The
// case is kept as history (`resolved`, method `user_closed_stale_case`), an audit event is written, and the affected
// positions are re-evaluated from the retained structured data. Nothing is deleted. An explicit `confirm: true` is required.
const bodySchema = z.object({ confirm: z.literal(true), note: z.string().max(500).optional().nullable() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('Please confirm that you want to close this item.', 422, 'CLOSE_NOT_CONFIRMED');

  const result = await closeStaleCases(createAdminClient(), user.id, {
    caseIds: [id],
    note: parsed.data.note ?? null,
    recertify: (accountId, instrumentId) => recertifyPosition(user.id, accountId, instrumentId),
  });
  if (result.closed.length === 0) {
    const reason = result.refused[0]?.reason ?? 'This item could not be closed.';
    // 404 for "not yours / not open" (non-enumerating), 409 for "still resolvable directly".
    const notFound = reason.startsWith('This item is not open');
    return bad(reason, notFound ? 404 : 409, notFound ? 'CASE_NOT_FOUND' : 'NOT_STALE');
  }
  return ok({ closedCaseIds: result.closed, archivedDocumentIds: result.archivedDocumentIds, recertifiedPositions: result.recertified });
}
