import { requireCountryConfirmedUser as requireUser, ok } from '@/lib/api';
import { discardPendingAiFallbackDraft } from '@/lib/financial-data-hub/services/aiFallbackDrafts';

// POST /api/financial-data-hub/documents/{documentId}/ai-draft/discard
//
// 2026-09-25: "This doesn't look right" on an AI reading. Before, the choice
// lived only in the panel's memory: the draft stayed pending, so once pending
// drafts became resumable it would have been offered again after every
// reload. Scoped to the caller's own document; answers whether anything was
// actually discarded (a zero-row update is reported, not hidden).
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const result = await discardPendingAiFallbackDraft(user.id, documentId);
  return ok(result);
}
