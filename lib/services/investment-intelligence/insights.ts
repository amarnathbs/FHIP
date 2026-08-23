import { createClient } from '@/lib/supabase/server';

export interface IiInsightRow {
  id: string;
  classification: string;
  status: string;
  gated: boolean;
  compliance_approved_at: string | null;
  [key: string]: unknown;
}

// ADR-007's structural gate is enforced twice, deliberately: the database
// check constraint (chk_ii_insights_advice_gated, migration 0035) makes it
// impossible to INSERT a personalised_advice row with gated=false at all;
// this function is the second, independent layer — it refuses to RETURN a
// personalised_advice row to any consumer-facing caller unless
// compliance_approved_at is actually set, per ADR-007's own testing
// requirement ("a personalised_advice row with compliance_approved_at IS
// NULL cannot be returned by any consumer-facing query path"). Pure —
// unit-testable without a DB round trip.
export function filterConsumerVisibleInsights<T extends IiInsightRow>(rows: T[]): T[] {
  return rows.filter((row) => {
    if (row.status !== 'active') return false;
    if (row.classification === 'personalised_advice') {
      return row.gated === true && row.compliance_approved_at !== null;
    }
    return true;
  });
}

export async function listConsumerVisibleInsights(userId: string): Promise<{ data: IiInsightRow[]; error: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from('ii_insights').select('*').eq('user_id', userId);
  if (error) return { data: [], error: error.message };
  return { data: filterConsumerVisibleInsights((data ?? []) as IiInsightRow[]), error: null };
}
