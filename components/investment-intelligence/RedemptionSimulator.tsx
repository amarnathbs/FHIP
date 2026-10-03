'use client';

import { useMemo, useState } from 'react';
import { formatMoneyCode } from '@/lib/engines/money';
import { DATE_INPUT_HINT, DATE_INPUT_PLACEHOLDER } from '@/lib/engines/dateInput';
import {
  buildSimulatorHoldings,
  simulationLotRows,
  simulatorDateLabel,
  validateSimulatorForm,
  type SimulationLotInput,
  type SimulatorFormState,
  type SimulatorLot,
} from './taxSimulatorLogic';

// Tax & Cost "Redemption simulator" (R6-FINAL, spec Section 27).
//
// Document2 defects D-6/D-7/D-8 (PO decision 2026-10-03): the user chooses the
// fund they hold by NAME (scheme + folio) from a dropdown built from their own
// tax lots -- there is no field that asks for, or shows, an internal id -- and
// dates are typed and shown day-first (DD-MM-YYYY), never as an ISO year-first
// date. All of that logic lives in taxSimulatorLogic.ts (pure, unit-tested).

function fmtInr(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return formatMoneyCode(v, 'INR');
}

function NotAvailable({ text }: { text: string }) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-600" data-testid="not-available">
      <span className="font-medium">Not available</span>
      <p className="mt-1 leading-snug">{text}</p>
    </div>
  );
}

export function RedemptionSimulator({ lots }: { lots: ReadonlyArray<SimulatorLot> }) {
  const [simForm, setSimForm] = useState<SimulatorFormState>({ holdingKey: '', units: '', pricePerUnit: '', disposalDate: '' });
  const [simResult, setSimResult] = useState<Record<string, unknown> | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  // The funds the user can redeem, named the way they know them (scheme + folio). Built from their own tax lots.
  const holdings = useMemo(() => buildSimulatorHoldings(lots), [lots]);
  const chosenHolding = holdings.find((h) => h.key === simForm.holdingKey) ?? null;

  async function runSimulation() {
    setSimError(null);
    setSimResult(null);
    const check = validateSimulatorForm(simForm, holdings);
    if (!check.ok) {
      setSimError(check.message);
      return;
    }
    setSimLoading(true);
    try {
      const res = await fetch('/api/investment-intelligence/tax/redemption-simulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(check.request),
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

  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-lg font-semibold text-ink">Redemption simulator</h2>
      <p className="mt-1 text-sm text-muted">
        Preview the estimated tax impact of a hypothetical redemption. Nothing here is saved or affects your real holdings.
      </p>
      {holdings.length === 0 ? (
        <div className="mt-3">
          <NotAvailable text="You have no holdings with units left to redeem, so there is nothing to simulate." />
        </div>
      ) : (
        <>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-sm text-ink sm:col-span-2">
              Fund to redeem
              <select
                className="mt-1 block w-full min-w-0 rounded border border-line bg-surface px-2 py-1 text-sm"
                value={simForm.holdingKey}
                onChange={(e) => setSimForm((f) => ({ ...f, holdingKey: e.target.value }))}
                data-testid="sim-holding"
              >
                <option value="">Choose a fund you hold</option>
                {holdings.map((h) => (
                  <option key={h.key} value={h.key}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
            {chosenHolding && (
              <p className="text-xs text-muted sm:col-span-2" data-testid="sim-units-held">
                You hold {chosenHolding.unitsRemaining.toLocaleString('en-IN', { maximumFractionDigits: 3 })} units in this holding.
              </p>
            )}
            <label className="block text-sm text-ink">
              Units to redeem
              <input
                className="mt-1 block w-full rounded border border-line px-2 py-1 text-sm"
                inputMode="decimal"
                value={simForm.units}
                onChange={(e) => setSimForm((f) => ({ ...f, units: e.target.value }))}
                data-testid="sim-units"
              />
            </label>
            <label className="block text-sm text-ink">
              Price per unit
              <input
                className="mt-1 block w-full rounded border border-line px-2 py-1 text-sm"
                inputMode="decimal"
                value={simForm.pricePerUnit}
                onChange={(e) => setSimForm((f) => ({ ...f, pricePerUnit: e.target.value }))}
                data-testid="sim-price"
              />
            </label>
            <label className="block text-sm text-ink">
              Redemption date
              <input
                className="mt-1 block w-full rounded border border-line px-2 py-1 text-sm"
                placeholder={DATE_INPUT_PLACEHOLDER}
                inputMode="numeric"
                value={simForm.disposalDate}
                onChange={(e) => setSimForm((f) => ({ ...f, disposalDate: e.target.value }))}
                data-testid="sim-date"
              />
              <span className="mt-1 block text-xs text-muted">{DATE_INPUT_HINT}</span>
            </label>
          </div>
          <button className="mt-3 rounded border border-line bg-ink px-3 py-1 text-sm text-white" onClick={() => void runSimulation()} disabled={simLoading} data-testid="sim-run">
            {simLoading ? 'Simulating…' : 'Simulate'}
          </button>
        </>
      )}
      {simError && <div className="mt-3"><NotAvailable text={simError} /></div>}
      {simResult && (
        <div className="mt-3 rounded border border-line bg-surface-alt p-3 text-sm" data-testid="sim-result">
          <p className="text-xs text-muted">
            {String(simResult.instrumentName ?? '')}
            {simResult.accountLabel ? ` — ${String(simResult.accountLabel)}` : ''}
            {' · '}redemption on {simulatorDateLabel(simResult.disposalDate as string | undefined)}
          </p>
          <p className="mt-1">
            Estimated taxable gain: <span className="font-medium">{fmtInr(simResult.totalTaxableGain as number)}</span>
          </p>
          <p>
            Estimated exit load: <span className="font-medium">{fmtInr(simResult.totalExitLoadAmount as number)}</span>
          </p>
          {simulationLotRows(simResult.lotBreakdown as SimulationLotInput[] | undefined).length > 0 && (
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-xs" data-testid="sim-lot-rows">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="py-1 pr-2">Acquired</th>
                    <th className="py-1 pr-2 text-right">Units</th>
                    <th className="py-1 pr-2">Classification</th>
                    <th className="py-1 pr-2">Gain type</th>
                    <th className="py-1 pr-2 text-right">Estimated taxable gain</th>
                  </tr>
                </thead>
                <tbody>
                  {simulationLotRows(simResult.lotBreakdown as SimulationLotInput[] | undefined).map((r, i) => (
                    <tr key={i} className="border-b border-line/50">
                      <td className="py-1 pr-2">{r.acquired}</td>
                      <td className="py-1 pr-2 text-right">{r.units}</td>
                      <td className="py-1 pr-2 capitalize">{r.classification}</td>
                      <td className="py-1 pr-2 uppercase">{r.gainType}</td>
                      <td className="py-1 pr-2 text-right">{r.taxableGain === null ? <span className="text-slate-500">Unresolved</span> : fmtInr(r.taxableGain)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-xs text-muted">{simResult.disclaimer as string}</p>
        </div>
      )}
    </section>
  );
}
