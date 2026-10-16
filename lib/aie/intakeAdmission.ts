/**
 * Premium Upload Entitlement -- the service-layer admission boundary for the four AIE intake routes.
 *
 * `admitIntake` is `createIntake` behind the central Premium capability: no intake row (and so nothing for a later
 * process step to find) exists for a user who is not Premium NOW, even if a route forgot its own guard. The four intake
 * routes call this instead of `createIntake` directly.
 *
 * It lives HERE and not inside `lib/aie/db/repository.ts` on purpose: that repository is (transitively) imported by a
 * client component through `lib/pc5/discard.ts`, and the capability reads the request-scoped session
 * (`next/headers`), which must never enter a client bundle. This file is server-only by its imports.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveFinancialImportAccess } from '@/lib/entitlements/financialDataImport';
import { createIntake } from '@/lib/aie/db/repository';

type CreateIntakeArgs = Parameters<typeof createIntake>;

export async function admitIntake(rlsClient: CreateIntakeArgs[0], params: CreateIntakeArgs[1]): Promise<{ id: string } | { error: string }> {
  const decision = await resolveFinancialImportAccess(params.userId, 'aie.service.create_intake');
  if (!decision.allowed) return { error: decision.code };
  return createIntake(rlsClient as SupabaseClient, params);
}
