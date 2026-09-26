/**
 * WP-09 -- GET /api/income/actuals: the Income tab's "Actual income from bank
 * statements" section (GAP-06).
 *
 * Reads the ONE canonical Income read model (selectIncome) with the
 * per-request cookie client, so RLS confines it to the caller, and every query
 * inside it is also filtered `.eq('user_id', user.id)`. It writes nothing:
 * approved bank credits are shown straight from the approved transaction
 * layer, a credit that is a payslip's pay is marked "counted once with
 * payslip" (never added twice), and nothing is copied into income_sources.
 * A failed read is `{ status: 'unavailable' }` -- never $0.
 */
import { ok } from '@/lib/api';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { createClient } from '@/lib/supabase/server';
import { selectIncome } from '@/lib/read-models/income';
import { toIncomeActualsDto, type IncomeActualsDto } from '@/lib/income/importedIncomeActuals';

export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('INCOME', request);
  if (!user) return blocked!;
  const client = await createClient();
  const model = await selectIncome(user.id, { client });
  const body: IncomeActualsDto = model.status === 'ok' ? toIncomeActualsDto(model) : { status: 'unavailable', reason: model.reason };
  return ok(body);
}
