import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// Lands here after a user completes an OAuth provider's consent screen
// (Google, Facebook, LinkedIn) — signInWithOAuth() on the client sends them
// to the provider, the provider redirects back to Supabase, and Supabase
// redirects here with a one-time `code` in the query string. Exchanging it
// server-side (not in the browser) is what actually establishes the
// session cookie via the server client's cookie handlers.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  // Where to send the user after a successful sign-in — defaults to
  // onboarding since new-via-OAuth users have no profile yet; the
  // onboarding page itself already redirects straight to /dashboard for
  // anyone who has already completed it.
  const next = searchParams.get('next') ?? '/onboarding';

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}
