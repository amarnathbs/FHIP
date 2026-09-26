/**
 * WP-09 -- GET /api/income/{id}/payslip: the payslip behind an Income row
 * that was Applied from a payslip (GAP-07). Follows the row's own provenance
 * (income_sources.last_import_application_id -> the application's payroll
 * event) and returns every extracted figure with its component lines, for the
 * Payslip details view. Read-only and user-scoped; 404 for a manual row.
 */
import { bad, ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { getPayslipDetailsForIncomeSource } from '@/lib/import-bridge/incomeProposalService';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, blocked } = await requireModuleCapability('INCOME', request);
  if (!user) return blocked!;
  const details = await getPayslipDetailsForIncomeSource(user.id, id);
  if (!details) return bad('This income entry was not imported from a payslip.', 404);
  return ok(details);
}
