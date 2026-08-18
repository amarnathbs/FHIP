// R1.6 — spec §59-62/§111: the actual rendered link, once a context key has
// already been resolved to a public Resource slug. Pure/presentational (no
// data fetching) so it is safe to use from both the async Server Component
// wrapper (WhatDoesThisMean.tsx, for ordinary server-rendered FHIP pages)
// and from inside an existing 'use client' tree (the Dashboard's
// VitalSignsStrip/sections, which resolve their mappings once at the parent
// Server Component page and pass the result down as a plain prop — Next.js
// does not allow an async Server Component to be mounted as a child inside
// a Client Component tree, so this split exists specifically to make both
// call sites possible without duplicating the resolution logic anywhere).
//
// spec §62: renders nothing when resolved is null — no "No help available"
// placeholder, ever. spec §111: the accessible name always names the
// metric explicitly (e.g. "Learn what Savings Rate means"), never a bare
// "What does this mean?" with no icon-only ambiguity.

import Link from 'next/link';

export function WhatDoesThisMeanLink({ resolved, metricLabel, compact = true }: { resolved: { slug: string } | null; metricLabel: string; compact?: boolean }) {
  if (!resolved) return null;
  return (
    <Link
      href={`/resources/${resolved.slug}`}
      aria-label={`Learn what ${metricLabel} means`}
      className={compact ? 'mt-1 inline-flex items-center gap-1 text-xs font-medium text-trust hover:underline' : 'inline-flex items-center gap-1 text-sm font-medium text-trust hover:underline'}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0">
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" />
        <path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="8" cy="5.1" r="0.9" fill="currentColor" />
      </svg>
      What does this mean?
    </Link>
  );
}
