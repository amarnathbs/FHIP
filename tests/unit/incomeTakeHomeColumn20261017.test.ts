/**
 * PO request 17-10-2026: a TAKE-HOME column on the Income grid (desktop table, mobile card, form result, footer total), and the report that
 * "there is no way to edit the net salary".
 *
 * FINDING on the edit report (reproduced in a real browser, scripts/a11y/incomeGridCheck.mjs, on a synthetic payslip-imported row):
 *   - NOT a lock. Net Amount and Tax per period are shown, enabled and editable on a row imported from a payslip; no rule hides them
 *     (only the "leave out of my income" opt-out is hidden on imported rows); saving sends the new take-home and does not re-stamp the
 *     provenance, so the row stays "Imported from payslip". Tested below at config, schema and route level.
 *   - DISCOVERABILITY: the table showed Item / Owner / Amount / Currency only, never the net, so nobody could see that a take-home existed
 *     or was missing. The new column fixes that.
 *   - Three REAL defects found beside it, fixed: (1) emptying a number box saved 0 (tests/unit/gridClearableFields20261017.test.ts);
 *     (2) the Add/Edit form renders above the list and pressing Edit far down the page (always on a phone) left it off screen; (3) the form's
 *     labels were not linked to their inputs, so Net Amount had no accessible name. (2) and (3) are proved in the browser check.
 *
 * Hand-calculated oracles (the PO's own figures; never produced by running the code under test):
 *   salary gross 196,994.48 a year, take-home 138,386.48            -> shown 138,386.48, basis entered
 *   Bonus 20,000 a year, no take-home, no tax                       -> shown 20,000, assumed gross (highlighted)
 *   Bonus 20,000 a year, tax 6,000                                  -> shown 14,000, from tax
 *   fortnightly 3,000 gross, take-home 400                          -> 400 a fortnight = 10,400 a year (26 x 400), 13% of gross: hint
 *   monthly rental 2,000, take-home 1,800                           -> 1,800 a month = 21,600 a year
 *   household take-home a year = 138,386.48 + 20,000 + 14,000 (+ 10,400 + 21,600) ; a month = a year / 12
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { TakeHomeDisplay, TakeHomeLive } from '@/components/grid/IncomeTakeHome';
import * as configs from '@/lib/grid/configs';
import { incomeGridConfig } from '@/lib/grid/configs';
import { isFieldHiddenOnRow } from '@/lib/grid/provenance';
import { TAKE_HOME_BASIS_SHORT, incomeTakeHome, takeHomeHint } from '@/lib/grid/incomeTakeHome';
import { resolveNetBasis } from '@/lib/engines/incomeNetBasis';
import { incomePeriodBasisViolation } from '@/lib/import-bridge/adapters/incomeAdapter';
import { incomeSchema, incomeTaxProblem } from '@/lib/validation/income';
import { loadDashboard } from '@/lib/services/dashboardData';
import { selectIncome } from '@/lib/read-models/income';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { incomeSource, profile, tables, taxonomy, USER, WINDOW } from './readModels/helpers/fixtures';

const state = vi.hoisted(() => ({ patch: null as Record<string, unknown> | null, calls: 0 }));
vi.mock('@/lib/services/appCapability', () => ({ requireModuleCapability: async () => ({ user: { id: 'u1' }, blocked: null }) }));
vi.mock('@/lib/services/registry', () => ({
  makeRegistry: () => ({
    update: async (_user: string, id: string, patch: Record<string, unknown>) => {
      state.patch = patch;
      state.calls += 1;
      return { data: { id, ...patch }, error: null };
    },
  }),
}));

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// ---------------------------------------------------------------------------
// The PO's rows
// ---------------------------------------------------------------------------
const SALARY = { amount: 196994.48, net_amount: 138386.48, tax_amount: null, frequency: 'annually', master_item_key: 'employment_salary', source_type: 'payslip_import' };
const BONUS_ASSUMED = { amount: 20000, net_amount: null, tax_amount: null, frequency: 'annually', master_item_key: 'bonus', source_type: 'manual' };
const BONUS_TAX = { ...BONUS_ASSUMED, tax_amount: 6000 };
const FORTNIGHTLY = { amount: 3000, net_amount: 400, tax_amount: null, frequency: 'fortnightly', master_item_key: null, source_type: 'payslip_import' };
const RENTAL = { amount: 2000, net_amount: 1800, tax_amount: null, frequency: 'monthly', master_item_key: 'rental_income', source_type: 'manual' };

describe('incomeTakeHome: the three bases (hand oracles)', () => {
  it('entered: salary 196,994.48 with take-home 138,386.48 shows 138,386.48', () => {
    const t = incomeTakeHome(SALARY)!;
    expect(t.net).toBe(138386.48);
    expect(t.basis).toBe('entered');
    expect(t.annualNet).toBe(138386.48);
    expect(t.plausibility).toBe('ok'); // 70.2% of gross
  });
  it('assumed gross: a Bonus of 20,000 with neither take-home nor tax shows 20,000, basis assumed', () => {
    const t = incomeTakeHome(BONUS_ASSUMED)!;
    expect(t.net).toBe(20000);
    expect(t.basis).toBe('assumed_gross');
  });
  it('from tax: a Bonus of 20,000 with tax 6,000 shows 14,000', () => {
    const t = incomeTakeHome(BONUS_TAX)!;
    expect(t.net).toBe(14000);
    expect(t.basis).toBe('derived_from_tax');
  });
  it('per the row\'s own frequency, with the annual equivalent by the footer rule (x 12 of the monthly rate)', () => {
    const f = incomeTakeHome(FORTNIGHTLY)!;
    expect(f.net).toBe(400);
    expect(f.annualNet).toBe(10400); // 400 x 26
    expect(f.annualGross).toBe(78000); // 3,000 x 26
    expect(incomeTakeHome(RENTAL)!.annualNet).toBe(21600);
  });
  it('a one-off has no yearly equivalent to state', () => {
    const t = incomeTakeHome({ amount: 5000, net_amount: 4000, frequency: 'one_off' })!;
    expect(t.hasAnnualEquivalent).toBe(false);
    expect(t.net).toBe(4000);
  });
  it('blank form boxes ("" / null / text) are "not entered", never 0', () => {
    expect(incomeTakeHome({ amount: '20000', net_amount: '', tax_amount: '', frequency: 'annually' })).toMatchObject({ net: 20000, basis: 'assumed_gross' });
    expect(incomeTakeHome({ amount: 20000, net_amount: 'abc', tax_amount: null, frequency: 'annually' })).toMatchObject({ net: 20000, basis: 'assumed_gross' });
  });
  it('no usable gross yet shows nothing rather than a made-up figure', () => {
    expect(incomeTakeHome({ amount: '', frequency: 'annually' })).toBeNull();
    expect(incomeTakeHome({ amount: undefined })).toBeNull();
  });
  it('an explicit take-home of 0 is an entered 0 (the rule is the engine\'s), and it is flagged as implausible for a wage', () => {
    const t = incomeTakeHome({ ...SALARY, net_amount: 0 })!;
    expect(t.basis).toBe('entered');
    expect(t.plausibility).toBe('net_far_below_gross');
  });
});

// ---------------------------------------------------------------------------
// ONE SOURCE OF TRUTH: parity with the engine rule, the read model and the Dashboard
// ---------------------------------------------------------------------------
const GROSSES = [0, 1, 8000, 196994.48];
const NETS = [null, undefined, 0, 6000, 138386.48, 250000];
const TAXES = [null, undefined, 0, 500, 6000, 9000, -5];

/** Every combination where `candidate` disagrees with the engine's rule (net or basis). */
function parityMismatches(candidate: (gross: number, net: number | null | undefined, tax: number | null | undefined) => { net: number; basis: string }) {
  const out: string[] = [];
  for (const g of GROSSES) for (const n of NETS) for (const x of TAXES) {
    const want = resolveNetBasis(g, n, x);
    const got = candidate(g, n, x);
    if (got.net !== want.net || got.basis !== want.basis) out.push(`${g}/${n}/${x}`);
  }
  return out;
}

