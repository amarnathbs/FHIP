import { requireUser, bad, ok } from '@/lib/api';
import { approveStatement, ApprovalError } from '@/lib/financial-data-hub/services/approvalService';

// POST /api/financial-data-hub/documents/{documentId}/approve — FDH-7 spec
// sections 52-58, 63, 108-110. Statement approval is a deliberate user
// action gated server-side (never merely by a disabled button): blocking
// reconciliation/review/duplicate/transfer/split issues are re-checked
// against the live database, and the DB trigger
// `fdh7_guard_statement_approval` (migration 0076) is the real enforcement.
export async function POST(_req: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;

  try {
    const { statement } = await approveStatement(user.id, documentId);
    return ok({
      statement_id: statement.id,
      processing_status: statement.processing_status,
      approval_version: statement.approval_version,
      approved_at: statement.approved_at,
    });
  } catch (e) {
    if (e instanceof ApprovalError) {
      const status = e.code === 'not_found' ? 404 : e.code === 'blocked' ? 409 : 422;
      return Response.json({ error: e.message, details: e.details ?? null }, { status });
    }
    return bad('We could not approve this statement.', 500);
  }
}
