import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { createAdminClient } from '@/lib/supabase/admin';
import { closeStaleCases } from '@/lib/services/investment-intelligence/staleCases';
import { recertifyPosition } from '@/lib/services/investment-intelligence/documentProcessing';
import { z } from 'zod';

// Document2 (4) WP-B -- bulk "Close all stale items": the same governed close as `[id]/close-stale`, applied to every open
// case that is stale RIGHT NOW (re-derived server-side), or to the listed ids. Explicit `confirm: true`; one audit event per
// case; nothing deleted; items that can still be resolved directly are never touched.
const bodySchema = z.object({ confirm: z.literal(true), caseIds: z.array(z.string().uuid()).max(500).optional(), note: z.string().max(500).optional().nullable() });

export async function POST(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return bad('Please confirm that you want to close these items.', 422, 'CLOSE_NOT_CONFIRMED');

  const result = await closeStaleCases(createAdminClient(), user.id, {
    ...(parsed.data.caseIds ? { caseIds: parsed.data.caseIds } : {}),
    note: parsed.data.note ?? null,
    recertify: (accountId, instrumentId) => recertifyPosition(user.id, accountId, instrumentId),
  });
  return ok({ closedCaseIds: result.closed, notClosed: result.refused, archivedDocumentIds: result.archivedDocumentIds, recertifiedPositions: result.recertified });
}
