import { ok, bad, badValidation } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { expenseSchema } from '@/lib/validation/expense';
import { defaultIsEssentialForExpenseItem } from '@/lib/engines/dashboard';
import { requireModuleCapability } from '@/lib/services/appCapability';
import { entityOwnerRefusal, existingOwnerForMasterItem } from '@/lib/services/entityOwnerGuard';
import { createClient } from '@/lib/supabase/server';

const registry = makeRegistry('expense_items');

// G4: migrated onto the manifest-driven resolver (Expenses is
// UNIVERSAL_MODULES -- no country_code/currency_code field anywhere in this
// module, see lib/services/appCapability.ts's manifest entry). While the G4
// flag is off this behaves byte-identically to the prior
// requireCountryConfirmedUser() gate.
export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('EXPENSES', request);
  if (!user) return blocked!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, blocked } = await requireModuleCapability('EXPENSES', req);
  if (!user) return blocked!;
  const parsed = expenseSchema.safeParse(await req.json());
  if (!parsed.success) return badValidation(parsed.error, 422);
  // F23: an SMSF / trust / HUF / company expense is entered on the entity, never in personal Expenses.
  const refused = entityOwnerRefusal('expenses', parsed.data.owner, await existingOwnerForMasterItem(await createClient(), 'expense_items', user.id, parsed.data.master_item_key));
  if (refused) return refused;
  const row = { ...parsed.data, is_essential: parsed.data.is_essential ?? defaultIsEssentialForExpenseItem(parsed.data.master_item_key) };
  const { data, error } = await registry.save(user.id, row);
  return error ? bad(error.message) : ok(data);
}
