import { requireUser, bad, ok } from '@/lib/api';
import { reopenStatement, ApprovalError } from '@/lib/financial-data-hub/services/approvalService';
import { fdhStatementReopenSchema } from '@/lib/financial-data-hub/validation/transactions';

// POST /api/financial-data-hub/documents/{documentId}/reopen — FDH-7 spec
// sections 63-64. Explicit user action; the prior approval/summary is marked
// superseded, never erased.
export async function POST(req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  const body = await req.json().catch(() => null);
  const parsed = fdhStatementReopenSchema.safeParse(body);
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? 'A reason is required to reopen an approved statement', 422);

  try {
    const statement = await reopenStatement(user.id, documentId, parsed.data.reason);
    return ok({ statement_id: statement.id, approval_version: statement.approval_version, reopened_at: statement.reopened_at });
  } catch (e) {
    if (e instanceof ApprovalError) {
      return bad(e.message, e.code === 'not_found' ? 404 : 409);
    }
    return bad('We could not reopen this statement.', 500);
  }
}
