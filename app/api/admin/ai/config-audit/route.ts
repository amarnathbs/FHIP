// Module 11.1 — GET /api/admin/ai/config-audit  (spec sections 33, 59).
//
// The append-only history of every AI operational control change: which
// setting, its previous value, its new value, who changed it, when, and why
// where a reason was given.
//
// The rows are written by a database trigger, not by application code, so this
// history cannot be incomplete because a new write path forgot to log. The
// table also refuses UPDATE and DELETE by trigger, so what is read here is
// what was written.
//
// NO SECRETS (section 59). The audited tables hold switches, ceilings and
// prices only; no provider API key is stored in the database at any point.

import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { ok, bad } from '@/lib/api';
import { listConfigAudit } from '@/lib/ai/entitlement/platformControls';

export const GET = adminRoute(async (req: Request) => {
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;
  const limit = Number(new URL(req.url).searchParams.get('limit') ?? 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return bad('limit must be an integer between 1 and 1000', 422);
  return ok({ changes: await listConfigAudit(limit) });
});
