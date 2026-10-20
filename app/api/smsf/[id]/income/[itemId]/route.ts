import { entityIncomeHandlers } from '@/lib/services/entityCashFlowRoutes';

const h = entityIncomeHandlers('smsf');
export const PATCH = h.PATCH;
// Soft retire (is_active = false), the audit trail keeps the record.
export const DELETE = h.DELETE;