describe('parity with lib/engines/incomeNetBasis.ts', () => {
  it('the column\'s figure and basis equal resolveNetBasis for every combination', () => {
    expect(
      parityMismatches((g, n, x) => {
        const t = incomeTakeHome({ amount: g, net_amount: n, tax_amount: x, frequency: 'annually' })!;
        return { net: t.net, basis: t.basis };
      }),
    ).toEqual([]);
  });

  it('NEGATIVE CONTROL: a column with its own rule (the retired "blank take-home is nil" rule, or gross minus tax without the guards) is caught', () => {
    const retiredGap09 = (_g: number, n: number | null | undefined) => (n == null ? { net: 0, basis: 'unknown' } : { net: n, basis: 'entered' });
    const naive = (g: number, n: number | null | undefined, x: number | null | undefined) =>
      n != null ? { net: n, basis: 'entered' } : x != null ? { net: g - x, basis: 'derived_from_tax' } : { net: g, basis: 'assumed_gross' };
    expect(parityMismatches(retiredGap09).length).toBeGreaterThan(0);
    expect(parityMismatches(naive).length).toBeGreaterThan(0); // tax above gross / negative tax: the engine ignores it, the naive rule does not
  });

  it('the column sources contain no take-home arithmetic of their own and use the engine rule', () => {
    for (const file of ['lib/grid/incomeTakeHome.ts', 'components/grid/IncomeTakeHome.tsx']) {
      expect(ownRuleLines(read(file)), file).toEqual([]);
    }
    expect(read('lib/grid/incomeTakeHome.ts')).toContain("from '@/lib/engines/incomeNetBasis'");
    expect(read('lib/grid/incomeTakeHome.ts')).toContain('resolveNetBasis(');
    // NEGATIVE CONTROL: the same scanner catches a copy that recomputes the rule.
    const mutated = read('lib/grid/incomeTakeHome.ts').replace('resolveNetBasis(gross,', 'ownNet(gross - (taxOf(row) ?? 0),');
    expect(ownRuleLines(mutated).length).toBeGreaterThan(0);
  });
});

