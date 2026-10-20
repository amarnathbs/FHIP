import { entityExpenseHandlers } from '@/lib/services/entityCashFlowRoutes';

const h = entityExpenseHandlers('business');
export const PATCH = h.PATCH;
export const DELETE = h.DELETE;
