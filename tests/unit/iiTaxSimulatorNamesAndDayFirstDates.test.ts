/**
 * Document2 defects D-6 / D-7 / D-8 (PO decision 2026-10-03) -- the Tax & Cost
 * "Redemption simulator":
 *   D-6  it asked the user to TYPE an internal "Instrument ID" (a database uuid);
 *   D-7  it asked for the disposal date as "YYYY-MM-DD";
 *   D-8  validation text and echoed dates were year-first.
 *
 * Rules enforced here:
 *   1. The user picks a fund by NAME (scheme + folio) and never sees or types an
 *      internal id -- not in the rendered form, not in any message, not in labels.
 *   2. Dates are typed DD-MM-YYYY (lib/engines/dateInput.ts) and shown through
 *      formatDateShort(..., 'INR') (dd-mm-yyyy); no ISO year-first text reaches
 *      the screen, validation messages included.
 *
 * EVIDENCE LABEL: code-complete, unit-tested against the pure logic and a static
 * server render of the form. NOT browser-verified (no DOM environment).
 *
 * NEGATIVE CONTROLS (a green check that cannot fail proves nothing): the LEGACY
 * component/route/validation text is embedded below as a faithful copy of the
 * pre-fix behaviour, and every assertion helper used on the new code is shown to
 * THROW against it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildSimulatorHoldings,
  looksLikeInternalId,
  simulationLotRows,
  simulatorDateLabel,
  validateSimulatorForm,
  type SimulatorLot,
} from '@/components/investment-intelligence/taxSimulatorLogic';
import { RedemptionSimulator } from '@/components/investment-intelligence/RedemptionSimulator';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;

/** Throws when text shows a uuid, an ISO date, or the literal ISO format name. */
function assertNoIdOrIso(text: string): void {
  if (UUID.test(text)) throw new Error(`internal id visible: ${text}`);
  if (ISO_DATE.test(text)) throw new Error(`ISO date visible: ${text}`);
  if (/YYYY-MM-DD/i.test(text)) throw new Error(`ISO format name visible: ${text}`);
}

/** Source-level scan of a component/route for the three legacy defects. Returns the violations found. */
function scanSimulatorSource(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
  const out: string[] = [];
  if (/placeholder="Instrument ID"/i.test(code)) out.push('asks the user to type an Instrument ID');
  if (/instrumentId:\s*e\.target\.value/.test(code)) out.push('binds a typed value straight to instrumentId');
  if (/YYYY-MM-DD/.test(code)) out.push('shows the YYYY-MM-DD format name');
  if (/disposalDate:\s*simForm\.disposalDate/.test(code)) out.push('sends the raw typed text as the date (no day-first parse)');
  return out;
}

const INSTR_A = '3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f';
const INSTR_B = '7d9e1a2b-6c3f-4a58-8b21-1f2e3d4c5b6a';
const ACC_1 = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const ACC_2 = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';

const lots: SimulatorLot[] = [
  { instrumentId: INSTR_A, instrumentName: 'HDFC Flexi Cap Fund - Direct Growth', accountId: ACC_1, accountLabel: 'CAMS — 1234567/89', unitsRemaining: 100 },
  { instrumentId: INSTR_A, instrumentName: 'HDFC Flexi Cap Fund - Direct Growth', accountId: ACC_1, accountLabel: 'CAMS — 1234567/89', unitsRemaining: 50.5 },
  { instrumentId: INSTR_A, instrumentName: 'HDFC Flexi Cap Fund - Direct Growth', accountId: ACC_2, accountLabel: 'KFintech — 998877', unitsRemaining: 20 },
  { instrumentId: INSTR_B, instrumentName: 'Axis Bluechip Fund - Regular Growth', accountId: ACC_1, accountLabel: 'CAMS — 1234567/89', unitsRemaining: 10 },
  // fully consumed lot: nothing left to redeem, so it is not offered
  { instrumentId: INSTR_B, instrumentName: 'Axis Bluechip Fund - Regular Growth', accountId: ACC_2, accountLabel: 'KFintech — 998877', unitsRemaining: 0 },
];

