import { entityExpenseHandlers } from '@/lib/services/entityCashFlowRoutes';

// Entity-level expenses (migration 0296). Entity scoped, never part of personal Expenses. There is no loan repayment type: principal is cash flow.
const h = entityExpenseHandlers('smsf');
export const GET = h.GET;
export const POST = h.POST;
