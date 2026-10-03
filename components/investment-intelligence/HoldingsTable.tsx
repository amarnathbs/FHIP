'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { fmtDate } from './dateDisplay';
import { TransactionDetailModal } from './TransactionDetailModal';
import BenchmarkComparisonView from './BenchmarkComparisonView';
import type { HoldingBenchmarkComparison } from '@/lib/engines/investment-intelligence/holdingBenchmarkComparison';

// Investment Intelligence — Performance tab Holdings drilldown (2026-09-17).
//
// The "Holdings" table, matching the Product Owner's own reference
// workbook's Holdings tab column-for-column: Folio No., ISIN, Scheme Code,
// Scheme Name, Cost Value, Unit Balance, NAV Date, NAV, Market Value,
// Registrar, Gain/(Loss), Return %, XIRR, plus a BENCH-1 (2026-09-30)
// addition — a Benchmark column showing this scheme's exact primary
// benchmark and comparable return, or an honest "Unavailable" with its
// reason (mission BENCH-1 section 12) — never blank, never a fabricated
// 0%. Additive to the existing
// "Scheme performance" table (SchemeTable in PerformanceClient.tsx, kept
// unchanged) — that table answers "how did this scheme perform against its
// benchmark", this one answers "what do I actually hold, at what cost, and
// what is it worth today", the same two questions the PO's workbook itself
// keeps as separate tabs.
//
// A row's Cost Value/Units/Market Value/Gain-Loss/XIRR are replaced by an
// honest "data quality" badge instead of a number whenever the underlying
// scheme failed the existing PC4 unit-reconciliation check and no
// AI-fallback correction is available — never a silently-wrong figure.

interface DataQuality {
  status: 'ok' | 'ai_corrected' | 'unresolved';
  detail: string | null;
}

interface XirrOutcomeView {
  status: string;
  value?: { rate: number };
  detail?: string;
}

// BENCH-1 (2026-09-30): mirrors CalculationOutcome<BenchmarkComparable> from
// holdingsRepository.ts/benchmarkCoverage.ts. status is 'CALCULATED' only
// when a real, licensed benchmark series actually covered this row's window
// -- every other status (BENCHMARK_MAPPING_MISSING, BENCHMARK_HISTORY_INCOMPLETE
// via qualityFlag) renders as an honest "Unavailable" with its own reason,
// never a blank cell and never a fabricated 0%.
interface BenchmarkOutcomeView {
  status: string;
  value?: { benchmarkKey: string; benchmarkLabel: string; pointToPointReturn: number };
  detail?: string;
}

interface HoldingRowView {
  accountId: string;
  instrumentId: string;
  folioNumber: string | null;
  isin: string | null;
  schemeCode: string | null;
  schemeName: string;
  registrar: string | null;
  costValue: number | null;
  unitBalance: number | null;
  navDate: string | null;
  nav: number | null;
  marketValue: number | null;
  gainLoss: number | null;
  returnPct: number | null;
  xirr: XirrOutcomeView;
  currencyCode: string;
  // Document2 Finding #5 (2026-10-01): see holdingsRepository.ts. navDate/nav
  // are the NAV that produced marketValue, dated by that NAV's own date.
  valuationBasis?: 'market_nav' | 'statement' | 'redeemed' | 'unavailable';
  navSource?: 'market' | 'statement' | null;
  statementAsOfDate?: string | null;
  statementNav?: number | null;
  statementSuperseded?: boolean;
  valuationStale?: boolean;
  valuationNote?: string;
  dataQuality: DataQuality;
  // 2026-09-29 fix (resolution-guidance links): see holdingsRepository.ts's
  // matching field comment. Used below to link an 'unresolved' row straight
  // to the statement that can actually be resolved, instead of leaving the
  // badge's tooltip as the only information the user gets.
  sourceDocumentId: string | null;
  benchmark: BenchmarkOutcomeView;
  // Holding-period, money-weighted comparison (see holdingBenchmarkComparison.ts).
  benchmarkComparison?: HoldingBenchmarkComparison;
}

interface HoldingsApiPayload {
  holdings: HoldingRowView[];
  warnings: Array<{ scope: string; detail: string }>;
  empty: boolean;
}

