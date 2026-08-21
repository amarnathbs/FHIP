import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { PortfolioXrayClient } from '@/components/investment-intelligence/PortfolioXrayClient';

// R5 — Portfolio X-Ray (spec sections 98-99).
//
// Look-through is ATTRIBUTION, NOT ADDITIONAL WEALTH: seeing the securities
// inside your funds does not add to your net worth, and nothing on this page
// writes to or is read back into any FHIP financial register.
//
// Coverage and both as-of dates are shown on every view, and an analysis
// that cannot be calculated is shown as unavailable rather than as zeros.
export default async function PortfolioXrayPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-ink">What your funds actually hold</h1>
        <p className="mt-1 text-sm text-muted">
          Looking through each fund to the securities underneath, so you can see your real exposure and where the same holdings appear in more than one fund. This
          describes what your funds hold; it is not advice about what to buy, sell, or switch.
        </p>
      </header>
      <PortfolioXrayClient />
    </div>
  );
}