/** Lines that subtract a tax from a gross by hand (an own rule) in a column source. */
function ownRuleLines(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .filter((l) => /(gross|amount)\s*-\s*\(?\s*(tax|row\.tax|taxOf)/i.test(l) || /net_amount\s*\?\?/.test(l));
}

const HOUSEHOLD: Row[] = [
  incomeSource('sal', 'Employment Salary', 196994.48, 'annually', { net_amount: 138386.48, source_type: 'payslip_import', employer_name: 'Acme' }),
  incomeSource('bon', 'Bonus', 20000, 'annually', { master_item_key: 'bonus' }),
  incomeSource('tax', 'Consulting side job', 20000, 'annually', { master_item_key: null, tax_amount: 6000 }),
  incomeSource('fort', 'Casual shifts', 3000, 'fortnightly', { master_item_key: null, net_amount: 2400 }),
  incomeSource('rent', 'Rental Income', 2000, 'monthly', { master_item_key: 'rental_income', net_amount: 1800, income_type: 'rental' }),
];
const asGridRow = (r: Row) => ({ amount: r.amount, net_amount: r.net_amount ?? null, tax_amount: r.tax_amount ?? null, frequency: r.frequency, master_item_key: (r.master_item_key as string | null | undefined) ?? null, source_type: r.source_type });

describe('parity with the Dashboard and the Income read model for a household', () => {
  // a year: 138,386.48 + 20,000 (assumed) + 14,000 (from tax) + 2,400 x 26 (= 62,400) + 1,800 x 12 (= 21,600) = 256,386.48
  const ANNUAL_NET = 138386.48 + 20000 + 14000 + 62400 + 21600;

  it('hand oracle: the household take-home is 256,386.48 a year, 21,365.54 a month', () => {
    const sum = HOUSEHOLD.map((r) => incomeTakeHome(asGridRow(r))!.annualNet).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(ANNUAL_NET, 2);
    expect(sum / 12).toBeCloseTo(21365.54, 2);
  });

  it('the Dashboard\'s net income is the same figure as the column\'s annual take-home / 12, and names the same assumed source', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: HOUSEHOLD }));
    const d = await loadDashboard(USER, client as never);
    const columnMonthly = HOUSEHOLD.map((r) => incomeTakeHome(asGridRow(r))!.annualNet).reduce((a, b) => a + b, 0) / 12;
    expect(d.netMonthlyIncome).toBeCloseTo(columnMonthly, 1);
    expect(d.netMonthlyIncome).toBeCloseTo(ANNUAL_NET / 12, 1);
    expect(d.dataStatus?.netIncomeAssumed.sources.map((s) => s.name)).toEqual(['Bonus']);
    const assumedInColumn = HOUSEHOLD.filter((r) => incomeTakeHome(asGridRow(r))!.basis === 'assumed_gross').map((r) => r.source_name);
    expect(assumedInColumn).toEqual(['Bonus']);
  });

  it('the Income read model line for every row has the column\'s take-home and basis', async () => {
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: HOUSEHOLD }));
    const res = await selectIncome(USER, { client, window: WINDOW });
    if (res.status !== 'ok') throw new Error('unavailable');
    for (const line of res.planned.lines) {
      const row = HOUSEHOLD.find((r) => r.source_name === line.name)!;
      const t = incomeTakeHome(asGridRow(row))!;
      expect(line.netNative, line.name).toBeCloseTo(t.net, 2);
      expect(line.netBasis, line.name).toBe(t.basis);
    }
  });

  it('plausibility: the column flags exactly the wage rows the Dashboard flags', async () => {
    const rows = [
      ...HOUSEHOLD.filter((r) => r.id !== 'fort'),
      incomeSource('fort', 'Casual shifts', 3000, 'fortnightly', { master_item_key: null, net_amount: 400, source_type: 'payslip_import' }),
    ];
    const { client } = makeFakeSupabase(tables(profile(), taxonomy(), { income_sources: rows }));
    const d = await loadDashboard(USER, client as never);
    const dashboardFlagged = (d.dataStatus?.netIncomeImplausible ?? []).map((f) => f.name).sort();
    const columnFlagged = rows.filter((r) => incomeTakeHome(asGridRow(r))!.plausibility !== 'ok').map((r) => r.source_name as string).sort();
    expect(columnFlagged).toEqual(['Casual shifts']);
    expect(dashboardFlagged).toEqual(columnFlagged);
  });
});

