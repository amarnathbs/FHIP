'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ONBOARDING_TOUR_STEPS, ONBOARDING_TOUR_QUERY_PARAM } from '@/lib/constants';

// Guided new-user setup tour (2026-09-19, PO instruction): rendered once
// from AppShell so it appears on top of whichever page the tour is
// currently pointed at, without every individual page needing to know
// about it. Invisible outside the tour (ordinary navigation to any of
// these pages never shows this banner) -- it activates only when the
// ?setupTour=1 query param that ConfirmCountryForm.tsx/OnboardingWizard.tsx
// set on the FIRST tour page is still present, and each "Continue" link
// carries it forward to the next page itself.
export function GuidedSetupTour() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  if (searchParams.get(ONBOARDING_TOUR_QUERY_PARAM) !== '1') return null;

  const currentIndex = ONBOARDING_TOUR_STEPS.findIndex((s) => s.href === pathname);
  if (currentIndex === -1) return null; // a tour param on a page outside the sequence -- nothing to show

  const isLast = currentIndex === ONBOARDING_TOUR_STEPS.length - 1;
  const next = ONBOARDING_TOUR_STEPS[currentIndex + 1];

  function finish() {
    router.push('/dashboard');
  }

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-card border border-trust/30 bg-trust/5 px-4 py-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-trust">
          Setting up your profile — step {currentIndex + 1} of {ONBOARDING_TOUR_STEPS.length}
        </p>
        <p className="mt-0.5 text-sm text-muted">
          {isLast
            ? 'Last step — set a first goal if you have one in mind, or skip for now.'
            : `Add what you have, then continue to ${next.label}. You can always come back and edit later.`}
        </p>
      </div>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={finish} className="rounded px-3 py-2 text-sm text-muted hover:text-ink">
          Skip setup
        </button>
        {isLast ? (
          <button
            type="button"
            onClick={finish}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Finish setup
          </button>
        ) : (
          <button
            type="button"
            onClick={() => router.push(`${next.href}?${ONBOARDING_TOUR_QUERY_PARAM}=1`)}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90"
          >
            Continue to {next.label}
          </button>
        )}
      </div>
    </div>
  );
}
