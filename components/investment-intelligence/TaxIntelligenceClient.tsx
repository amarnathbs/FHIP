'use client';

import { useEffect, useState } from 'react';

// R6-FINAL — India Tax & Cost Intelligence UX (spec Section 27).
//
// Minimal screens covering: Tax Summary, Realised Gains (disposal
// breakdown), Tax Lots (FIFO state), Redemption Simulator, and the explicit
// tax-profile control. Mirrors SipIntelligenceClient.tsx's conventions:
//   1. A figure that is not calculated is NEVER rendered as a number or 0 —
//      it renders an explicit "Not available" / "Unresolved" state.
//   2. Every string here is ESTIMATE/OBSERVATION/SIMULATION language.
//      "Final Tax Payable" / "You Owe" are never used anywhere on this page
//      (Section 24) — only "Estimated..." framing, always paired with the
//      disclaimer and (for realised gains) an explicit taxpayerContext
//      confidence indicator.
//   3. TDS, if ever surfaced, would be structurally separate from tax
//      liability, never summed together (Section 25) — this page does not
//      surface TDS at all yet (no TDS data source exists).

interface Grandfathering {
  eligible: boolean;
  basisSource: string;
  costBasisPerUnit: number;
}
interface DisposalResultView {
  instrumentId: string;
  instrumentName: string;
  acquisitionDate: string;
  disposalDate: string;
  unitsConsumed: number;
  classification: string;
  gainType: string;
  holdingDays: number | null;
  ruleVersion: string | null;
  saleValue: number;
  costBasisUsed: number;
  taxableGain: number | null;
  grandfathering: Grandfathering | null;
  note: string;
}
interface TaxpayerContext {
  taxpayerType: string;
  residencyStatus: string;
  estimateBasis: string;
  dtaaEvaluated: boolean;
  profileComplete: boolean;
  taxpayerTypeNote: string;
}
interface TaxSummaryResponse {
  empty: boolean;
  message?: string;
  warnings?: Array<{ scope: string; detail: string }>;
  disclaimer?: string;
  residencyNote?: string | null;
  ruleVersionNote?: string | null;
  taxpayerContext?: TaxpayerContext;
  taxProfileSource?: string;
  asOfDate?: string;
  taxYearAggregation?: { byTaxYear: Record<string, unknown> };
  disposalResults?: DisposalResultView[];
  exitLoadResults?: Array<{ lotId: string; disposalEventId: string; applicableLoadPct: number; exitLoadAmount: number }>;
}
interface TaxLotView {
  lotId: string;
  instrumentId: string;
  instrumentName: string;
  kind: string;
  acquisitionDate: string;
  unitsAcquired: number;
  unitsRemaining: number;
  status: string;
  costPerUnit: number;
}

function fmtInr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
}

function NotAvailable({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="not-available">
      <span className="font-medium">Not available</span>
      <p className="mt-1 leading-snug">{text}</p>
    </div>
  );
}

const TAXPAYER_TYPES = [
  { value: '', label: 'Not set' },
  { value: 'RESIDENT_INDIVIDUAL', label: 'Resident individual' },
  { value: 'RESIDENT_HUF', label: 'Resident HUF' },
  { value: 'NON_RESIDENT_INDIVIDUAL', label: 'Non-resident individual (NRI)' },
];

