'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  AVAILABILITY_LABEL,
  isAnalysisReachable,
  type AnalysisAvailability,
  type AnalysisCard,
  type NextStep,
} from '@/lib/investment-intelligence/analysisAvailability';
import { II_RELATED_DESTINATIONS } from '@/lib/investment-intelligence/workspaceNav';

// II-PC2 — the Investment Intelligence workspace Overview (spec sections 10,
// 12, 29, 64).
//
// THIS COMPONENT COMPUTES NO FINANCIAL VALUE (spec sections 2.6, 11).
// Everything it renders arrives already-decided from
// /api/investment-intelligence/overview. The only arithmetic below is
// presentational (Intl number formatting). No return, tax, risk, benchmark,
// SIP or exposure figure is derived here — and none is displayed here at all;
// the Overview reports STATUS and COUNTS, and sends the user to the certified
// analytics page for every actual analytical number.

interface OverviewPayload {
  portfolio: {
    positionCount: number;
    accountCount: number;
    instrumentCount: number;
    valueByCurrency: { currencyCode: string; totalValue: number; positionCount: number }[];
    instrumentClasses: string[];
    latestAsOfDate: string | null;
    oldestAsOfDate: string | null;
  };
  dataQuality: {
    documentCount: number;
    documentStatusCounts: Record<string, number>;
    certifiedPositionCount: number;
    reconciliationRequiredPositionCount: number;
    openReconciliationCaseCount: number;
    publishedPositionCount: number;
    openReviewItemCount: number;
  };
  cards: AnalysisCard[];
  nextStep: NextStep;
}

const CARD_META: Record<AnalysisCard['key'], { title: string; description: string; href: string; cta: string }> = {
  performance: {
    title: 'Performance',
    description: 'See how your investments performed and compare them with their benchmarks.',
    href: '/investment-intelligence/performance',
    cta: 'View performance',
  },
  sip: {
    title: 'Recurring investments',
    description: 'Review recurring contributions and compare the same contribution schedule with the benchmark.',
    href: '/investment-intelligence/sip',
    cta: 'View recurring investments',
  },
  xray: {
    title: 'Fund holdings',
    description: 'See the underlying securities and overlap inside your mutual funds.',
    href: '/investment-intelligence/xray',
    cta: 'View fund holdings',
  },
  tax: {
    title: 'Tax & cost',
    description: 'Review estimated realised gains and cost basis from recorded disposals.',
    href: '/investment-intelligence/tax',
    cta: 'View tax & cost',
  },
  review: {
    title: 'Review',
    description: 'See what needs your attention across your investment data, goals, and portfolio.',
    href: '/investment-intelligence/review',
    cta: 'Open Review Centre',
  },
};

// Status is conveyed by the LABEL TEXT first; colour only reinforces it
// (spec section 35 — status must not be communicated by colour alone).
const STATUS_CLASS: Record<AnalysisAvailability, string> = {
  AVAILABLE: 'bg-positive/10 text-positive',
  NOT_ENOUGH_DATA: 'bg-app text-muted',
  REFERENCE_DATA_MISSING: 'bg-attention/10 text-attention',
  NOT_APPLICABLE: 'bg-app text-muted',
  NEEDS_RECONCILIATION: 'bg-attention/10 text-attention',
  STALE: 'bg-attention/10 text-attention',
  UNSUPPORTED: 'bg-app text-muted',
  ERROR: 'bg-risk/10 text-risk',
};

function StatusPill({ status }: { status: AnalysisAvailability }) {
  return (
    <span className={`inline-block rounded-compact px-2 py-0.5 text-xs font-medium ${STATUS_CLASS[status]}`}>{AVAILABILITY_LABEL[status]}</span>
  );
}

