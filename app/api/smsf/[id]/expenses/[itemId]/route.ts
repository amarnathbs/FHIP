import { entityExpenseHandlers } from '@/lib/services/entityCashFlowRoutes';

const h = entityExpenseHandlers('smsf');
export const PATCH = h.PATCH;
export const DELETE = h.DELETE;
