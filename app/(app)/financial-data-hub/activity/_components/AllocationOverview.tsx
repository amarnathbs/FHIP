import { Fragment } from 'react';
import Link from 'next/link';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { DataTable } from '@/components/ui/DataTable';
import { formatMoney } from '@/lib/engines/money';
import {
  ALLOCATION_SECTION_NOTE,
  ALLOCATION_SECTION_ORDER,
  ALLOCATION_SECTION_TITLE,
  describeAllocation,
  type AllocationCurrencyResult,
  type AllocationOverviewResult,
} from '@/lib/financial-data-hub/analytics/allocationOverview';

// PO 04-11-2026: "income and expense allocation": the MAIN TABLE first, the ANALYSIS directly below it. Approved and waiting money sit in two separate columns and are
// never added together (the Overview's standing rule). Server component: the numbers come from getAllocationOverview().

const REVIEW_HREF = '/financial-data-hub/review?from=activity';

function AllocationTable({ c }: { c: AllocationCurrencyResult }) {
  const currency = c.currency as 'AUD' | 'INR';
  const money = (n: number) => formatMoney(n, currency);
  const sections = ALLOCATION_SECTION_ORDER.filter((s) => c.sections[s].rows.length > 0);
  return (
    <DataTable label={`Income and expense allocation, ${c.currency}`} className="w-full text-left text-sm">
      <caption className="sr-only">Income and expense allocation by category, {c.currency}. Approved and waiting amounts are in separate columns.</caption>
      <thead>
        <tr className="border-b border-line text-xs text-muted">
          <th scope="col" className="py-2 pr-3 font-medium">Category</th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">Lines</th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">Approved</th>
          <th scope="col" className="py-2 pr-3 text-right font-medium">Share</th>
          <th scope="col" className="py-2 text-right font-medium">Waiting for approval</th>
        </tr>
      </thead>
      {sections.map((s) => {
        const sec = c.sections[s];
        return (
          <tbody key={s} className="align-top">
            <tr className="bg-surface/60">
              <th scope="colgroup" colSpan={5} className="py-2 pr-3 text-left">
                <span className="font-semibold text-ink">{ALLOCATION_SECTION_TITLE[s]}</span>
                <span className="ml-2 text-xs font-normal text-muted">{ALLOCATION_SECTION_NOTE[s]}</span>
              </th>
            </tr>
            {sec.rows.map((r) => (
              <Fragment key={`${s}|${r.categoryId ?? 'none'}`}>
                <tr className="border-b border-line/60">
                  <th scope="row" className="py-1.5 pr-3 text-left font-normal text-ink">{r.label}</th>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{r.approvedCount + r.waitingCount}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{r.approvedCount > 0 ? money(r.approvedTotal) : '—'}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums text-muted">{r.approvedSharePct !== null ? `${r.approvedSharePct}%` : '—'}</td>
                  <td className="py-1.5 text-right tabular-nums text-muted">{r.waitingCount > 0 ? `${money(r.waitingTotal)} (${r.waitingCount})` : '—'}</td>
                </tr>
                {/* The types under this category (e.g. Income > Salary & Wages). Detail only: they add up to the row above and are not extra totals. */}
                {r.subRows.map((sr) => (
                  <tr key={`${s}|${r.categoryId ?? 'none'}|${sr.subcategoryId ?? 'none'}`} className="border-b border-line/40 text-xs" data-testid="allocation-subrow">
                    <th scope="row" className="py-1 pl-5 pr-3 text-left font-normal text-muted">{sr.label}</th>
                    <td className="py-1 pr-3 text-right tabular-nums text-muted">{sr.approvedCount + sr.waitingCount}</td>
                    <td className="py-1 pr-3 text-right tabular-nums text-muted">{sr.approvedCount > 0 ? money(sr.approvedTotal) : '—'}</td>
                    <td className="py-1 pr-3" />
                    <td className="py-1 text-right tabular-nums text-muted">{sr.waitingCount > 0 ? `${money(sr.waitingTotal)} (${sr.waitingCount})` : '—'}</td>
                  </tr>
                ))}
              </Fragment>
            ))}
            <tr className="border-b border-line">
              <th scope="row" className="py-1.5 pr-3 text-left font-semibold text-ink">Total {ALLOCATION_SECTION_TITLE[s].toLowerCase()}</th>
              <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-muted">{sec.approvedCount + sec.waitingCount}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums font-semibold text-ink">{sec.approvedCount > 0 ? money(sec.approvedTotal) : '—'}</td>
              <td className="py-1.5 pr-3" />
              <td className="py-1.5 text-right tabular-nums font-semibold text-muted">{sec.waitingCount > 0 ? `${money(sec.waitingTotal)} (${sec.waitingCount})` : '—'}</td>
            </tr>
          </tbody>
        );
      })}
    </DataTable>
  );
}

export function AllocationOverview({ allocation }: { allocation: AllocationOverviewResult }) {
  const shown = allocation.currencies.filter((c) => c.hasApproved || c.hasWaiting);
  if (shown.length === 0) return null;
  return (
    <div className="space-y-4" data-testid="allocation-overview">
      {shown.map((c) => {
        const currency = c.currency as 'AUD' | 'INR';
        const lines = describeAllocation(c, (n) => formatMoney(n, currency));
        const waiting = ALLOCATION_SECTION_ORDER.reduce((n, s) => n + c.sections[s].waitingCount, 0);
        return (
          <div key={c.currency} className="space-y-4">
            <SectionCard
              title={`Income and expense allocation — ${c.currency}`}
              description="Where your money came from and where it went, by category. Approved lines are counted in the totals; lines still waiting for approval are shown beside them and never added to them."
            >
              <AllocationTable c={c} />
              {waiting > 0 && (
                <Link href={REVIEW_HREF} className="mt-3 inline-block text-sm font-semibold text-trust hover:underline">
                  Review and approve the {waiting} waiting {waiting === 1 ? 'line' : 'lines'} →
                </Link>
              )}
            </SectionCard>
            <SectionCard title={`Analysis — ${c.currency}`} description="Written from the figures in the table above. Nothing here is estimated.">
              <ul className="list-disc space-y-2 pl-5 text-sm text-ink" data-testid="allocation-analysis">
                {lines.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
            </SectionCard>
          </div>
        );
      })}
    </div>
  );
}
