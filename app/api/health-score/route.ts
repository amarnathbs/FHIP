import { ok, bad } from '@/lib/api';
import { loadHealthScore } from '@/lib/services/healthScoreData';
import { requireModuleCapability } from '@/lib/services/appCapability';

// G4: migrated onto the manifest-driven resolver (Scores is
// UNIVERSAL_MODULES -- see lib/services/appCapability.ts's manifest entry
// for why the underlying loadDashboard() currency/FX assumption is provably
// inert for a GENERIC user). While the G4 flag is off this behaves
// byte-identically to the prior requireCountryConfirmedUser() gate.
export async function GET(request: Request) {
  const { user, blocked } = await requireModuleCapability('SCORES', request);
  if (!user) return blocked!;
  try {
    const payload = await loadHealthScore(user.id);
    return ok(payload);
  } catch (e) {
    return bad(e instanceof Error ? e.message : 'Could not load health score');
  }
}