// ---------------------------------------------------------------------------
// The column renders for the Income grid only
// ---------------------------------------------------------------------------
describe('the take-home column is the Income grid only', () => {
  it('exactly one grid config sets takeHome: the Income register', () => {
    const all = Object.entries(configs).filter(([, v]) => v && typeof v === 'object' && 'category' in (v as object) && 'fields' in (v as object));
    expect(all.length).toBeGreaterThanOrEqual(7);
    const withTakeHome = all.filter(([, v]) => (v as { takeHome?: boolean }).takeHome).map(([k]) => k);
    expect(withTakeHome).toEqual(['incomeGridConfig']);
  });

  it('every part of the grid that shows take-home is gated on config.takeHome (header, cell, empty-row span, card, footer)', () => {
    const src = read('components/grid/FinancialDataGrid.tsx');
    expect(src).toContain("{config.takeHome && <th className={`px-3 py-2 ${NUM_HEADER_CLASS}`}>Take-home</th>}");
    expect(src).toContain('colSpan={config.takeHome ? 6 : 5}');
    // each place that renders the cell, the card line, the form result and the footer sits under a config.takeHome condition
    for (const marker of ['<TakeHomeDisplay\n                        row={row}', '<TakeHomeLive draft={draft} />', 'Total take-home (annual)']) {
      const at = src.indexOf(marker);
      expect(at, marker).toBeGreaterThan(0);
      expect(src.slice(Math.max(0, at - 700), at), marker).toContain('config.takeHome');
    }
    expect(src.match(/<TakeHomeDisplay/g)?.length).toBe(2); // the table cell and the mobile card
  });

  it('NEGATIVE CONTROL: an ungated copy of the header is detected by the same check', () => {
    const ungated = read('components/grid/FinancialDataGrid.tsx').replace('{config.takeHome && <th', '{true && <th');
    expect(ungated).not.toContain("{config.takeHome && <th className={`px-3 py-2 ${NUM_HEADER_CLASS}`}>Take-home</th>}");
  });
});