function formatMoney(value: number, currencyCode: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode, maximumFractionDigits: 0 }).format(value);
  } catch {
    // An unknown/experimental ISO code must not blank the whole summary.
    return `${currencyCode} ${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
}

const CLASS_LABEL: Record<string, string> = {
  mutual_fund: 'Mutual funds',
  etf: 'ETFs',
  equity: 'Direct equity',
  bond: 'Bonds',
  fixed_deposit: 'Fixed deposits',
  gold: 'Gold',
  crypto: 'Crypto',
  cash: 'Cash',
  other: 'Other',
};

function Card({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={`rounded-card border border-line bg-white p-6${className ? ` ${className}` : ''}`}>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}

export function OverviewClient() {
  const [data, setData] = useState<OverviewPayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/overview');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(json.message ?? json.error ?? 'Your investment overview could not be loaded.');
          return;
        }
        setData(json.data as OverviewPayload);
      } catch {
        if (!cancelled) setError('Your investment overview could not be loaded.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Error isolation (spec section 42): the summary failing must not hide the
  // workspace. The sub-navigation above stays rendered by the page, and this
  // block still offers a direct route onward.
  if (error) {
    return (
      <div className="rounded-card border border-line bg-white p-6">
        <h2 className="text-lg font-semibold text-ink">Your investment summary is unavailable right now</h2>
        <p className="mt-2 text-sm text-muted">{error}</p>
        <p className="mt-2 text-sm text-muted">
          This affects only the summary on this page. Each analysis is still reachable from the navigation above, and your data is unaffected.
        </p>
        <Link href="/investment-intelligence/data" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Go to statements &amp; data
        </Link>
      </div>
    );
  }

  if (!data) {
    // Fixed-height skeletons so the real content does not shift the page in
    // (spec section 41 — avoid layout jumping).
    return (
      <div className="space-y-6" aria-busy="true" aria-live="polite">
        <p className="sr-only">Loading your investment overview.</p>
        <div className="h-32 rounded-card border border-line bg-white" />
        <div className="h-32 rounded-card border border-line bg-white" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="h-40 rounded-card border border-line bg-white" />
          ))}
        </div>
      </div>
    );
  }

  const { portfolio, dataQuality, cards, nextStep: step } = data;
  const hasAnyData = portfolio.positionCount > 0 || dataQuality.documentCount > 0;

  return (
    <div className="space-y-6">
      {/* ---------- What do I have? (spec section 10) ---------- */}
      <Card title="What you have">
        {portfolio.positionCount === 0 ? (
          <div>
            <p className="text-sm text-muted">
              No investment positions have been reconstructed yet. Investment Intelligence rebuilds your Indian mutual fund holdings from a CAMS or
              KFintech consolidated account statement, then reconciles them against the statement before any figure is used.
            </p>
            <p className="mt-2 text-sm text-muted">
              Once positions exist you will be able to see performance against benchmarks, recurring contributions, what your funds hold underneath,
              and estimated realised gains on any disposals.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Positions" value={String(portfolio.positionCount)} sub={`across ${portfolio.accountCount} folio${portfolio.accountCount === 1 ? '' : 's'}`} />
              <Stat label="Schemes / securities" value={String(portfolio.instrumentCount)} />
              <Stat
                label="What you hold"
                value={portfolio.instrumentClasses.length ? portfolio.instrumentClasses.map((c) => CLASS_LABEL[c] ?? c).join(', ') : '—'}
              />
              <Stat label="Valued as at" value={portfolio.latestAsOfDate ?? 'Not available'} sub={
                portfolio.oldestAsOfDate && portfolio.oldestAsOfDate !== portfolio.latestAsOfDate
                  ? `oldest position as at ${portfolio.oldestAsOfDate}`
                  : undefined
              } />
            </div>
            <div className="mt-4 border-t border-line pt-4">
              {/* Per-currency, never a single blended total — summing across
                  currencies would be a fabricated number. */}
              <p className="text-xs text-muted">Value of reconstructed positions</p>
              <div className="mt-1 flex flex-wrap gap-x-8 gap-y-2">
                {portfolio.valueByCurrency.map((c) => (
                  <p key={c.currencyCode} className="text-lg font-semibold tabular-nums text-ink">
                    {formatMoney(c.totalValue, c.currencyCode)}
                    {portfolio.valueByCurrency.length > 1 && <span className="ml-1 text-xs font-normal text-muted">({c.positionCount} positions)</span>}
                  </p>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                This is the value Investment Intelligence reconstructed from your statements. Only positions you publish are included in your FHIP net
                worth.
              </p>
            </div>
          </>
        )}
      </Card>

      {/* ---------- Is my data ready? (spec sections 10, 14, 38) ---------- */}
      <Card title="Is your data ready?">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Stat label="Statements" value={String(dataQuality.documentCount)} />
          <Stat label="Positions certified" value={`${dataQuality.certifiedPositionCount} of ${portfolio.positionCount}`} />
          <Stat label="Positions needing review" value={String(dataQuality.reconciliationRequiredPositionCount)} />
          <Stat label="Open data issues" value={String(dataQuality.openReconciliationCaseCount)} />
          <Stat label="Published to net worth" value={String(dataQuality.publishedPositionCount)} />
        </div>
        {Object.keys(dataQuality.documentStatusCounts).length > 0 && (
          <p className="mt-4 text-xs text-muted">
            Statement status:{' '}
            {Object.entries(dataQuality.documentStatusCounts)
              .map(([status, count]) => `${count} ${status.replace(/_/g, ' ')}`)
              .join(' · ')}
          </p>
        )}
        {/* Data quality is a product feature — uncertainty is surfaced, not
            concealed (spec section 38). */}
        {dataQuality.openReconciliationCaseCount > 0 && (
          <p className="mt-3 rounded-compact bg-attention/10 px-3 py-2 text-sm text-attention">
            Some figures may change once the open data issues are resolved.
          </p>
        )}
        <Link href="/investment-intelligence/data" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
          Go to statements &amp; data
        </Link>
      </Card>

      {/* ---------- What should I do next? (spec section 10) ---------- */}
      <Card title="What to do next">
        <p className="text-sm text-ink">{step.message}</p>
        <Link href={step.href} className="mt-3 inline-block rounded-compact bg-primary px-3 py-2 text-sm font-medium text-white hover:bg-primary-700">
          {step.ctaLabel}
        </Link>
        <p className="mt-3 text-xs text-muted">
          This describes the next step in preparing your investment data. It is not advice about what to invest in.
        </p>
      </Card>

      {/* ---------- What analysis is available? (spec sections 10, 29) ---------- */}
      <section aria-labelledby="ii-analysis-heading">
        <h2 id="ii-analysis-heading" className="text-lg font-semibold text-ink">
          Analysis available for your data
        </h2>
        <p className="mt-1 text-sm text-muted">
          Each analysis below reports what your data shows. Where an analysis cannot be produced, the reason is given rather than a zero.
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.map((card) => {
            const meta = CARD_META[card.key];
            const reachable = isAnalysisReachable(card.status);
            return (
              <div key={card.key} className="flex flex-col rounded-card border border-line bg-white p-5" data-testid={`ii-card-${card.key}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-semibold text-ink">{meta.title}</h3>
                  <StatusPill status={card.status} />
                </div>
                <p className="mt-2 text-sm text-muted">{meta.description}</p>
                <p className="mt-2 flex-1 text-sm text-ink">{card.detail}</p>
                {/* Every card stays navigable even when unavailable: the page
                    itself explains the gap in full. Hiding the link would make
                    the analysis undiscoverable, which is the exact defect PC2
                    exists to fix (spec sections 45, 67). */}
                <Link href={meta.href} className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
                  {reachable ? meta.cta : 'Why this is unavailable'}
                </Link>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---------- Related canonical systems (spec sections 23-26) ---------- */}
      <Card title="Related parts of FHIP">
        <p className="text-sm text-muted">
          Investment Intelligence is where your investment evidence is reconstructed, reconciled and analysed. These are the canonical systems it
          connects to — not copies of it.
        </p>
        <ul className="mt-4 space-y-4">
          {II_RELATED_DESTINATIONS.map((d) => (
            <li key={d.key}>
              <Link href={d.href} className="text-sm font-medium text-primary hover:underline">
                {d.label}
              </Link>
              <p className="mt-0.5 text-sm text-muted">{d.relationship}</p>
            </li>
          ))}
        </ul>
      </Card>

      {!hasAnyData && (
        <p className="text-xs text-muted">
          Supported sources today: CAMS and KFintech consolidated account statements (PDF). Direct Indian equity and equity ETF positions can be added
          manually from Statements &amp; data.
        </p>
      )}
    </div>
  );
}
