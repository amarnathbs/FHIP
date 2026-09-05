// G3 section 10 — the interim destination for a GENERIC-experience user.
//
// A GB/US/SG/AE user has genuinely completed registration and country
// confirmation: their account is valid and their country is correct. What
// does not yet exist is G4's application-wide capability layer, without
// which the rest of app/(app)/ still assumes an AU/IN domestic user. So this
// page exists to tell them the truth about that state rather than dropping
// them onto a dashboard full of Australian superannuation and Indian tax
// modules that will refuse every request they make.
//
// It deliberately does NOT pretend to be a dashboard, and it deliberately
// does not show a single financial figure — a generic user has no financial
// rows (the database refuses them; see migration 0127's header), so any
// number here would be fabricated.
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { assertCountryConfirmedForUser, shouldRedirectToConfirmCountry } from '@/lib/services/countryGate';
import { buildCoverageDisclosure, COUNTRY_LABELS } from '@/lib/services/countryDisclosure';
import { isKnownCountry } from '@/lib/services/jurisdiction';
import { isG4CapabilityLayerEnabled } from '@/lib/services/appCapabilityFlag';

// G4 — dispatch section 8: "remove the /global-setup redirect only for the
// exact enabled destinations". Dashboard itself stays UNAVAILABLE for
// GENERIC (see lib/services/appCapability.ts's manifest — dashboardData.ts
// carries a real AUD/FX-rate assumption), so GENERIC users still land here
// rather than on /dashboard. What changes behind the flag is this page's own
// content: it now truthfully lists the modules G4 actually certified
// universal, instead of only Profile. Flag off => byte-identical to the
// pre-G4 page.
const G4_ENABLED_LINKS: { label: string; href: string }[] = [
  { label: 'Income', href: '/income' },
  { label: 'Expenses', href: '/expenses' },
  { label: 'Insurance', href: '/insurance' },
  { label: 'Scores', href: '/score' },
  { label: 'Financial DNA', href: '/dna' },
  { label: 'Financial Resilience', href: '/resilience' },
];

export const dynamic = 'force-dynamic';

export default async function GlobalSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const gate = await assertCountryConfirmedForUser(supabase, user.id);
  if (shouldRedirectToConfirmCountry(gate)) redirect('/confirm-country');

  // A FULL-experience user who navigates here directly belongs on the real
  // dashboard — this page would be actively misleading for them.
  if (gate.experienceLevel !== 'GENERIC') redirect('/dashboard');

  const code = gate.countryOfResidence?.trim().toUpperCase() ?? '';
  const countryLabel = isKnownCountry(code) ? COUNTRY_LABELS[code] : 'your country';
  const disclosure = buildCoverageDisclosure('GENERIC', countryLabel);

  return (
    <main className="mx-auto max-w-2xl px-4 py-10" aria-labelledby="global-setup-heading">
      <h1 id="global-setup-heading" className="text-2xl font-semibold">
        Global experience setup complete
      </h1>

      <p className="mt-3 text-sm text-muted">
        Your account is set up for <strong>{countryLabel}</strong>. Additional universal-module access
        will be enabled through the next capability phase.
      </p>

      <section className="mt-8 rounded-lg border p-5" aria-labelledby="coverage-heading">
        <h2 id="coverage-heading" className="text-base font-medium">
          What is available today
        </h2>
        <p className="mt-2 text-sm text-muted">{disclosure.body}</p>
        <ul className="mt-4 list-disc space-y-1 pl-5 text-sm text-muted">
          {disclosure.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      </section>

      <section className="mt-6 rounded-lg border p-5" aria-labelledby="next-heading">
        <h2 id="next-heading" className="text-base font-medium">
          What you can do now
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <Link href="/profile" className="text-primary underline">
              Open your profile
            </Link>{' '}
            to set your reporting currency (AUD or INR) and to declare any cross-border
            relationships.
          </li>
          {isG4CapabilityLayerEnabled() &&
            G4_ENABLED_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-primary underline">
                  {link.label}
                </Link>
              </li>
            ))}
        </ul>
        <p className="mt-4 text-xs text-muted">
          Financial modules with a domestic (Australia/India-specific) assumption are not open for
          your country yet. This is a deliberate limit, not an error — we would rather show you
          nothing than show you an Australian or Indian calculation that does not apply where you
          live.
        </p>
      </section>
    </main>
  );
}
