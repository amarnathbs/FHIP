import { entityIncomeHandlers } from '@/lib/services/entityCashFlowRoutes';

// Entity-level income (migration 0296). Entity scoped, never part of personal Income.
const h = entityIncomeHandlers('business');
export const GET = h.GET;
export const POST = h.POST;