// RTA scheme names are consistently printed as "<internal scheme code>-<real
// name>" (e.g. "108MFGPG-UTI MNC Fund...", "FTI037-Franklin India Flexi Cap
// Fund..."). The code is an RTA-internal identifier, not something a user
// recognises a fund by — stripped here so the truncated name below spends
// its limited characters on the part that's actually meaningful. Only the
// SUMMARY row is affected; the popup's own heading still shows the full,
// untouched original name including its code, since that's useful evidence
// there, not clutter.
function stripSchemeCode(name: string): string {
  return name.replace(/^[A-Z0-9]+-/, '');
}

// Full scheme names routinely run 60-100+ characters and were wrapping
// across 5-6 lines per row, making the table unreadable. Truncated for
// this summary row only — the full name is still shown, untruncated, in
// the transaction-detail popup's own heading (aria-label below is also
// left untruncated for the same reason).
const SCHEME_NAME_MAX_CHARS = 28;
function truncateSchemeName(name: string): string {
  const stripped = stripSchemeCode(name);
  return stripped.length > SCHEME_NAME_MAX_CHARS ? `${stripped.slice(0, SCHEME_NAME_MAX_CHARS).trimEnd()}…` : stripped;
}

function money(v: number | null, currency: string): string {
  if (v === null || !Number.isFinite(v)) return '—';
  try {
    return new Intl.NumberFormat(currency === 'INR' ? 'en-IN' : 'en-AU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(v);
  } catch {
    return `${currency} ${v.toFixed(2)}`;
  }
}

function num(v: number | null, digits = 3): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(digits);
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(2)}%`;
}

const QUALITY_BADGE: Record<DataQuality['status'], { label: string; className: string }> = {
  ok: { label: 'OK', className: 'bg-green-50 text-green-700 border-green-200' },
  ai_corrected: { label: 'AI-corrected', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  unresolved: { label: 'Data quality issue', className: 'bg-amber-50 text-amber-800 border-amber-200' },
};

export function HoldingsTable({ ownerClass = 'all' }: { ownerClass?: string } = {}) {
  const [payload, setPayload] = useState<HoldingsApiPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ accountId: string; instrumentId: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(ownerClass && ownerClass !== 'all' ? `/api/investment-intelligence/holdings?ownerClass=${encodeURIComponent(ownerClass)}` : '/api/investment-intelligence/holdings');
        const json = await res.json();
        if (cancelled) return;
        if (!res.ok) setError(json.error ?? 'Holdings could not be loaded.');
        else setPayload(json.data as HoldingsApiPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Holdings could not be loaded.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ownerClass]);

  if (loading) return <p className="text-sm text-muted">Loading holdings…</p>;
  if (error) return <p className="rounded-card border border-risk bg-white p-4 text-sm text-risk">{error}</p>;
  if (!payload) return null;
  if (payload.empty || payload.holdings.length === 0) {
    return (
      <p className="rounded-card border border-line bg-white p-4 text-sm text-muted">
        No holdings could be matched to a resolved position yet. If you have just processed a statement, this can take a moment to catch up —
        try reloading. If it persists, this is worth reporting.
      </p>
    );
  }

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold text-ink">Holdings</h2>
      <p className="mb-4 text-sm text-muted">
        What you actually hold, at cost and at today&apos;s market value, for each scheme. Select a row to see its full transaction history and how its
        XIRR was derived.
      </p>
      {/* Bounded height with its own vertical scroll, not just horizontal —
          without this, the horizontal scrollbar sits at the very bottom of
          the FULL row list (17+ rows tall), forcing a user to scroll all the
          way down before they can even reach it to see the right-hand
          columns. Bounding the box keeps both scrollbars reachable together.
          The header is sticky within this same box so column labels stay
          visible while scrolling through rows. */}
      <div className="max-h-[520px] overflow-auto rounded-card border border-line">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="sticky top-0 bg-white">
            <tr className="border-b border-line text-xs uppercase tracking-wide text-muted">
              <th className="py-2 pr-4 font-medium">Scheme</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">Folio</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">ISIN</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">Registrar</th>
              <th className="py-2 pr-4 font-medium text-right whitespace-nowrap">Cost value</th>
              <th className="py-2 pr-4 font-medium text-right whitespace-nowrap">Units</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">NAV date</th>
              <th className="py-2 pr-4 font-medium text-right">NAV</th>
              <th className="py-2 pr-4 font-medium text-right">Market value</th>
              <th className="py-2 pr-4 font-medium text-right">Gain/(Loss)</th>
              <th className="py-2 pr-4 font-medium text-right">Return %</th>
              <th className="py-2 pr-4 font-medium text-right">XIRR</th>
              <th className="py-2 pr-4 font-medium whitespace-nowrap">Benchmark</th>
              <th className="py-2 pr-4 font-medium">Data quality</th>
            </tr>
          </thead>
          <tbody>
            {payload.holdings.map((h) => {
              const badge = QUALITY_BADGE[h.dataQuality.status];
              return (
                <tr
                  key={`${h.accountId}:${h.instrumentId}`}
                  className="cursor-pointer border-b border-line align-top hover:bg-gray-50"
                  onClick={() => setSelected({ accountId: h.accountId, instrumentId: h.instrumentId })}
                  role="button"
                  tabIndex={0}
                  aria-label={`View transaction detail for ${h.schemeName}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected({ accountId: h.accountId, instrumentId: h.instrumentId });
                    }
                  }}
                >
                  <td className="py-3 pr-4 font-medium text-ink whitespace-nowrap" title={h.schemeName}>
                    {truncateSchemeName(h.schemeName)}
                  </td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.folioNumber ?? '—'}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.isin ?? '—'}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap">{h.registrar ?? '—'}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.costValue, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{num(h.unitBalance)}</td>
                  <td className="py-3 pr-4 text-muted whitespace-nowrap" title={h.valuationNote}>
                    {h.navDate ? fmtDate(h.navDate, h.currencyCode) : '—'}
                    {/* Document2 Finding #5: say where the NAV came from, so a
                        statement NAV is never mistaken for the latest market
                        NAV, and a stale one is never silently presented as
                        current. The latest market NAV carries no tag — it is
                        the normal case. */}
                    {h.valuationBasis === 'statement' && (
                      <span className="ml-1 inline-block rounded border border-line px-1 text-[10px] font-medium uppercase text-muted">Statement</span>
                    )}
                    {h.valuationBasis === 'redeemed' && (
                      <span className="ml-1 inline-block rounded border border-line px-1 text-[10px] font-medium uppercase text-muted">Redeemed</span>
                    )}
                    {h.valuationStale && (
                      <span className="ml-1 inline-block rounded border border-amber-200 bg-amber-50 px-1 text-[10px] font-medium uppercase text-amber-800">Stale</span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{num(h.nav, 4)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.marketValue, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{money(h.gainLoss, h.currencyCode)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">{pct(h.returnPct)}</td>
                  <td className="py-3 pr-4 text-right tabular-nums text-ink whitespace-nowrap">
                    {h.xirr.status === 'CALCULATED' && h.xirr.value ? pct(h.xirr.value.rate) : '—'}
                  </td>
                  <td className="min-w-[14rem] py-3 pr-4 align-top">
                    {/* The comparison is over THIS holding's own period and cash flows, money-weighted;
                        the engine says so in words. Never a bare lump-sum figure, never a number without
                        a mapping, a verified benchmark and an approved entitlement. */}
                    <BenchmarkComparisonView comparison={h.benchmarkComparison} />
                  </td>
                  <td className="py-3 pr-4">
                    <span className={`inline-block rounded border px-2 py-0.5 text-xs font-medium ${badge.className}`} title={h.dataQuality.detail ?? undefined}>
                      {badge.label}
                    </span>
                    {/* 2026-09-29 fix (resolution-guidance links): 'unresolved'
                        previously had no path forward at all — the row click
                        only opens a read-only ledger, and the badge's tooltip
                        just repeats the same sentence. The reconciliation
                        case for this scheme lives against its source
                        statement, which already has real Resolve/Assign/
                        Re-evaluate actions (Statements & data) — linked
                        directly here rather than leaving the person to find
                        that statement themselves. Not shown for
                        'ai_corrected': that status is already a resolved
                        outcome, informational only. stopPropagation so the
                        link navigates instead of also opening the row's
                        ledger modal underneath it. */}
                    {h.dataQuality.status === 'unresolved' && h.sourceDocumentId && (
                      <Link
                        href={`/investment-intelligence/data?documentId=${encodeURIComponent(h.sourceDocumentId)}`}
                        onClick={(e) => e.stopPropagation()}
                        className="mt-1 block text-xs font-medium text-primary hover:underline"
                      >
                        Resolve on statement
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <TransactionDetailModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        accountId={selected?.accountId ?? null}
        instrumentId={selected?.instrumentId ?? null}
      />
    </section>
  );
}
