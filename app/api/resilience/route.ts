import { ok, bad } from '@/lib/api';
import { loadResilience } from '@/lib/services/resilienceData';
import { requireModuleCapability } from '@/lib/services/appCapability';

// G4: migrated onto the manifest-driven resolver (Resilience is
// UNIVERSAL_MODULES -- see lib/services/appCapability.ts's manifest entry).
// While the G4 flag is off this behaves byte-identically to the prior
// requireCountryConfirmedUser() gate.
export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('RESILIENCE', request);
  if (!user) return blocked!;
  try {
    const payload = await loadResilience(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load resilience score');
  }
}
