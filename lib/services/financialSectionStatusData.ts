// Phase 0C: I/O layer for the canonical per-section review status
// (user_financial_section_status, migration 0031). Combines the explicit
// confirmations stored there with the real row-presence flags dashboardData
// already computes, via effectiveSectionStatus() — see
// lib/engines/financialSectionStatus.ts for why this two-source combination
// exists rather than a single stored "status" column.
import { createClient } from '@/lib/supabase/server';
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import type { DashboardSummary } from '@/lib/engines/dashboard';
import {
  ALL_SECTIONS,
  effectiveSectionStatus,
  type ExplicitSectionConfirmation,
  type FinancialSection,
  type FinancialSectionStatus,
} from '@/lib/engines/financialSectionStatus';

interface SectionStatusRow {
  section: FinancialSection;
  status: ExplicitSectionConfirmation;
}

// dashboard.hasX flags cover income/expenses/assets/liabilities/investments/
// retirement/insurance directly. 'household' has no equivalent row-backed
// category (it's a single profile/household record, not a register) — it's
// treated as reviewed once the household record itself exists, which
// onboarding already guarantees for every authenticated user, so it's
// always 'reviewed_with_data' here and never blocks eligibility.
function hasRowsForSection(section: FinancialSection, dashboard: DashboardSummary): boolean {
  switch (section) {
    case 'household':
      return true;
    case 'income':
      return dashboard.hasIncome;
    case 'expenses':
      return dashboard.hasExpenses;
    case 'assets':
      return dashboard.hasAssets;
    case 'liabilities':
      return dashboard.hasLiabilities;
    case 'investments':
      return dashboard.hasInvestments;
    case 'retirement':
      return dashboard.hasRetirement;
    case 'insurance':
      return dashboard.hasInsurance;
    default:
      return false;
  }
}

// Loads the explicit confirmations a user has set and combines them with
// dashboard's row-presence flags into the full 8-section status map the
// Health Score / Resilience engines and the eligibility layer consume.
export async function loadSectionStatus(
  userId: string,
  dashboard: DashboardSummary,
  client?: SupabaseServerClient
): Promise<Record<FinancialSection, FinancialSectionStatus>> {
  const supabase = client ?? (await createClient());
  const { data } = await supabase
    .from('user_financial_section_status')
    .select('section, status')
    .eq('user_id', userId);

  const explicit = new Map<FinancialSection, ExplicitSectionConfirmation>(
    ((data as SectionStatusRow[] | null) ?? []).map((row) => [row.section, row.status])
  );

  const result = {} as Record<FinancialSection, FinancialSectionStatus>;
  for (const section of ALL_SECTIONS) {
    result[section] = effectiveSectionStatus({
      hasRows: hasRowsForSection(section, dashboard),
      explicitConfirmation: explicit.get(section) ?? null,
    });
  }
  return result;
}

// Sets (or clears) an explicit confirmation for one section. Reversible by
// design (Phase 0C §34) — passing null deletes the row, letting the status
// fall back to whatever hasRows alone would derive.
export async function setSectionConfirmation(
  userId: string,
  section: FinancialSection,
  confirmation: ExplicitSectionConfirmation | null,
  client?: SupabaseServerClient
): Promise<void> {
  const supabase = client ?? (await createClient());
  if (confirmation === null) {
    await supabase.from('user_financial_section_status').delete().eq('user_id', userId).eq('section', section);
    return;
  }
  await supabase
    .from('user_financial_section_status')
    .upsert(
      { user_id: userId, section, status: confirmation, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,section' }
    );
}
