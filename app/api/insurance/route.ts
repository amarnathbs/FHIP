import { ok, bad } from '@/lib/api';
import { makeRegistry } from '@/lib/services/registry';
import { insuranceSchema } from '@/lib/validation/insurance';
import { requireModuleCapability } from '@/lib/services/appCapability';

const registry = makeRegistry('insurance_policies');

// G4: migrated onto the manifest-driven resolver (Insurance is
// UNIVERSAL_MODULES -- no country_code/currency_code field anywhere in this
// module, see lib/services/appCapability.ts's manifest entry). While the G4
// flag is off this behaves byte-identically to the prior
// requireCountryConfirmedUser() gate.
export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('INSURANCE', request);
  if (!user) return blocked!;
  const { data, error } = await registry.list(user.id);
  return error ? bad(error.message) : ok(data);
}

export async function POST(req: Request) {
  const { user, blocked } = await requireModuleCapability('INSURANCE', req);
  if (!user) return blocked!;
  const parsed = insuranceSchema.safeParse(await req.json());
  if (!parsed.success) return bad(parsed.error.message, 422);
  const { data, error } = await registry.save(user.id, parsed.data);
  return error ? bad(error.message) : ok(data);
}
