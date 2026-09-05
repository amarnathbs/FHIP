'use client';

import { FinancialDataGrid } from '@/components/grid/FinancialDataGrid';
import { expenseGridConfig } from '@/lib/grid/configs';

export default function ExpensesPage() {
  return <FinancialDataGrid config={expenseGridConfig} moduleKey="EXPENSES" />;
}
