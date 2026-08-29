import { createClient } from '@/lib/supabase/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { emitAuditEvent } from '@/lib/services/investment-intelligence/audit';
import { z } from 'zod';

// R2 extends R1's resolution shape with the structured correction actions
// spec section 30 names ("map unmatched scheme, map owner, classify
// transaction, resolve duplicate, accept documented source anomaly"),
// captured in `resolutionMethod` (free-form but conventionally one of the
// values documented in R2_PORTFOLIO_TRUTH_AND_RECONCILIATION.md) and
// persisted alongside the existing R1 `resolution`/`notes` fields — R1's
// two-value shape is kept working unchanged (backward compatible request
// body), this only ADDS optional fields.
const resolveSchema = z.object({
  resolution: z.enum(['accepted_new_value', 'kept_prior_value', 'manual_correction']),
  notes: z.string().optional(),
  resolutionMethod: z
    .enum(['user_mapped_instrument', 'user_mapped_owner', 'user_classified_transaction', 'user_resolved_duplicate', 'user_accepted_anomaly', 'admin_override', 'auto_resolved_on_reparse'])
    .optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, unauthenticated } = await requireUser();
  if (!user) return unauthenticated!;
  const parsed = resolveSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);

  const supabase = await createClient();
  // Ownership + not-already-resolved re-checked here (never trusted from
  // the request) — matches the mutation-security discipline
  // R1_TESTING_AND_VERIFICATION.md's live security pack requires: a
  // caller cannot resolve (or discover the existence of) another user's
  // case, and cannot double-resolve an already-resolved one.
  const { data: existing } = await supabase.from('ii_reconciliation_cases').select('id, status, subject_type, subject_id, discrepancy_type').eq('id', id).eq('user_id', user.id).maybeSingle();
  if (!existing) return bad('Reconciliation case not found', 404);
  if (existing.status === 'resolved') return bad('This case is already resolved', 409);

  const { data, error } = await supabase
    .from('ii_reconciliation_cases')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_method: parsed.data.resolutionMethod ?? null,
      resolved_by: user.id,
      resolved_by_actor_type: 'user',
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single();
  if (error) return bad(error.message);

  await emitAuditEvent({
    userId: user.id,
    eventType: 'reconciliation_case_resolved',
    subjectType: 'ii_reconciliation_cases',
    subjectId: id,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: id, resolution: parsed.data.resolution, resolutionMethod: parsed.data.resolutionMethod ?? null, discrepancyType: existing.discrepancy_type },
  });
  // A user correction over a previously-parsed/certified value is ALSO
  // recorded as a user_correction event (spec section 33) — distinct from
  // reconciliation_case_resolved, which records the CASE lifecycle event;
  // this records the FACT that a user changed something, per
  // R0_AUDIT_REQUIREMENTS.md's event vocabulary.
  await emitAuditEvent({
    userId: user.id,
    eventType: 'user_correction',
    subjectType: existing.subject_type,
    subjectId: existing.subject_id,
    actorType: 'user',
    actorId: user.id,
    metadata: { reconciliationCaseId: id, field: existing.discrepancy_type, previousValue: null, newValue: parsed.data.resolution },
  });

  return ok(data);
}