// ---------------------------------------------------------------------------
// Rendering: three bases, amber highlight, add affordance, hint, a11y
// ---------------------------------------------------------------------------
const cell = (row: object, extra: { onAdd?: () => void; layout?: 'cell' | 'card' } = {}) =>
  renderToStaticMarkup(createElement(TakeHomeDisplay, { row, currency: 'AUD', itemLabel: 'Item X', layout: extra.layout ?? 'cell', onAddTakeHome: extra.onAdd }));

describe('the Take-home cell', () => {
  it('entered: $138,386 and the label "entered", no amber, no Add take-home control', () => {
    const html = cell(SALARY, { onAdd: () => undefined });
    expect(html).toContain('$138,386');
    expect(html).toContain('>entered<');
    expect(html).toContain('data-basis="entered"');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('Add take-home');
  });

  it('from tax: $14,000 and "from tax", no amber', () => {
    const html = cell(BONUS_TAX, { onAdd: () => undefined });
    expect(html).toContain('$14,000');
    expect(html).toContain('>from tax<');
    expect(html).not.toContain('amber');
    expect(html).not.toContain('Add take-home');
  });

  it('assumed: $20,000, the PO wording "assumed = gross (no tax deducted)", highlighted amber, with an Add take-home control', () => {
    const html = cell(BONUS_ASSUMED, { onAdd: () => undefined });
    expect(html).toContain('$20,000');
    expect(html).toContain('assumed = gross (no tax deducted)');
    expect(TAKE_HOME_BASIS_SHORT.assumed_gross).toBe('assumed = gross (no tax deducted)');
    expect(html).toContain('border-amber-300 bg-amber-50');
    expect(html).toContain('text-amber-900');
    expect(html).toContain('Add take-home');
  });

  it('a non-annual row shows its own period and the annual equivalent as text', () => {
    const html = cell(FORTNIGHTLY);
    expect(html).toContain('$400');
    expect(html).toContain('a fortnight');
    expect(html).toContain('$10,400 a year');
  });

  it('INR rows are formatted in the row currency like the Amount column', () => {
    const html = renderToStaticMarkup(createElement(TakeHomeDisplay, { row: { amount: 1800000, net_amount: 1500000, frequency: 'annually' }, currency: 'INR', itemLabel: 'Salary', layout: 'cell' }));
    expect(html).toContain('₹15,00,000');
  });

  it('plausibility: a wage whose take-home is under 30% of gross carries a plain-text, non-alarming hint with the full reason in its tooltip', () => {
    const html = cell(FORTNIGHTLY);
    expect(html).toContain('Check take-home: only 13% of gross');
    expect(html).toContain('same pay period');
    expect(html).toContain('text-amber-900');
    expect(html).not.toContain('text-risk');
    expect(takeHomeHint(incomeTakeHome({ ...SALARY, net_amount: 250000 })!)?.short).toBe('Check take-home: more than gross');
  });

  it('plausibility applies to wage-like rows only (rental after costs is not flagged), exactly as the Dashboard', () => {
    const html = cell({ ...RENTAL, net_amount: 300 });
    expect(html).not.toContain('Check take-home');
  });

  it('accessibility: the basis is text, the Add control has an accessible name containing its visible text, and there is no raw table', () => {
    const html = cell(BONUS_ASSUMED, { onAdd: () => undefined });
    expect(html).toContain('aria-label="Add take-home for Item X"');
    expect(html).toMatch(/<button type="button"[^>]*>Add take-home<\/button>/);
    expect(html).toContain('title="'); // the full description (annual equivalent and the engine\'s own basis sentence)
    expect(html).toContain('Gross treated as take-home: no tax deducted');
    for (const file of ['components/grid/IncomeTakeHome.tsx', 'lib/grid/incomeTakeHome.ts']) expect(read(file)).not.toMatch(/<table[\s>]/);
  });

  it('the mobile card shows a labelled Take-home line with the same basis', () => {
    const html = cell(BONUS_ASSUMED, { layout: 'card', onAdd: () => undefined });
    expect(html).toContain('Take-home');
    expect(html).toContain('assumed = gross (no tax deducted)');
  });
});

