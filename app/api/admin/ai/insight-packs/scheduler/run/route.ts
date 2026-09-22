// Module 11 remediation R4 — POST /api/admin/ai/insight-packs/scheduler/run:
// the admin manual trigger for the R3 scheduler (brief section 33 "manually-
// triggerable DEV certification path"; ADR-M11-002).
//
// Gated on can_manage_ai_operations (Standard §2/§5: a config-adjacent
// action, not a read) AND on requireAdmin() (the existing Super Admin
// boundary every AI write route carries — this route does not widen it).
// Runs are recorded in ai_insight_pack_scheduler_runs with
// triggered_by='admin' (auditable). scheduler_enabled is deliberately NOT
// required for an admin-triggered run (it gates the unattended cron), but
// ai_globally_enabled / batch_generation_enabled and every per-household
// admission gate still apply.
//
// Body: { phase: 'submit'|'reconcile', dryRun?: boolean, maxHouseholds?: number, billingPeriod?: 'YYYY-MM', reason: string }
// `reason` is required for a non-dry-run submit (spec section 75 precedent:
// an audit trail says WHY a human started a spend-incurring job).
import { requireAdmin, adminRoute } from '@/lib/services/adminAuth';
import { requireAiOperationsManager } from '@/lib/services/aiOperationsAdmin';
import { ok, bad } from '@/lib/api';
import { createSchedulerService, getModule11SchedulerMaxHouseholdsPerRun } from '@/lib/ai/insightPack/scheduler';

export const POST = adminRoute(async (req: Request) => {
  const manage = await requireAiOperationsManager();
  if (manage.forbidden) return manage.forbidden;
  const { forbidden } = await requireAdmin();
  if (forbidden) return forbidden;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return bad('A JSON body is required', 422);
  const phase = body.phase === 'submit' || body.phase === 'reconcile' ? body.phase : null;
  if (!phase) return bad("phase must be 'submit' or 'reconcile'", 422);
  const dryRun = body.dryRun === true;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (phase === 'submit' && !dryRun && !reason) return bad('reason is required for a non-dry-run submit', 422);
  const maxHouseholds = typeof body.maxHouseholds === 'number' && body.maxHouseholds > 0 ? Math.min(Math.floor(body.maxHouseholds), 500) : getModule11SchedulerMaxHouseholdsPerRun();
  const billingPeriod = typeof body.billingPeriod === 'string' && /^\d{4}-\d{2}$/.test(body.billingPeriod) ? body.billingPeriod : undefined;

  const service = createSchedulerService();
  const result = phase === 'submit'
    ? await service.runSubmitPhase({ triggeredBy: 'admin', dryRun, maxHouseholds, billingPeriod })
    : await service.runReconcilePhase({ triggeredBy: 'admin', billingPeriod });
  return ok({ phase, reason: reason || null, result });
});
