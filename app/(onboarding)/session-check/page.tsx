import { PageBackLink } from '@/components/navigation/PageBackLink';
import { safeInternalPath } from '@/lib/services/profileReadOutcome';
import { SessionCheck } from './SessionCheck';

// /session-check (25-11-2026). proxy.ts sends a signed-in visitor here when their profile READ failed (not when the profile is missing): the data API once refused a token issued only
// seconds earlier. The page tells them their data is safe, tries the page they wanted again after a short wait (up to four spaced tries) and then asks them to try again. It lives under the
// (onboarding) route group (no AppShell chrome), is NOT matched by the proxy's app-route list (so it can never redirect to itself), reads nothing from the database and shows nothing about the
// visitor. The destination comes from the query string and is accepted only as a same-origin path (safeInternalPath): this is not an open redirect.
export const metadata = { title: 'Checking your sign-in | FHIP', robots: { index: false, follow: false } };

export default async function SessionCheckPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  return (
    <>
      <PageBackLink href="/login" label="sign in" className="mx-auto max-w-xl px-4 pt-8" />
      <SessionCheck next={safeInternalPath(raw)} />
    </>
  );
}