describe('D-6: the fund is chosen by name, never by an internal id', () => {
  const holdings = buildSimulatorHoldings(lots);

  it('offers one entry per (scheme, folio) that still has units, sorted, with the units summed', () => {
    expect(holdings.map((h) => h.label)).toEqual([
      'Axis Bluechip Fund - Regular Growth — CAMS — 1234567/89',
      'HDFC Flexi Cap Fund - Direct Growth — CAMS — 1234567/89',
      'HDFC Flexi Cap Fund - Direct Growth — KFintech — 998877',
    ]);
    expect(holdings.map((h) => h.unitsRemaining)).toEqual([10, 150.5, 20]);
  });

  it('a scheme held in two folios is told apart by the folio, not by an id', () => {
    const hdfc = holdings.filter((h) => h.label.startsWith('HDFC'));
    expect(hdfc).toHaveLength(2);
    expect(new Set(hdfc.map((h) => h.label)).size).toBe(2);
  });

  it('no label and no select key is an internal id', () => {
    for (const h of holdings) {
      expect(() => assertNoIdOrIso(h.label)).not.toThrow();
      expect(() => assertNoIdOrIso(h.key)).not.toThrow();
    }
  });

  it('a missing name or folio label that fell back to an id upstream is replaced by plain words, never shown', () => {
    const leaky = buildSimulatorHoldings([
      { instrumentId: INSTR_A, instrumentName: INSTR_A, accountId: ACC_1, accountLabel: ACC_1, unitsRemaining: 5 },
    ]);
    expect(leaky).toHaveLength(1);
    expect(leaky[0].label).toBe('Unnamed fund');
    expect(() => assertNoIdOrIso(leaky[0].label)).not.toThrow();
    expect(looksLikeInternalId(INSTR_A)).toBe(true);
    expect(looksLikeInternalId('HDFC Flexi Cap Fund')).toBe(false);
  });

  it('two entries that would still read identically are numbered, never disambiguated with an id', () => {
    const twins = buildSimulatorHoldings([
      { instrumentId: INSTR_A, instrumentName: 'Same Fund', accountId: ACC_1, accountLabel: 'CAMS', unitsRemaining: 1 },
      { instrumentId: INSTR_A, instrumentName: 'Same Fund', accountId: ACC_2, accountLabel: 'CAMS', unitsRemaining: 2 },
    ]);
    expect(twins.map((t) => t.label)).toEqual(['Same Fund — CAMS (holding 1)', 'Same Fund — CAMS (holding 2)']);
  });

  it('the request carries the internal ids (it must), chosen from the dropdown -- the user never typed them', () => {
    const chosen = holdings.find((h) => h.label.startsWith('HDFC') && h.label.includes('KFintech'))!;
    const v = validateSimulatorForm({ holdingKey: chosen.key, units: '5', pricePerUnit: '120.50', disposalDate: '01-10-2026' }, holdings);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.request.instrumentId).toBe(INSTR_A);
      expect(v.request.accountId).toBe(ACC_2);
    }
  });

  it('with nothing chosen the message asks for a fund by name and shows no id', () => {
    const v = validateSimulatorForm({ holdingKey: '', units: '5', pricePerUnit: '10', disposalDate: '01-10-2026' }, holdings);
    expect(v).toEqual({ ok: false, message: 'Choose the fund you want to redeem.' });
  });

  it('redeeming more units than held is refused in plain words', () => {
    const chosen = holdings.find((h) => h.label.startsWith('Axis'))!;
    const v = validateSimulatorForm({ holdingKey: chosen.key, units: '11', pricePerUnit: '10', disposalDate: '01-10-2026' }, holdings);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.message).toMatch(/You hold 10 units/);
      expect(() => assertNoIdOrIso(v.message)).not.toThrow();
    }
  });
});

