import { redirect } from 'next/navigation';
import { AppShell } from '@/components/ui/AppShell';
import { createClient } from '@/lib/supabase/server';
import { assertCountryConfirmedForUser, shouldRedirectToConfirmCountry } from '@/lib/services/countryGate';

// AppShell lives here (not wrapped individually in each page.tsx) so the
// sidebar survives client-side navigation instead of unmounting and
// remounting on every route change — the previous per-page wrapping pattern
// meant AppShell's open-dropdown/scroll state reset on every click, even
// though the code looked like it should persist. onboarding is deliberately
// NOT under this route group (moved to app/(onboarding)/) since it's a
// distraction-free wizard flow that has never shown the app chrome.
//
// Mandatory Country Confirmation (Product Owner decision, 2026-08-29) — THE
// canonical UI-layer access decision. This route group contains every page
// under app/(app)/** (dashboard, all financial modules, admin) — a server
// component here runs before any child page renders, so this is the one
// place that structurally cannot be bypassed by adding a new page later or
// by proxy.ts's route-name allowlist drifting out of date (verification
// found that list already missing the Financial Data Hub route prefix, investment-
// intelligence, forecast and profile — see the closure report's section 9
// verification evidence; left unmodified as a pre-existing, unrelated
// defect, not touched by this task).
//
// Admin is deliberately included in this gate, not exempted: the repository
// was searched for a separately controlled administrator path that would
// let an admin user reach remediation tooling while their OWN country is
// unconfirmed, and none exists (app/(app)/admin/** shares this exact layout
// and proxy.ts route group; docs/admin/FHIP_Admin_Module_Discovery_Report_
// 2026-08-29.md confirms no middleware/layout distinguishes it). Per spec
// section 1.2, admin is denied "unless the repository proves that a
// separately controlled administrator path is required for remediation" —
// it does not, so it is denied like every other module here.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Defensive re-check — proxy.ts already redirects an unauthenticated
  // request away from every app route, but spec section 5.4 requires this
  // layer to independently enforce the rule too, not rely on middleware
  // alone.
  if (!user) redirect('/login');

  const gate = await assertCountryConfirmedForUser(supabase, user.id);

  // While onboarding itself is incomplete, proxy.ts already confines the
  // user to /onboarding — this layout only covers app/(app)/**, which
  // proxy.ts won't let an unonboarded user reach in the first place. This
  // check stays as defense in depth (spec 5.4: "a stale client state cannot
  // bypass it") without needing to know proxy.ts's onboarding flag itself.
  //
  // MCC-12 fix: the redirect decision is delegated to
  // shouldRedirectToConfirmCountry() rather than inlined here, specifically
  // because the inlined `gate.state !== 'CONFIRMED' && gate.onboardingCompleted`
  // form of this check is what silently failed OPEN for DB_ERROR and
  // PROFILE_INCOMPLETE (see that function's own comment and the closure
  // report's Issue Register).
  if (shouldRedirectToConfirmCountry(gate)) {
    redirect('/confirm-country');
  }

  return <AppShell>{children}</AppShell>;
}
