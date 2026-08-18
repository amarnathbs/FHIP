'use client';

// Public header for the /resources section (spec §16/§17). The existing
// marketing landing page (components/marketing/LandingPage.tsx) has its own
// bespoke, scroll-compacting, single-page anchor-nav header that cannot be
// reused unmodified across a genuine multi-page section — this is a
// separate, small, consistent header for every /resources/** page, carrying
// the same brand (logo, Log in / Start free) and highlighting "Resources"
// as active, exactly as spec §16 asks for without redesigning the site's
// main navigation.

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function PublicResourcesNav() {
  const pathname = usePathname();
  const onResources = pathname?.startsWith('/resources');

  return (
    <header className="border-b border-line bg-white">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold text-ink" aria-label="FHIP home">
          {/* eslint-disable-next-line @next/next/no-img-element -- small static logo lockup, same plain-<img> convention the existing marketing header already uses (components/marketing/LandingPage.tsx) */}
          <img src="/images/fhip-logo-lockup.png" alt="" className="h-7 w-auto" />
          <span className="hidden sm:inline">FHIP</span>
        </Link>

        <nav aria-label="Primary" className="flex items-center gap-4 text-sm">
          <Link href="/" className="hidden text-muted hover:text-ink sm:inline">
            Home
          </Link>
          <Link href="/resources" aria-current={onResources ? 'page' : undefined} className={onResources ? 'font-semibold text-trust' : 'text-muted hover:text-ink'}>
            Resources
          </Link>
          <Link href="/login" className="hidden text-muted hover:text-ink sm:inline">
            Log in
          </Link>
          <Link href="/signup" className="rounded-compact bg-trust px-3 py-1.5 font-semibold text-white hover:bg-trust-700">
            Start free
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function PublicResourcesFooter() {
  return (
    <footer className="border-t border-line bg-app">
      <div className="mx-auto max-w-6xl px-4 py-8 text-sm text-muted sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p>
            <span className="font-semibold text-ink">FHIP</span> — Financial Knowledge &amp; Insights
          </p>
          <nav aria-label="Resources footer" className="flex flex-wrap gap-x-6 gap-y-2">
            <Link href="/resources" className="hover:text-ink">
              Resources
            </Link>
            <Link href="/resources/glossary" className="hover:text-ink">
              Glossary
            </Link>
            <Link href="/resources/videos" className="hover:text-ink">
              Videos
            </Link>
            <Link href="/resources/money-updates" className="hover:text-ink">
              Money Updates
            </Link>
            <Link href="/signup" className="hover:text-ink">
              Create an Account
            </Link>
          </nav>
        </div>
        <p className="mt-4 text-xs text-muted">
          &copy; {new Date().getFullYear()} Financial Health Intelligence Platform. General financial education, not personal financial advice.
        </p>
      </div>
    </footer>
  );
}
