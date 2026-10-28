'use client';

import { SectionCard } from '@/components/dashboard/SectionCard';
import { BillingPanel } from '@/components/profile/BillingPanel';
import { FINANCIAL_IMPORT_PLAN_SECTION_ID } from '@/lib/entitlements/financialDataImportContract';

/**
 * The Billing / plan section of the Profile page with a stable anchor. Every locked Import control lands here
 * (see `focusPlanSection`). The wrapper is focusable by script only (tabIndex -1), has a name, and when the person
 * arrived from a locked control it is described by the arrival notice so a screen reader hears why they are here.
 */
export function ProfilePlanSection({ describedBy }: { describedBy?: string }) {
  return (
    <div
      id={FINANCIAL_IMPORT_PLAN_SECTION_ID}
      role="group"
      aria-label="Billing and plan"
      aria-describedby={describedBy}
      tabIndex={-1}
      data-testid="profile-plan-section"
      className="scroll-mt-4 rounded-card focus:outline-none focus:ring-2 focus:ring-ai focus:ring-offset-2"
    >
      <SectionCard title="Billing" description="Your plan, billing country and payment history.">
        <BillingPanel />
      </SectionCard>
    </div>
  );
}