describe('the live result in the Add / Edit form', () => {
  const live = (draft: object) => renderToStaticMarkup(createElement(TakeHomeLive, { draft }));
  it('is a polite live region and says "Take-home = $138,386 per year (entered)"', () => {
    const html = live({ ...SALARY, currency_code: 'AUD' });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Take-home = $138,386 per year (entered)');
  });
  it('from tax and assumed gross are named, assumed in the amber style', () => {
    expect(live({ ...BONUS_TAX, currency_code: 'AUD' })).toContain('Take-home = $14,000 per year (from tax)');
    const assumed = live({ ...BONUS_ASSUMED, currency_code: 'AUD' });
    expect(assumed).toContain('Take-home = $20,000 per year (assumed gross: no tax deducted)');
    expect(assumed).toContain('bg-amber-50');
  });
  it('a fortnightly row also says the per-period figure; a blank gross asks for it', () => {
    expect(live({ ...FORTNIGHTLY, currency_code: 'AUD' })).toContain('Take-home = $10,400 per year (entered), $400 a fortnight');
    expect(live({ amount: '', frequency: 'annually', currency_code: 'AUD' })).toContain('Enter the gross amount');
  });
  it('typing is reflected: the same draft with a different Net Amount gives a different result', () => {
    const a = live({ ...BONUS_ASSUMED, net_amount: 15000, currency_code: 'AUD' });
    expect(a).toContain('$15,000 per year (entered)');
    const b = live({ ...BONUS_ASSUMED, net_amount: '', tax_amount: 6000, currency_code: 'AUD' });
    expect(b).toContain('$14,000 per year (from tax)');
  });
});

