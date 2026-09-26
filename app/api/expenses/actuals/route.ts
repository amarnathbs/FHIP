/**
 * WP-07 -- GET /api/expenses/actuals: the Expenses tab's "Actual (imported)"
 * section (EXP-G1 / DC-17).
 *
 * Reads the ONE canonical Expense read model (selectExpenses) with the
 * per-request cookie client, so RLS confines it to the caller, and every
 * query inside it is also filtered `.eq('user_id', user.id)`. It writes
 * nothing: approved imported transactions are shown straight from the
 * approved transaction layer, once each, and never copied into expense_items
 * (PO D-02).
 *
 * Query: ?page=&pageSize= (lines are paged; totals always cover every line),
 * ?group=<canonical group>&month=YYYY-MM (line filters).
 * A failed read is `{ status: 'unavailable' }` -- never $0 (DC-14).
 */
import { ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { selectExpenses } from '@/lib/read-models/expenses';
import { parseLinesQuery, toImportedActualsDto, type ImportedActualsDto } from '@/lib/expenses/importedActuals';

export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('EXPENSES', request);
  if (!user) return blocked!;
  const query = parseLinesQuery(new URL(request.url).searchParams);
  const client = await createClient();
  const model = await selectExpenses(user.id, { client, basis: 'combined' });
  const body: ImportedActualsDto = model.status === 'ok' ? toImportedActualsDto(model, query) : { status: 'unavailable', reason: model.reason };
  return ok(body);
}
