import { ok } from '@/lib/api';

const REPORT_TYPES = [
  { code: 'monthly_financial_health', label: 'Monthly Financial Health Report' },
  { code: 'financial_health_score', label: 'Financial Health Score Report' },
  { code: 'goal_progress', label: 'Goal Progress Report' },
  { code: 'net_worth', label: 'Net Worth Report' },
];

export async function GET() {
  return ok(REPORT_TYPES);
}