describe('D-7/D-8: dates are typed and shown day-first, never ISO', () => {
  const holdings = buildSimulatorHoldings(lots);
  const key = holdings[0].key;
  const base = { holdingKey: key, units: '1', pricePerUnit: '10' };

  it('a typed DD-MM-YYYY date is converted to the ISO wire format only inside the request', () => {
    const v = validateSimulatorForm({ ...base, disposalDate: '05-03-2026' }, holdings);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request.disposalDate).toBe('2026-03-05');
  });

  it('DD/MM/YYYY is accepted too, and is read day-first (not month-first)', () => {
    const v = validateSimulatorForm({ ...base, disposalDate: '03/04/2026' }, holdings);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.request.disposalDate).toBe('2026-04-03');
  });

  it('typed ISO text is rejected, not reinterpreted', () => {
    const v = validateSimulatorForm({ ...base, disposalDate: '2026-03-05' }, holdings);
    expect(v.ok).toBe(false);
  });

  it('an impossible date is rejected', () => {
    expect(validateSimulatorForm({ ...base, disposalDate: '31-02-2026' }, holdings).ok).toBe(false);
  });

  it('every date-related validation message is day-first with a worked example and no ISO text', () => {
    for (const typed of ['', '2026-03-05', '31-02-2026', 'tomorrow']) {
      const v = validateSimulatorForm({ ...base, disposalDate: typed }, holdings);
      expect(v.ok).toBe(false);
      if (!v.ok) {
        expect(v.message).toContain('01-10-2026');
        expect(() => assertNoIdOrIso(v.message)).not.toThrow();
      }
    }
  });

  it('dates shown back use dd-mm-yyyy (formatDateShort INR)', () => {
    expect(simulatorDateLabel('2026-10-01')).toBe('01-10-2026');
    expect(simulatorDateLabel('2026-10-01T08:30:00Z')).toBe('01-10-2026');
    expect(simulatorDateLabel(null)).toBe('—');
    const rows = simulationLotRows([{ acquisitionDate: '2024-02-29', unitsConsumed: 12.3456, classification: 'long_term', gainType: 'ltcg', taxableGain: 100 }]);
    expect(rows[0].acquired).toBe('29-02-2024');
    expect(rows[0].classification).toBe('long term');
    for (const v of Object.values(rows[0])) expect(() => assertNoIdOrIso(String(v))).not.toThrow();
  });
});

describe('the rendered form: names, a day-first date field, no id field', () => {
  const html = renderToStaticMarkup(createElement(RedemptionSimulator, { lots }));

  it('lists the holdings by name', () => {
    expect(html).toContain('HDFC Flexi Cap Fund - Direct Growth');
    expect(html).toContain('KFintech');
  });

  it('shows no uuid and no ISO date or format name anywhere in the rendered text and attributes', () => {
    expect(() => assertNoIdOrIso(html)).not.toThrow();
  });

  it('has no Instrument ID field and a DD-MM-YYYY date field with a worked example', () => {
    expect(html).not.toMatch(/Instrument ID/i);
    expect(html).not.toContain('sim-instrument-id');
    expect(html).toContain('placeholder="DD-MM-YYYY"');
    expect(html).toContain('like 01-10-2026');
  });

  it('with no redeemable holding it says so in words instead of asking for an id', () => {
    const empty = renderToStaticMarkup(createElement(RedemptionSimulator, { lots: [] }));
    expect(empty).toContain('no holdings with units left to redeem');
    expect(empty).not.toContain('<input');
  });
});