// ---------------------------------------------------------------------------
// The Edit form on an imported row: editable, helper text, saved end to end
// ---------------------------------------------------------------------------
describe('Net Amount and Tax are editable on a row imported from a payslip', () => {
  const imported = { source_type: 'payslip_import' };

  it('no field is hidden on an imported row except the "leave out of my income" opt-out', () => {
    const hidden = incomeGridConfig.fields.filter((f) => isFieldHiddenOnRow(f, imported)).map((f) => f.name);
    expect(hidden).toEqual(['superseded_by_bank_import']);
    expect(incomeGridConfig.fieldVisibleForRow).toBeUndefined(); // no per-row visibility rule narrows the Income form
  });

  it('Net Amount and Tax come right after Gross Amount and Frequency, with the PO helper text', () => {
    const names = incomeGridConfig.fields.map((f) => f.name);
    expect(names.slice(0, 4)).toEqual(['amount', 'frequency', 'net_amount', 'tax_amount']);
    const net = incomeGridConfig.fields.find((f) => f.name === 'net_amount')!;
    expect(net.helpText).toBe('Take-home pay for the same period as the gross. Leave blank to use gross minus tax; with neither, gross is treated as take-home');
    expect(incomeGridConfig.fields.find((f) => f.name === 'tax_amount')!.helpText).toContain('Used only when no take-home pay is entered');
  });

  it('the form wires the labels to their inputs, links the helper text, scrolls and focuses on Edit, and says an imported row can be edited', () => {
    const src = read('components/grid/FinancialDataGrid.tsx');
    expect(src).toContain('htmlFor={`grid-field-${f.name}`}');
    expect(src).toContain('id={`grid-field-${f.name}`}');
    expect(src).toContain('aria-describedby={f.helpText ?');
    expect(src).toContain("el.scrollIntoView({ block: 'start' })");
    expect(src).toContain("openEditForm(row, 'net_amount')");
    expect(src).toContain('Your take-home pay (Net Amount) and tax can be changed below.');
  });

  // The body the grid sends for an Edit of the imported salary with a new take-home (see scripts/a11y/incomeGridCheck.mjs for the browser run).
  const gridBody = { owner: 'self', currency_code: 'AUD', source_name: 'Employment Salary', master_item_key: 'employment_salary', amount: 196994.48, frequency: 'annually', net_amount: 140000, is_taxable: true, employer_name: 'Acme Pty Ltd' };

  it('the API schema accepts it, and a partial PATCH with only the take-home, or an explicit null to clear it', () => {
    expect(incomeSchema.safeParse(gridBody).success).toBe(true);
    const patch = incomeSchema.partial();
    expect(patch.safeParse({ net_amount: 140000 }).success).toBe(true);
    expect(patch.safeParse({ net_amount: null }).success).toBe(true);
    expect(patch.safeParse({ tax_amount: null }).success).toBe(true);
    expect(patch.safeParse({ net_amount: -1 }).success).toBe(false);
  });

  it('tax can never exceed the gross it is a part of', () => {
    expect(incomeTaxProblem({ amount: 8000, tax_amount: 9000 })).toMatch(/cannot be more than the gross/);
    expect(incomeTaxProblem({ amount: 8000, tax_amount: 8000 })).toBeNull();
    expect(incomeTaxProblem({ tax_amount: 9000 })).toBeNull(); // PATCH carrying only one of the two: the database CHECK (migration 0285) covers it
  });

  it('the payslip import cannot mix period bases onto a row the user edited: amounts need their frequency (guard unchanged)', () => {
    const fields = [
      { fieldName: 'amount', proposedValue: '3000', existingValue: '196994.48' },
      { fieldName: 'net_amount', proposedValue: '2400', existingValue: '140000' },
      { fieldName: 'frequency', proposedValue: 'fortnightly', existingValue: 'annually' },
    ];
    expect(incomePeriodBasisViolation(fields, ['net_amount'])).toMatch(/Apply the frequency with them/);
    expect(incomePeriodBasisViolation(fields, ['amount', 'net_amount', 'frequency'])).toBeNull();
  });
});

describe('PATCH /api/income/[id] on an imported row: the take-home is saved and the provenance is left alone', () => {
  const call = async (body: unknown) => {
    const { PATCH } = await import('@/app/api/income/[id]/route');
    state.patch = null;
    const res = await PATCH(new Request('http://localhost/api/income/sal', { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id: 'sal' }) });
    return { status: res.status, json: await res.json() };
  };

  it('a new take-home is written, with no source_type or import-link column in the patch', async () => {
    const r = await call({ amount: 196994.48, net_amount: 140000, frequency: 'annually', is_taxable: true });
    expect(r.status).toBe(200);
    expect(state.patch).toMatchObject({ net_amount: 140000 });
    expect(Object.keys(state.patch ?? {})).not.toContain('source_type');
    expect(Object.keys(state.patch ?? {})).not.toContain('last_import_application_id');
  });

  it('an explicit null clears the take-home', async () => {
    const r = await call({ amount: 196994.48, net_amount: null, frequency: 'annually' });
    expect(r.status).toBe(200);
    expect(state.patch).toMatchObject({ net_amount: null });
  });

  it('a tax above the gross is refused with 422 and nothing is written', async () => {
    const before = state.calls;
    const r = await call({ amount: 8000, tax_amount: 9000 });
    expect(r.status).toBe(422);
    expect(state.calls).toBe(before);
  });
});
