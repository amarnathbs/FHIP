-- App Review spec §15 (New-User Onboarding Flow) — existing-user safety net.
--
-- Old calculation → defect → corrected rule → expected new result:
--   Old: proxy.ts force-redirects any authenticated user whose
--   user_profiles.onboarding_completed is not true to /onboarding, for a
--   large set of matched app paths, with no other way in. The current
--   onboarding wizard only ever sets onboarding_completed=true from its own
--   final POST /api/onboarding/complete step. A user who already has real
--   financial data on file (added before this app-review pass, or via a
--   path that never called that endpoint) but whose onboarding_completed
--   is still false/null would be hard-blocked into the wizard despite
--   already having a working account — spec explicitly forbids this
--   ("existing users: do NOT force re-registration... a user with real
--   Income/Expenses/Assets rows already should not be forced through
--   onboarding").
--   Defect: onboarding_completed has no backfill path for accounts that
--   predate (or bypassed) the wizard's own completion step.
--   Corrected rule: one-time, non-destructive backfill — a user_profiles
--   row with onboarding_completed is not true is flipped to true only if
--   that user already has at least one row in any of the seven financial
--   registers (clear, unambiguous evidence of genuine prior engagement).
--   Never flips true -> false for anyone, and never touches a user with
--   zero rows anywhere (those genuinely are new/incomplete and still
--   belong in onboarding — status here truly can't be inferred as
--   "already done", so per spec they correctly keep going through it
--   rather than being guessed into a false "complete" state).
--   Expected new result: any pre-existing account with real data in at
--   least one register is no longer redirected to /onboarding on next
--   sign-in; accounts with no data anywhere are unaffected and still see
--   the wizard as before.
update user_profiles up
set onboarding_completed = true,
    updated_at = now()
where coalesce(up.onboarding_completed, false) = false
  and (
    exists (select 1 from income_sources r where r.user_id = up.user_id)
    or exists (select 1 from expense_items r where r.user_id = up.user_id)
    or exists (select 1 from assets r where r.user_id = up.user_id)
    or exists (select 1 from liabilities r where r.user_id = up.user_id)
    or exists (select 1 from investments r where r.user_id = up.user_id)
    or exists (select 1 from retirement_accounts r where r.user_id = up.user_id)
    or exists (select 1 from insurance_policies r where r.user_id = up.user_id)
  );
