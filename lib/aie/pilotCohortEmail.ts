/**
 * AIE-1 final production completion (2026-09-25) -- resolves the caller's
 * email for the shared AIE pilot-cohort check, for call sites that only hold
 * a user id.
 *
 * DEFECT IT CLOSES. `isUserInAiePilotCohort` admits a user by id OR by email.
 * Production configures the cohort by EMAIL only (`AIE_PILOT_COHORT_EMAILS`),
 * but the five FDH document AI-fallback paths (payslip inline, and bank-PDF /
 * AU investment / liability / retirement through `evaluateAiFallbackGate`)
 * and the Insurance intake route passed only the user id. With an email-only
 * allowlist every one of those paths denied EVERY user -- including the two
 * pilot users -- as `cohort_denied`, so enabling a per-class AI flag in
 * production would have done nothing, silently.
 *
 * The lookup only happens when it can change the answer: enforcement is on,
 * the id is not already listed, and an email allowlist exists. It uses the
 * service-role Auth admin API (the user id has already been authenticated by
 * the calling route); on any failure it returns null, which can only DENY
 * (fail closed), never admit.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import { isAiePilotCohortEnforced, isUserInAiePilotCohort } from './featureFlags';

export async function resolveEmailForAiePilotCohort(userId: string): Promise<string | null> {
  if (!isAiePilotCohortEnforced()) return null;
  if (isUserInAiePilotCohort({ userId })) return null;
  if (!(process.env.AIE_PILOT_COHORT_EMAILS ?? '').trim()) return null;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user?.email) return null;
    return data.user.email;
  } catch {
    return null;
  }
}

/** Convenience: full cohort decision for a user id, resolving the email only
 * when needed. */
export async function isUserIdInAiePilotCohort(userId: string): Promise<boolean> {
  if (isUserInAiePilotCohort({ userId })) return true;
  const email = await resolveEmailForAiePilotCohort(userId);
  return email ? isUserInAiePilotCohort({ userId, email }) : false;
}
