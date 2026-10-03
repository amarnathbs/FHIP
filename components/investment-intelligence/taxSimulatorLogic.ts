// Pure logic for the Tax & Cost "Redemption simulator" (no React, no fetch), so
// the rules below are unit-testable without a DOM.
//
// Document2 defects D-6/D-7/D-8 (PO decision 2026-10-03):
//   * The user picks the fund they hold BY NAME (scheme name, with the folio it
//     sits in), never by typing an internal id. Internal ids (instrument, folio)
//     travel only inside this module's holdings list and the API request body;
//     they are never rendered and never typed.
//   * Dates are day-first everywhere the user sees or types one: a typed
//     DD-MM-YYYY field (lib/engines/dateInput.ts) converted to the ISO wire
//     format only at the request boundary, and dates shown back through
//     formatDateShort (lib/engines/date.ts). No YYYY-MM-DD text reaches the
//     screen, including in validation messages.
//
// The whole Tax & Cost page is India-specific (Sections 111A/112A), so dates
// here use the INR (dd-mm-yyyy) shape, matching fmtInr()'s own INR hardcode in
// TaxIntelligenceClient.tsx.

import { formatDateShort } from '@/lib/engines/date';
import { DATE_INPUT_HINT, parseDateInput } from '@/lib/engines/dateInput';

export const TAX_DATE_CURRENCY = 'INR' as const;

const UNITS_EPSILON = 1e-6;
const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The slice of a tax-lot row (tax/lots API) the simulator needs. */
export interface SimulatorLot {
  instrumentId: string;
  instrumentName: string;
  accountId?: string | null;
  accountLabel?: string | null;
  unitsRemaining: number;
}

export interface SimulatorHolding {
  /** Position in the sorted list, as a string. The <select> value; never an internal id. */
  key: string;
  /** Internal; sent in the request body only, never rendered. */
  instrumentId: string;
  /** Internal; sent in the request body only, never rendered. */
  accountId: string | null;
  /** What the user reads: the scheme name, then the folio it is held in. */
  label: string;
  unitsRemaining: number;
}

/** True when text is (or embeds) a database uuid -- such text must never be shown to the user. */
export function looksLikeInternalId(text: string | null | undefined): boolean {
  return typeof text === 'string' && UUID_LIKE.test(text);
}

function readable(text: string | null | undefined): string | null {
  const t = (text ?? '').trim();
  if (!t || looksLikeInternalId(t)) return null;
  return t;
}

/**
 * One entry per (scheme, folio) that still has units to redeem, named the way
 * the user knows it. A scheme held in two folios appears twice, told apart by
 * the folio label; if two entries would still read identically, they are
 * numbered ("holding 1", "holding 2") rather than falling back to an id.
 */
export function buildSimulatorHoldings(lots: ReadonlyArray<SimulatorLot>): SimulatorHolding[] {
  const grouped = new Map<string, { instrumentId: string; accountId: string | null; name: string; folio: string | null; units: number }>();
  for (const lot of lots) {
    if (!(lot.unitsRemaining > UNITS_EPSILON)) continue;
    const accountId = lot.accountId ?? null;
    const key = `${lot.instrumentId}\u0000${accountId ?? ''}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.units += lot.unitsRemaining;
    } else {
      grouped.set(key, {
        instrumentId: lot.instrumentId,
        accountId,
        name: readable(lot.instrumentName) ?? 'Unnamed fund',
        folio: readable(lot.accountLabel),
        units: lot.unitsRemaining,
      });
    }
  }

  const rows = [...grouped.values()]
    .map((g) => ({ ...g, label: g.folio ? `${g.name} — ${g.folio}` : g.name }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.label, (seen.get(r.label) ?? 0) + 1);
  const counter = new Map<string, number>();
  return rows.map((r, i) => {
    let label = r.label;
    if ((seen.get(r.label) ?? 0) > 1) {
      const n = (counter.get(r.label) ?? 0) + 1;
      counter.set(r.label, n);
      label = `${r.label} (holding ${n})`;
    }
    return { key: String(i), instrumentId: r.instrumentId, accountId: r.accountId, label, unitsRemaining: r.units };
  });
}

export interface SimulatorFormState {
  /** SimulatorHolding.key chosen in the dropdown ('' = nothing chosen). */
  holdingKey: string;
  units: string;
  pricePerUnit: string;
  /** What the user typed, day-first (DD-MM-YYYY). */
  disposalDate: string;
}

export interface SimulatorRequest {
  instrumentId: string;
  accountId?: string;
  units: number;
  pricePerUnit: number;
  /** ISO wire format; produced from the typed day-first text, never shown. */
  disposalDate: string;
}

export type SimulatorValidation = { ok: true; request: SimulatorRequest } | { ok: false; message: string };

function parseAmount(text: string): number {
  const cleaned = text.trim().replace(/[,\s]/g, '');
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

function fmtUnits(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

/** Validates the form and builds the request. Every message is plain language and day-first. */
export function validateSimulatorForm(form: SimulatorFormState, holdings: ReadonlyArray<SimulatorHolding>): SimulatorValidation {
  const holding = holdings.find((h) => h.key === form.holdingKey);
  if (!holding) return { ok: false, message: 'Choose the fund you want to redeem.' };

  const units = parseAmount(form.units);
  if (!Number.isFinite(units) || !(units > 0)) return { ok: false, message: 'Enter the number of units to redeem as a number greater than zero.' };
  if (units - holding.unitsRemaining > UNITS_EPSILON) {
    return { ok: false, message: `You hold ${fmtUnits(holding.unitsRemaining)} units in this holding, so ${fmtUnits(units)} units cannot be redeemed.` };
  }

  const price = parseAmount(form.pricePerUnit);
  if (!Number.isFinite(price) || !(price > 0)) return { ok: false, message: 'Enter the price per unit as an amount greater than zero.' };

  const iso = parseDateInput(form.disposalDate);
  if (!iso) return { ok: false, message: `That redemption date is not a valid date. ${DATE_INPUT_HINT}` };

  return {
    ok: true,
    request: {
      instrumentId: holding.instrumentId,
      ...(holding.accountId ? { accountId: holding.accountId } : {}),
      units,
      pricePerUnit: price,
      disposalDate: iso,
    },
  };
}

/** An ISO date from the API shown to the user, day-first (dd-mm-yyyy). */
export function simulatorDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—';
  return formatDateShort(iso.slice(0, 10), TAX_DATE_CURRENCY);
}

/** The slice of the redemption-simulation API response's lotBreakdown the screen shows. */
export interface SimulationLotInput {
  acquisitionDate: string;
  unitsConsumed: number;
  classification: string;
  gainType: string;
  taxableGain: number | null;
}

export interface SimulationLotRow {
  acquired: string;
  units: string;
  classification: string;
  gainType: string;
  taxableGain: number | null;
}

/** Display rows for the lots a simulated redemption would consume (no lot id is ever surfaced). */
export function simulationLotRows(lots: ReadonlyArray<SimulationLotInput> | undefined): SimulationLotRow[] {
  return (lots ?? []).map((l) => ({
    acquired: simulatorDateLabel(l.acquisitionDate),
    units: fmtUnits(l.unitsConsumed),
    classification: l.classification.replace(/_/g, ' '),
    gainType: l.gainType,
    taxableGain: l.taxableGain,
  }));
}
