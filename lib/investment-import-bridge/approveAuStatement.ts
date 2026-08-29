/**
 * FDH-11 bridge — approving AU statement EVIDENCE (spec sections 63, 76).
 * Moves `fdh_investment_statements.approval_status` from 'pending' to
 * 'approved'. Canonical Investment Intelligence is UNCHANGED by this call —
 * approval only unlocks the separate, explicit Apply step
 * (`applyAuStatementActivity.ts`/`applyAuStatementPosition.ts`); it never
 * itself writes a canonical row.
 */

import { createAdminClient } from '@/lib/supabase/admin';

export async function approveAuStatement(userId: string, statementId: string): Promise<{ ok: boolean; error: string | null }> {
  const admin = createAdminClient();
  const { data: statement, error: fetchErr } = await admin
    .from('fdh_investment_statements')
    .select('id, user_id, approval_status')
    .eq('id', statementId)
    .eq('user_id', userId)
    .maybeSingle();
  if (fetchErr || !statement) return { ok: false, error: fetchErr?.message ?? 'Statement not found.' };
  if (statement.approval_status === 'approved') return { ok: true, error: null };

  const { error: updateErr } = await admin
    .from('fdh_investment_statements')
    .update({ approval_status: 'approved', approved_at: new Date().toISOString(), approved_by: userId })
    .eq('id', statementId)
    .eq('approval_status', 'pending');
  if (updateErr) return { ok: false, error: updateErr.message };
  return { ok: true, error: null };
}
