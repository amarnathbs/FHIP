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
      // `origin` above comes from the raw incoming request URL — behind AWS
      // Amplify's proxy/load-balancer hosting, that can reflect the Next.js
      // server's own internal address (e.g. localhost) rather than the
      // public domain the visitor actually used. `x-forwarded-host` is the
      // header the proxy sets to the real public host, so prefer it outside
      // local dev — this is Supabase's own documented pattern for exactly
      // this class of deployment. See
      // https://supabase.com/docs/guides/auth/server-side/nextjs
      const forwardedHost = request.headers.get('x-forwarded-host');
      const forwardedProto = request.headers.get('x-forwarded-proto') ?? 'https';
      const isLocalEnv = process.env.NODE_ENV === 'development';
      if (!isLocalEnv && forwardedHost) {
        return NextResponse.redirect(`${forwardedProto}://${forwardedHost}${next}`);
      }
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=oauth_failed`);
}
