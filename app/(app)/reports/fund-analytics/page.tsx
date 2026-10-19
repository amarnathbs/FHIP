import Link from 'next/link';
import { PageBackLink } from '@/components/navigation/PageBackLink';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { canViewPremiumReport } from '@/lib/services/entitlements';
import { FUND_ANALYTICS_DISABLED_MESSAGE, FUND_ANALYTICS_PREMIUM_MESSAGE } from '@/lib/services/investment-intelligence/nav2/fundAnalyticsReportService';
import { isNav2FlagOn, NAV2_JOB_KEYS } from '@/lib/services/investment-intelligence/nav2/nav2Flags';
import FundAnalyticsReportClient from '@/components/reports/FundAnalyticsReportClient';

// The Fund analytics report (Reports menu). A SEPARATE report from the Monthly Report. Premium only: a free user gets an
// explicit sentence saying so, not an empty page and not a locked-looking preview of someone else's numbers. The API routes
// enforce the same rules independently (this page is not the authorisation).
export const dynamic = 'force-dynamic';

async function FundAnalyticsReportPageContent() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const premium = await canViewPremiumReport(user.id, supabase);
  let enabled = false;
  try {
    enabled = await isNav2FlagOn(createAdminClient(), NAV2_JOB_KEYS.fundAnalytics);
  } catch {
    enabled = false; // fail closed
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Fund analytics</h1>
        <p className="mt-1 text-muted">How each Indian mutual fund you hold has performed, how risky it has been, and how your own money has done in it. Prices are published by AMFI.</p>
      </div>
      {!premium ? (
        <SectionCard title="Premium report">
          <p className="text-sm text-ink">{FUND_ANALYTICS_PREMIUM_MESSAGE}</p>
          <p className="mt-2 text-sm text-muted">
            Your Monthly Report is still available under{' '}
            <Link href="/reports" className="text-trust underline">
              Reports
            </Link>
            .
          </p>
        </SectionCard>
      ) : !enabled ? (
        <SectionCard title="Not available yet">
          <p className="text-sm text-ink">{FUND_ANALYTICS_DISABLED_MESSAGE}</p>
        </SectionCard>
      ) : (
        <FundAnalyticsReportClient />
      )}
    </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Reports).
export default function FundAnalyticsReportPage() {
  return (
    <>
      <PageBackLink href="/reports" label="Reports" />
      <FundAnalyticsReportPageContent />
    </>
  );
}
