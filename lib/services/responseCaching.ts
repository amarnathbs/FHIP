// Which responses a shared cache (CloudFront in front of Amplify) must never keep (26-11-2026).
//
// On production /onboarding was a STATIC page, so Next.js sent it with `Cache-Control: s-maxage=31536000` (one year). proxy.ts runs behind the CDN, so a saved copy is served without the proxy ever
// running again: its decision ("a completed profile leaves /onboarding for /dashboard", "not signed in goes to /login") simply stops happening. The user's browser received a copy with
// `Age: 105541`: saved at the same second as the failed profile read in the Supabase log, 29 hours earlier. Every OAuth sign-in lands on /onboarding (app/auth/callback), so a completed user saw the
// blank wizard on each sign-in. Next's own guide says it: if the proxy sits behind the CDN, routes that depend on its decisions must not be cached there.
//
// The same local reproduction showed a second risk: when the proxy refreshes a session while a static PUBLIC page loads (/login, /terms, ...), the response carries the new session cookie AND
// `s-maxage=31536000`, so a shared cache is allowed to keep that cookie and hand it to the next visitor.
//
// So the proxy marks a response as private whenever ANY of these is true:
//   * the path is one whose outcome the proxy decides per user (the signed-in app routes);
//   * the request carried a session cookie (a signed-in visitor, the OAuth callback with its code verifier, API calls);
//   * the response writes cookies.
// Anonymous requests for public pages keep their normal caching.

export const PRIVATE_CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

/** The cookies @supabase/ssr writes: `sb-<project>-auth-token`, its numbered chunks and the PKCE `-code-verifier`. */
const SESSION_COOKIE_NAME = /^sb-.+-auth-token/;

export interface ResponseCachingFacts {
  isAppRoute: boolean;
  requestCookieNames: readonly string[];
  responseCookieCount: number;
}

/** True when the response must not be kept by a shared cache. Pure. */
export function mustNotBeShared({ isAppRoute, requestCookieNames, responseCookieCount }: ResponseCachingFacts): boolean {
  return isAppRoute || responseCookieCount > 0 || requestCookieNames.some((name) => SESSION_COOKIE_NAME.test(name));
}
