/**
 * Premium Upload Entitlement -- where an already-admitted AIE intake is in its run (see
 * lib/entitlements/financialDataImport.ts, `refuseUnlessImportRunMayStart`).
 *
 * An intake row exists only because an AIE intake route passed the Premium check. `quarantined` is the state in which
 * the intake waits for its first processing run (including a password it is still waiting for); every other state
 * is past that point (the route's own 409 rules apply and no new extraction starts). Not found / someone else's ->
 * 'unknown'.
 */

import type { AdmittedRunPosition } from '@/lib/entitlements/financialDataImport';
import { getIntakeForUser } from '@/lib/aie/db/repository';

export function runPositionForAieIntakeStatus(status: string | null | undefined): AdmittedRunPosition {
  if (status === 'quarantined') return 'first_run';
  if (typeof status === 'string' && status.length > 0) return 'in_flight';
  return 'unknown';
}

export async function aieIntakeRunPosition(userId: string, intakeId: string): Promise<AdmittedRunPosition> {
  const intake = await getIntakeForUser(intakeId, userId);
  if (!intake) return 'unknown';
  return runPositionForAieIntakeStatus(intake.status);
}