describe('source contract: the real files carry none of the legacy defects', () => {
  it('RedemptionSimulator.tsx and the redemption-simulation route are clean', () => {
    expect(scanSimulatorSource(read('components/investment-intelligence/RedemptionSimulator.tsx'))).toEqual([]);
    expect(scanSimulatorSource(read('app/api/investment-intelligence/tax/redemption-simulation/route.ts'))).toEqual([]);
  });

  it('TaxIntelligenceClient.tsx delegates to the simulator and keeps no id/ISO input of its own', () => {
    const src = read('components/investment-intelligence/TaxIntelligenceClient.tsx');
    expect(scanSimulatorSource(src)).toEqual([]);
    expect(src).toContain('<RedemptionSimulator');
  });

  it('the route never echoes an internal id as a name or folio fallback', () => {
    for (const rel of [
      'app/api/investment-intelligence/tax/redemption-simulation/route.ts',
      'app/api/investment-intelligence/tax/lots/route.ts',
      'app/api/investment-intelligence/tax/summary/route.ts',
    ]) {
      const src = read(rel);
      expect(src, rel).not.toMatch(/instrumentNames\.get\([^)]*\)\s*\?\?\s*(?:instrumentId|l\.instrumentKey|d\.instrumentKey)/);
      expect(src, rel).not.toMatch(/accountLabels\.get\([^)]*\)\s*\?\?\s*(?:id|resolvedAccountId|l\.accountKey)\b/);
    }
  });

  it('the route validation messages name no internal field and no ISO format', () => {
    const src = read('app/api/investment-intelligence/tax/redemption-simulation/route.ts');
    const messages = [...src.matchAll(/return bad\('([^']*)'/g)].map((m) => m[1]);
    expect(messages.length).toBeGreaterThan(4);
    for (const m of messages) {
      expect(() => assertNoIdOrIso(m), m).not.toThrow();
      expect(m, m).not.toMatch(/\b(instrumentId|accountId|pricePerUnit|disposalDate)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS -- a faithful copy of the PRE-FIX behaviour must fail every
// new assertion. If any of these stops throwing, the guard above has gone vacuous.
// ---------------------------------------------------------------------------

// Verbatim from TaxIntelligenceClient.tsx before this change.
const LEGACY_COMPONENT_SNIPPET = `
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
            placeholder="Disposal date (YYYY-MM-DD)"
            value={simForm.disposalDate}
            onChange={(e) => setSimForm((f) => ({ ...f, disposalDate: e.target.value }))}
            data-testid="sim-date"
          />
        </div>`;
const LEGACY_REQUEST_SNIPPET = `        body: JSON.stringify({
          instrumentId: simForm.instrumentId,
          units: Number(simForm.units),
          pricePerUnit: Number(simForm.pricePerUnit),
          disposalDate: simForm.disposalDate,
        }),`;
// Verbatim route messages before this change.
const LEGACY_ROUTE_MESSAGES = ['instrumentId is required.', 'disposalDate is required, format YYYY-MM-DD.'];

describe('NEGATIVE CONTROL: the legacy simulator fails the new guards', () => {
  it('the source scanner flags the legacy component (id field, ISO format name)', () => {
    const found = scanSimulatorSource(LEGACY_COMPONENT_SNIPPET);
    expect(found).toContain('asks the user to type an Instrument ID');
    expect(found).toContain('binds a typed value straight to instrumentId');
    expect(found).toContain('shows the YYYY-MM-DD format name');
  });

  it('the source scanner flags the legacy request that sent the raw typed date', () => {
    expect(scanSimulatorSource(LEGACY_REQUEST_SNIPPET)).toContain('sends the raw typed text as the date (no day-first parse)');
  });

  it('the no-id/no-ISO assertion throws on the legacy placeholder and the legacy route messages', () => {
    expect(() => assertNoIdOrIso('Disposal date (YYYY-MM-DD)')).toThrow(/ISO format name/);
    expect(() => assertNoIdOrIso(LEGACY_ROUTE_MESSAGES[1])).toThrow(/ISO format name/);
    expect(() => assertNoIdOrIso('Redemption on 2026-10-01')).toThrow(/ISO date/);
    expect(() => assertNoIdOrIso(`Instrument ${INSTR_A}`)).toThrow(/internal id/);
  });

  it('the legacy route field-name messages would trip the "names no internal field" rule', () => {
    expect(LEGACY_ROUTE_MESSAGES[0]).toMatch(/\b(instrumentId|accountId|pricePerUnit|disposalDate)\b/);
  });

  it('a legacy-style holdings label (id fallback) would trip the no-uuid assertion', () => {
    const legacyLabel = `${INSTR_A} — ${ACC_1}`;
    expect(() => assertNoIdOrIso(legacyLabel)).toThrow(/internal id/);
  });

  it('a legacy validator (Number(...) and the raw typed date) lets typed ISO text through, which the new one refuses', () => {
    const legacyAccepts = (typed: string) => /^\d{4}-\d{2}-\d{2}$/.test(typed);
    expect(legacyAccepts('2026-03-05')).toBe(true);
    const holdings = buildSimulatorHoldings(lots);
    expect(validateSimulatorForm({ holdingKey: holdings[0].key, units: '1', pricePerUnit: '1', disposalDate: '2026-03-05' }, holdings).ok).toBe(false);
  });
});
