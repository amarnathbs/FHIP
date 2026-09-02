import type { Metadata } from 'next';
import { headers, cookies } from 'next/headers';
import { Inter, Newsreader } from 'next/font/google';
import LandingPage from '@/components/marketing/LandingPage';
import { createClient } from '@/lib/supabase/server';
import { isG2LandingLocalisationEnabled } from '@/lib/services/landingLocalisationFlag';
import { resolveLandingCountryContextForRequest } from '@/lib/services/landingCountryContextServer';
import { LANDING_COUNTRY_COOKIE_NAME } from '@/lib/services/landingCountryContext';

const inter = Inter({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-inter',
  display: 'swap',
});
const newsreader = Newsreader({
  subsets: ['latin'],
  weight: ['600', '700'],
  style: ['normal'],
  variable: '--font-newsreader',
  display: 'swap',
});
const newsreaderItalic = Newsreader({
  subsets: ['latin'],
  weight: ['500'],
  style: ['italic'],
  variable: '--font-newsreader-italic',
  display: 'swap',
});

// SEO title/description per the reviewed FHIP_Landing_Page_Design_Options_Review_Pack.docx
// (section 16.1, "Search and social preview recommendations").
//
// myfhip.com short-brand update: the browser/share title is now the short
// "FHIP | Financial Health" form (was the long descriptive title). The
// original longer value proposition is preserved in `description` and in
// the landing page's own hero copy — only the title/share-card headline
// shortened, per the approved branding update.
// Phase 9/17: canonical stays the real, semantically-correct served URL
// (the application root) — it is not forced to point at the myfhip.com
// marketing domain, per spec §9's explicit rule against claiming an
// unrelated canonical URL merely to consolidate SEO. openGraph.url added
// for the same reason share-card scrapers can resolve an absolute URL now
// that the root layout sets metadataBase (see app/layout.tsx).
export const metadata: Metadata = {
  title: 'FHIP | Financial Health',
  description:
    'See income, expenses, assets, debts, investments, insurance and goals in one clear financial health view. Start free and upgrade for deeper forecasts, scenarios and reports.',
  alternates: { canonical: '/' },
  openGraph: {
    title: 'FHIP | Financial Health',
    description: 'A clear view of today’s financial position, priority actions and possible future paths.',
    siteName: 'FHIP',
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'FHIP | Financial Health',
    description: 'A clear view of today’s financial position, priority actions and possible future paths.',
  },
};

// G2 — Landing-Page Localisation (spec section 4-5). Country resolution
// only runs when the feature flag is on (default OFF — see
// lib/services/landingLocalisationFlag.ts); with the flag off,
// `countryContext` stays null and LandingPage renders its exact pre-G2
// markup, so disabling the flag has zero behavioural difference from
// before this task, with no cookie/detection code path ever touched.
//
// This is a server component precisely so country resolution (G1
// authenticated lookup, registry read, cookie/header validation) happens
// server-side before any HTML is sent — the client never re-derives or
// second-guesses the resolved country, avoiding the "rendering
// nondeterministic during hydration" failure mode spec section 6 warns
// against.
export default async function LandingRoute() {
  const countryContext = isG2LandingLocalisationEnabled() ? await resolveServerLandingCountryContext() : null;

  return (
    <div className={`${inter.variable} ${newsreader.variable} ${newsreaderItalic.variable}`}>
      <LandingPage countryContext={countryContext} />
    </div>
  );
}

async function resolveServerLandingCountryContext() {
  const supabase = await createClient();
  // A transient auth-lookup failure must degrade to "treat as anonymous",
  // never crash the public landing page (same fail-closed principle as
  // resolveLandingCountryContextForRequest's own internal try/catch).
  let userId: string | null = null;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    userId = user?.id ?? null;
  } catch {
    userId = null;
  }
  const cookieStore = await cookies();
  const headerStore = await headers();

  return resolveLandingCountryContextForRequest({
    supabase,
    userId,
    cookieValue: cookieStore.get(LANDING_COUNTRY_COOKIE_NAME)?.value ?? null,
    headers: headerStore,
  });
}
