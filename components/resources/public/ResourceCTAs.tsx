// R1.6 — spec §47-51: renders a Resource's explicit primary/secondary CTA
// (spec §47: "R1.3/R1.4 already allow primary_cta_id/secondary_cta_id... R1.6
// must now actually render them publicly"), or a deterministic generic
// fallback when neither is configured (spec §49: "keep this deterministic.
// Do not choose a CTA using user financial data"). destination_url is
// rendered as a plain href — every value that reaches this component has
// already passed lib/resources/cta/validation.ts's per-destination-type
// safety check at CTA-creation time (spec §45/§46/§105), so there is no
// javascript:/data: scheme to defend against here; this component does not
// re-validate, it only chooses <Link> vs a plain <a target="_blank"> based
// on destination_type.

import Link from 'next/link';
import type { PublicCta } from '@/lib/resources/public/queries';

const EXTERNAL_TYPES = new Set(['external', 'youtube']);

function CtaButton({ cta, prominent }: { cta: PublicCta; prominent: boolean }) {
  const className = prominent
    ? 'inline-flex items-center justify-center rounded-compact bg-trust px-5 py-2.5 text-sm font-semibold text-white hover:bg-trust-700'
    : 'inline-flex items-center justify-center rounded-compact border border-line px-5 py-2.5 text-sm font-semibold text-ink hover:border-trust hover:text-trust';

  if (EXTERNAL_TYPES.has(cta.destination_type)) {
    return (
      <a href={cta.destination_url} target="_blank" rel="noopener noreferrer" className={className}>
        {cta.label}
      </a>
    );
  }
  return (
    <Link href={cta.destination_url} className={className}>
      {cta.label}
    </Link>
  );
}

export function ResourceCTAs({ primaryCta, secondaryCta, isAuthenticated }: { primaryCta: PublicCta | null; secondaryCta: PublicCta | null; isAuthenticated: boolean }) {
  const hasExplicit = !!primaryCta || !!secondaryCta;

  if (!hasExplicit) {
    // spec §49/§50 — deterministic generic fallback, session-state aware
    // (not financial-data aware): anonymous points at account creation,
    // authenticated points at the Dashboard. Never varies by score/data.
    const fallback = isAuthenticated ? { label: 'Go to Dashboard', href: '/dashboard' } : { label: 'Check Your Financial Health', href: '/signup' };
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Link href={fallback.href} className="inline-flex items-center justify-center rounded-compact bg-trust px-5 py-2.5 text-sm font-semibold text-white hover:bg-trust-700">
          {fallback.label}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {primaryCta && <CtaButton cta={primaryCta} prominent />}
      {secondaryCta && <CtaButton cta={secondaryCta} prominent={false} />}
    </div>
  );
}