export function TaxIntelligenceClient() {
  const [summary, setSummary] = useState<TaxSummaryResponse | null>(null);
  const [lots, setLots] = useState<TaxLotView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [taxpayerType, setTaxpayerType] = useState('');
  const [simForm, setSimForm] = useState({ instrumentId: '', units: '', pricePerUnit: '', disposalDate: '' });
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // Fetches only — deliberately does NOT call setLoading(true)/setError(null)
  // synchronously (those happen in the caller, which is either the initial
  // effect — where `loading` already starts `true` — or a click handler,
  // never inside the effect body itself, matching SipIntelligenceClient's
  // convention: every state update here happens after an await).
  async function fetchTaxData(overrideTaxpayerType?: string) {
    const qs = overrideTaxpayerType ? `?taxpayerType=${encodeURIComponent(overrideTaxpayerType)}` : '';
    const res = await fetch(`/api/investment-intelligence/tax/summary${qs}`);
    const body = await res.json();
    if (!res.ok) throw new Error(body?.error ?? 'Request failed');
    setSummary(body.data as TaxSummaryResponse);
    const lotsRes = await fetch('/api/investment-intelligence/tax/lots');
    const lotsBody = await lotsRes.json();
    if (lotsRes.ok) setLots((lotsBody.data?.lots as TaxLotView[]) ?? []);
  }

  function loadSummary(overrideTaxpayerType?: string) {
    setLoading(true);
    setError(null);
    fetchTaxData(overrideTaxpayerType)
      .catch((e) => setError(e instanceof Error ? e.message : 'Unknown error'))
      .finally(() => setLoading(false));
  }

  // Inline IIFE (not a call to the named fetchTaxData helper) — matches
  // SipIntelligenceClient.tsx's exact structure, which the
  // react-hooks/set-state-in-effect rule accepts: every state update below
  // happens after an await, inside a promise chain the effect merely kicks
  // off, not a synchronous call the linter's static analysis flags.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/investment-intelligence/tax/summary');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) throw new Error(body?.error ?? 'Request failed');
        setSummary(body.data as TaxSummaryResponse);
        const lotsRes = await fetch('/api/investment-intelligence/tax/lots');
        const lotsBody = await lotsRes.json();
        if (!cancelled && lotsRes.ok) setLots((lotsBody.data?.lots as TaxLotView[]) ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runSimulation() {
    setSimLoading(true);
    setSimError(null);
    setSimResult(null);
    try {
      const res = await fetch('/api/investment-intelligence/tax/redemption-simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrumentId: simForm.instrumentId,
          units: Number(simForm.units),
          pricePerUnit: Number(simForm.pricePerUnit),
          disposalDate: simForm.disposalDate,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? 'Request failed');
      setSimResult(body.data);
    } catch (e) {
      setSimError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setSimLoading(false);
    }
  }

  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (error) return <NotAvailable text={error} />;
  if (!summary) return null;

  if (summary.empty) {
    return <NotAvailable text={summary.message ?? 'No tax simulation is available yet.'} />;
  }

  return (
    <div className="space-y-8">
      {/* Tax-profile control */}
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold text-ink">Tax profile</h2>
        <p className="mt-1 text-sm text-muted">
          Set explicitly by you — never inferred from your address, nationality, or portfolio country. Changing this does not change any calculated gain amount
          for equity-oriented funds (Sections 111A/112A apply identically to residents, NRIs, and HUFs for these figures); it changes only the estimate-basis
          label and disclaimers shown below.
        </p>
        <div className="mt-3 flex items-center gap-3">
          <select
            className="rounded border border-line bg-surface px-2 py-1 text-sm"
            value={taxpayerType}
            onChange={(e) => setTaxpayerType(e.target.value)}
            data-testid="taxpayer-type-select"
          >
            {TAXPAYER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <button
            className="rounded border border-line bg-ink px-3 py-1 text-sm text-white"
            onClick={() => void loadSummary(taxpayerType || undefined)}
            data-testid="apply-taxpayer-type"
          >
            Apply
          </button>
        </div>
        {summary.taxpayerContext && (
          <div className="mt-3 text-sm text-muted" data-testid="taxpayer-context">
            <p>
              Estimate basis: <span className="font-medium text-ink">{summary.taxpayerContext.estimateBasis}</span>
              {' · '}DTAA evaluated: <span className="font-medium text-ink">{String(summary.taxpayerContext.dtaaEvaluated)}</span>
            </p>
            <p className="mt-1">{summary.taxpayerContext.taxpayerTypeNote}</p>
          </div>
        )}
      </section>

      {/* Disclaimers */}
      <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <p className="font-medium">Estimate only</p>
        <p className="mt-1">{summary.disclaimer}</p>
        {summary.residencyNote && <p className="mt-2">{summary.residencyNote}</p>}
        {summary.ruleVersionNote && <p className="mt-2">{summary.ruleVersionNote}</p>}
      </section>

      {/* Realised gains */}
      <section>
        <h2 className="text-lg font-semibold text-ink">Realised gains (estimated)</h2>
        {!summary.disposalResults || summary.disposalResults.length === 0 ? (
          <NotAvailable text="No disposals found for this period." />
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th className="py-1 pr-2">Instrument</th>
                  <th className="py-1 pr-2">Acquired</th>
                  <th className="py-1 pr-2">Disposed</th>
                  <th className="py-1 pr-2">Classification</th>
                  <th className="py-1 pr-2">Gain type</th>
                  <th className="py-1 pr-2 text-right">Estimated taxable gain</th>
                </tr>
              </thead>
              <tbody>
                {summary.disposalResults.map((d, i) => (
                  <tr key={i} className="border-b border-line/50" data-testid="disposal-row">
                    <td className="py-1 pr-2">{d.instrumentName}</td>
                    <td className="py-1 pr-2">{d.acquisitionDate}</td>
                    <td className="py-1 pr-2">{d.disposalDate}</td>
                    <td className="py-1 pr-2 capitalize">{d.classification.replace('_', ' ')}</td>
                    <td className="py-1 pr-2 uppercase">{d.gainType}</td>
                    <td className="py-1 pr-2 text-right">{d.taxableGain === null ? <span className="text-slate-500">Unresolved</span> : fmtInr(d.taxableGain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Tax lots */}
      <section>
        <h2 className="text-lg font-semibold text-ink">Tax lots (FIFO)</h2>
        {!lots || lots.length === 0 ? (
          <NotAvailable text="No tax lots on record." />
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-muted">
                  <th className="py-1 pr-2">Instrument</th>
                  <th className="py-1 pr-2">Acquired</th>
                  <th className="py-1 pr-2 text-right">Units acquired</th>
                  <th className="py-1 pr-2 text-right">Units remaining</th>
                  <th className="py-1 pr-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {lots.map((l) => (
                  <tr key={l.lotId} className="border-b border-line/50" data-testid="lot-row">
                    <td className="py-1 pr-2">{l.instrumentName}</td>
                    <td className="py-1 pr-2">{l.acquisitionDate}</td>
                    <td className="py-1 pr-2 text-right">{l.unitsAcquired.toFixed(3)}</td>
                    <td className="py-1 pr-2 text-right">{l.unitsRemaining.toFixed(3)}</td>
                    <td className="py-1 pr-2">{l.status.replace('_', ' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Redemption simulator */}
      <section className="rounded-lg border border-line bg-surface p-4">
        <h2 className="text-lg font-semibold text-ink">Redemption simulator</h2>
        <p className="mt-1 text-sm text-muted">
          Preview the estimated tax impact of a hypothetical redemption. Nothing here is saved or affects your real holdings.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input
            className="rounded border border-line px-2 py-1 text-sm"
            placeholder="Instrument ID"
            value={simForm.instrumentId}
            onChange={(e) => setSimForm((f) => ({ ...f, instrumentId: e.target.value }))}
            data-testid="sim-instrument-id"
          />
          <input
            className="rounded border border-line px-2 py-1 text-sm"
            placeholder="Units"
            value={simForm.units}
            onChange={(e) => setSimForm((f) => ({ ...f, units: e.target.value }))}
            data-testid="sim-units"
          />
          <input
            className="rounded border border-line px-2 py-1 text-sm"
            placeholder="Price per unit"
            value={simForm.pricePerUnit}
            onChange={(e) => setSimForm((f) => ({ ...f, pricePerUnit: e.target.value }))}
            data-testid="sim-price"
          />
          <input
            className="rounded border border-line px-2 py-1 text-sm"
            placeholder="Disposal date (YYYY-MM-DD)"
            value={simForm.disposalDate}
            onChange={(e) => setSimForm((f) => ({ ...f, disposalDate: e.target.value }))}
            data-testid="sim-date"
          />
        </div>
        <button className="mt-3 rounded border border-line bg-ink px-3 py-1 text-sm text-white" onClick={() => void runSimulation()} disabled={simLoading} data-testid="sim-run">
          {simLoading ? 'Simulating…' : 'Simulate'}
        </button>
        {simError && <div className="mt-3"><NotAvailable text={simError} /></div>}
        {simResult && (
          <div className="mt-3 rounded border border-line bg-surface-alt p-3 text-sm" data-testid="sim-result">
            <p>
              Estimated taxable gain: <span className="font-medium">{fmtInr(simResult.totalTaxableGain as number)}</span>
            </p>
            <p>
              Estimated exit load: <span className="font-medium">{fmtInr(simResult.totalExitLoadAmount as number)}</span>
            </p>
            <p className="mt-2 text-xs text-muted">{simResult.disclaimer as string}</p>
          </div>
        )}
      </section>
    </div>
  );
}
