import { requireCountryConfirmedUser as requireUser, bad, ok } from '@/lib/api';
import { listWaitingImports, type WaitingImportKind } from '@/lib/financial-data-hub/services/waitingImports';

const KINDS: readonly WaitingImportKind[] = ['liability', 'retirement', 'investment', 'bank'];

// GET /api/financial-data-hub/waiting-imports?kind=liability|retirement|investment|bank
//
// 2026-09-25: the statement imports this user left part-way through (an AI
// reading awaiting a check, evidence awaiting approval, a comparison never
// applied), so each statement panel can offer to continue one after a reload
// -- the statement-type counterpart of the payslip panel's waiting list
// (GET /income-proposals). Read-only; never gated by the upload flag, so a
// user can always finish what they started.
export async function GET(req: Request) {
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const kind = new URL(req.url).searchParams.get('kind') as WaitingImportKind | null;
  if (!kind || !KINDS.includes(kind)) return bad('Unknown import kind.', 422);
  const items = await listWaitingImports(user.id, kind);
  return ok({ items });
}
