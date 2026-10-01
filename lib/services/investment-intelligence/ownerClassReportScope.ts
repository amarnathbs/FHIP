/**
 * Premium report: which client the four Investment Intelligence chapters run on (2026-10-01, PO decision).
 *
 * A user with NO trust / HUF / company accounts gets the client UNCHANGED (zero behaviour change). Otherwise
 * the client is a read-only view narrowed to the household's non-entity accounts, so the certified loaders and
 * engines run unchanged on those rows only and entity-owned data is never silently summed into the personal
 * chapters. The owner-class breakup (every class as its own item + the macro line) is returned alongside.
 * Kept out of investmentIntelligenceReportData.ts so that module's own contract and tests are untouched.
 */
import type { SupabaseServerClient } from '@/lib/services/dashboardData';
import { loadOwnerBreakup, loadOwnerClassContext, nonEntityScopeAccountIds, scopeClientToAccounts, type OwnerBreakup } from './ownerClass';

export async function loadOwnerClassScopeForReport(userId: string, supabase: SupabaseServerClient): Promise<{ client: SupabaseServerClient; breakup: OwnerBreakup | null }> {
  const ctx = await loadOwnerClassContext(supabase, userId);
  const hasEntity = ctx.classes.some((c) => c.kind === 'entity' || c.kind === 'entity_shared');
  const breakup = ctx.classes.length > 1 ? await loadOwnerBreakup(supabase, userId).catch(() => null) : null;
  if (!hasEntity) return { client: supabase, breakup };
  return { client: scopeClientToAccounts(supabase, nonEntityScopeAccountIds(ctx)), breakup };
}
