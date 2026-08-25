'use client';

// FDH-8 Financial Activity UI — shared sub-nav + period selector.
//
// "URL is the state" — same pattern already used by
// components/resources/public/SearchFilterBar.tsx and
// components/forecast/ScenarioSwitcher.tsx in this repo: a Client Component
// reads/writes `useSearchParams()`/`router.push`, and the Server Component
// pages underneath just read `searchParams` on every render. No client-side
// data-fetching state duplicated here.
//
// FDH-8 closure fix (2026-08-25): split out of layout.tsx into its own file
// so the `useSearchParams()` call can sit inside a <Suspense> boundary
// (layout.tsx now provides that boundary). Without it, `next build` failed
// static generation of every page under this route with "useSearchParams()
// should be wrapped in a suspense boundary" — a genuine, previously-
// undisclosed pre-existing defect in FDH-8's own delivered layout, only
// surfaced now that a full production build could run to completion against
// real DEV credentials (the prior session's build failed earlier, at an
// unrelated page, before ever reaching this one).

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { PERIOD_PRESETS, type PeriodPreset } from '@/lib/financial-data-hub/analytics/period';

const ACTIVITY_ROOT = '/financial-data-hub/activity';

const TABS: { label: string; href: string }[] = [
  { label: 'Overview', href: ACTIVITY_ROOT },
  { label: 'Transactions', href: `${ACTIVITY_ROOT}/transactions` },
  { label: 'Spending', href: `${ACTIVITY_ROOT}/spending` },
  { label: 'Income', href: `${ACTIVITY_ROOT}/income` },
  { label: 'Recurring', href: `${ACTIVITY_ROOT}/recurring` },
  { label: 'Accounts', href: `${ACTIVITY_ROOT}/accounts` },
];

const PERIOD_LABELS: Record<PeriodPreset, string> = {
  this_month: 'This month',
  last_month: 'Last month',
  '3_months': '3 months',
  '6_months': '6 months',
  '12_months': '12 months',
  year_to_date: 'Year to date',
  custom: 'Custom range',
};

function isActiveTab(pathname: string, href: string): boolean {
  return pathname === href || (href !== ACTIVITY_ROOT && pathname.startsWith(`${href}/`));
}

export function ActivityLayoutContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  const currentPeriod = ((searchParams.get('period') as PeriodPreset | null) ?? 'this_month') as PeriodPreset;
  const isCustom = currentPeriod === 'custom';
  const fromValue = searchParams.get('from') ?? '';
  const toValue = searchParams.get('to') ?? '';

  function withQuery(href: string): string {
    const qs = searchParams.toString();
    return qs ? `${href}?${qs}` : href;
  }

  function setPeriod(preset: PeriodPreset) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('period', preset);
    if (preset !== 'custom') {
      params.delete('from');
      params.delete('to');
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function setCustomRange(from: string, to: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('period', 'custom');
    if (from) params.set('from', from);
    else params.delete('from');
    if (to) params.set('to', to);
    else params.delete('to');
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Financial Activity</h1>
        <p className="mt-1 text-sm text-muted">
          Your approved income, expenses and account activity, built from statements you have reviewed and approved.
        </p>
      </div>

      <div className="flex flex-col gap-4 border-b border-line pb-4 lg:flex-row lg:items-center lg:justify-between">
        <nav aria-label="Financial activity sections" className="flex flex-wrap gap-1">
          {TABS.map((tab) => {
            const active = isActiveTab(pathname, tab.href);
            return (
              <Link
                key={tab.href}
                href={withQuery(tab.href)}
                aria-current={active ? 'page' : undefined}
                className={`rounded-compact px-3 py-1.5 text-sm font-medium ${
                  active ? 'bg-trust/10 text-trust' : 'text-muted hover:bg-app hover:text-ink'
                }`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="activity-period" className="text-sm font-medium text-muted">
            Period
          </label>
          <select
            id="activity-period"
            value={currentPeriod}
            onChange={(e) => setPeriod(e.target.value as PeriodPreset)}
            className="rounded-compact border border-line bg-white px-2 py-1.5 text-sm text-ink"
          >
            {PERIOD_PRESETS.map((preset) => (
              <option key={preset} value={preset}>
                {PERIOD_LABELS[preset]}
              </option>
            ))}
          </select>

          {isCustom && (
            <>
              <label htmlFor="activity-from" className="sr-only">
                Custom range start date
              </label>
              <input
                id="activity-from"
                type="date"
                defaultValue={fromValue}
                onBlur={(e) => setCustomRange(e.target.value, toValue)}
                className="rounded-compact border border-line bg-white px-2 py-1.5 text-sm text-ink"
              />
              <span className="text-sm text-muted" aria-hidden="true">
                to
              </span>
              <label htmlFor="activity-to" className="sr-only">
                Custom range end date
              </label>
              <input
                id="activity-to"
                type="date"
                defaultValue={toValue}
                onBlur={(e) => setCustomRange(fromValue, e.target.value)}
                className="rounded-compact border border-line bg-white px-2 py-1.5 text-sm text-ink"
              />
            </>
          )}
        </div>
      </div>

      {children}
    </div>
  );
}
