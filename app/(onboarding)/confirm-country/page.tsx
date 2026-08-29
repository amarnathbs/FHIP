import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { assertCountryConfirmedForUser } from '@/lib/services/countryGate';
import { ConfirmCountryForm } from './ConfirmCountryForm';

// Mandatory Country Confirmation — the compulsory screen itself. Lives under
// the (onboarding) route group deliberately (same reasoning as
// app/(onboarding)/onboarding: a distraction-free flow with no AppShell
// chrome), NOT under app/(app) — putting it there would mean app/(app)/
// layout.tsx's own redirect-to-here would apply to this page too, an
// infinite redirect loop (spec 5.4: "avoid redirect loops").
//
// Server-rendered classification (never client-guessed) decides what to
// show: a user who is already CONFIRMED is bounced straight to /dashboard
// (defends against someone bookmarking this URL or using browser back after
// confirming); PROFILE_INCOMPLETE/DB_ERROR fall back to /onboarding, since
// this page has nothing meaningful to update without a profile row.
export default async function ConfirmCountryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const gate = await assertCountryConfirmedForUser(supabase, user.id);

  if (gate.state === 'CONFIRMED') redirect('/dashboard');
  if (gate.state === 'PROFILE_INCOMPLETE' || gate.state === 'DB_ERROR') redirect('/onboarding');

  return (
    <ConfirmCountryForm
      initialState={gate.state}
      currentCountry={gate.countryOfResidence}
    />
  );
}
