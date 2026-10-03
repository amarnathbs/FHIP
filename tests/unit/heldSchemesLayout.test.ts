// Held-schemes TABLE LAYOUT and display names. EVIDENCE LABEL: pure-function tests and source-contract tests
// (there is no DOM environment in this repository). They prove the name shortening and that the layout rules are
// present in the source; they do NOT prove how it renders in a browser, which has not been checked here.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildHeldSchemeRows, shortSchemeName, type HeldSchemeRaw } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import { HELD_ACTION_LABEL, HELD_TABLE_LAYOUT, shortFundHouse } from '@/components/admin/benchmarkData/HeldSchemesTable';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('shortSchemeName (display only)', () => {
  it.each([
    ['B92-Aditya Birla Sun Life Large Cap Fund -Growth-Regular Plan(formerly known as Aditya Birla Sun Life Frontline Equity Fund) (Non-Demat)', 'Aditya Birla Sun Life Large Cap Fund'],
    ['H44-HDFC Large Cap Fund - Regular Plan - Growth (formerly HDFC Top 100 Fund) (Non-Demat)', 'HDFC Large Cap Fund'],
    ['L101G-SBI Multi Asset Allocation Fund Regular Growth (formerly SBI Magnum Monthly Income Plan Floater) (Non-Demat)', 'SBI Multi Asset Allocation Fund'],
    ['Parag Parikh Flexi Cap Fund', 'Parag Parikh Flexi Cap Fund'],
    ['SBI Large Cap Fund', 'SBI Large Cap Fund'],
    ['128EFGPG-Axis Large Cap Fund - Regular Growth (Non Demat)', 'Axis Large Cap Fund'],
    ['FTI037-Franklin India Flexi Cap Fund - Growth (erstwhile Franklin India Equity Fund) (Non-Demat)', 'Franklin India Flexi Cap Fund'],
    ['FTI036-Franklin India Mid Cap FUND - Growth (erstwhile Franklin India PRIMA FUND - Growth) (Non-Demat)', 'Franklin India Mid Cap FUND'],
    ['HGFG-HDFC Balanced Advantage Fund - Regular Plan - Growth (formerly HDFC Growth Fund, erstwhile HDFC Prudence Fund merged) (Non -Demat)', 'HDFC Balanced Advantage Fund'],
    ['H44T-HDFC Large Cap Fund - Direct Plan - Growth Option (formerly HDFC Top 100 Fund) (Non-Demat)', 'HDFC Large Cap Fund'],
    ['HACGPG-HDFC Small Cap Fund - Regular Plan - Growth Plan (Non-Demat)', 'HDFC Small Cap Fund'],
    ['P2373-ICICI Prudential Dividend Yield Fund Growth (Non-Demat)', 'ICICI Prudential Dividend Yield Fund'],
    ['RMFPSGPG-NIPPON INDIA POWER & INFRA FUND - GROWTH PLAN - GROWTH OPTION (Non Demat)', 'NIPPON INDIA POWER & INFRA FUND'],
    ['108MFGPG-UTI MNC Fund - Regular Plan (Non Demat)', 'UTI MNC Fund'],
    ['L036G-SBI Contra Fund - Regular Plan - Growth (Non-Demat)', 'SBI Contra Fund'],
  ])('%s -> %s', (input, expected) => {
    expect(shortSchemeName(input)).toBe(expected);
  });

  it('every one of the 19 production names becomes a short name: no registrar code, no "formerly", no demat, no plan/option tail, at most 60 characters', () => {
    const inv = JSON.parse(read('docs/investment-intelligence/bench1_phase2/inventory/inventory_prod.json')) as { rows: Array<{ instrument_name: string }> };
    expect(inv.rows).toHaveLength(19);
    for (const r of inv.rows) {
      const s = shortSchemeName(r.instrument_name);
      expect(s, r.instrument_name).not.toMatch(/^[A-Z0-9]{2,10}-\S|formerly|erstwhile|demat|\(/i);
      expect(s, r.instrument_name).not.toMatch(/(regular|direct|growth|option|idcw)\s*$/i);
      expect(s.length, r.instrument_name).toBeLessThanOrEqual(60);
      expect(s.length, r.instrument_name).toBeGreaterThan(8);
    }
  });

  it('NEGATIVE CONTROL: a lone trailing "Plan" that is part of the name is kept, and a name that would shrink to nothing falls back to the cleaned name', () => {
    expect(shortSchemeName('Some Retirement Savings Plan')).toBe('Some Retirement Savings Plan');
    expect(shortSchemeName('Growth')).toBe('Growth');
    expect(shortSchemeName('  ')).toBe('');
  });

  it('the display name comes from the scheme master when present, else from the statement name; both are shortened; the full and original names are kept', () => {
    const base: HeldSchemeRaw = { instrumentId: 'a', instrumentName: 'B92-Aditya Birla Sun Life Large Cap Fund -Growth-Regular Plan(formerly known as Aditya Birla Sun Life Frontline Equity Fund) (Non-Demat)', amcName: 'Aditya Birla Sun Life Mutual Fund', amfiSchemeCode: '103174', subCategory: 'Large Cap Fund', categoryHeaderRaw: null, holderCount: 12, firstHeldDate: '2015-08-21', mapped: false, proposalWaiting: false };
    const fromMaster = buildHeldSchemeRows([{ ...base, schemeMasterName: 'Aditya Birla Sun Life Large Cap Fund - Growth - Regular Plan' }]).rows[0];
    expect(fromMaster).toMatchObject({ displayName: 'Aditya Birla Sun Life Large Cap Fund', nameSource: 'scheme_master', fullName: 'Aditya Birla Sun Life Large Cap Fund - Growth - Regular Plan' });
    const fromStatement = buildHeldSchemeRows([base]).rows[0];
    expect(fromStatement).toMatchObject({ displayName: 'Aditya Birla Sun Life Large Cap Fund', nameSource: 'statement' });
    expect(fromStatement.originalName).toBe(base.instrumentName);
  });

  it('the fund house drops "Mutual Fund"', () => {
    expect(shortFundHouse('Aditya Birla Sun Life Mutual Fund')).toBe('Aditya Birla Sun Life');
    expect(shortFundHouse('HDFC Mutual Fund')).toBe('HDFC');
    expect(shortFundHouse(null)).toBe('Unknown');
  });
});

/** The rule the layout must satisfy, applied to a source string: the scheme name is clamped and the as-printed text is not an extra line. */
function nameIsBounded(src: string): boolean {
  return /line-clamp-2[^>]*title=\{tooltip\}/.test(src) && !/<br \/><span[^>]*>\{h\.planType\}; as printed: \{h\.originalName\}<\/span>/.test(src);
}

describe('layout contract (source)', () => {
  const table = read('components/admin/benchmarkData/HeldSchemesTable.tsx');
  const tab = read('components/admin/benchmarkData/MappingsTab.tsx');
  const ui = read('components/admin/benchmarkData/ui.tsx');

  it('the scheme name and the benchmark sentence are clamped to two lines, with the full text in a title', () => {
    expect(HELD_TABLE_LAYOUT.nameClamp).toBe('line-clamp-2');
    expect(HELD_TABLE_LAYOUT.textClamp).toBe('line-clamp-2');
    expect(table).toMatch(/\$\{L\.nameClamp\}/);
    expect(table).toMatch(/\$\{L\.textClamp\}/);
    expect(table).toMatch(/title=\{tooltip\}/);
    expect(nameIsBounded(table.replace('${L.nameClamp}', 'line-clamp-2'))).toBe(true);
  });

  it('NEGATIVE CONTROL: the OLD layout (name, then a second "as printed" line, no clamp) is detected as unbounded, so the clamp test above would fail against it', () => {
    const oldCell = '<Td><span title={h.originalName}>{h.displayName}</span><br /><span className="text-xs text-muted">{h.planType}; as printed: {h.originalName}</span></Td>';
    expect(nameIsBounded(oldCell)).toBe(false);
    expect(table).not.toContain('as printed: {h.originalName}</span></Td>');
    expect(tab).not.toContain('as printed: {h.originalName}');
  });

  it('the as-printed and full names are only in the keyboard-reachable Details view and the tooltip (aria-expanded button), not extra lines', () => {
    expect(table).toMatch(/aria-expanded=\{isOpen\}/);
    expect(table).toMatch(/As printed on the statement/);
    expect(table).toMatch(/\{isOpen \? \(/);
  });

  it('columns have minimum widths and the Scheme column is wide (about 28 characters or more)', () => {
    expect(HELD_TABLE_LAYOUT.schemeMin).toMatch(/^min-w-\[(1[7-9]|2\d)(\.\d+)?rem\]$/);
    for (const k of ['fundHouseMin', 'categoryMin', 'holdersMin', 'firstHeldMin', 'benchmarkMin'] as const) expect(HELD_TABLE_LAYOUT[k], k).toMatch(/^min-w-\[[\d.]+rem\]$/);
    expect(table).toMatch(/minWidth=\{L\.tableMin\}/);
  });

  it('the table scrolls horizontally INSIDE its own container (a focusable region), never the page, and the Action column is sticky on the right', () => {
    expect(ui).toMatch(/overflow-x-auto[^`]*`/); // ScrollTable's container
    expect(ui).toMatch(/role="region"[^>]*tabIndex=\{0\}/);
    expect(HELD_TABLE_LAYOUT.actionSticky).toMatch(/\bsticky\b/);
    expect(HELD_TABLE_LAYOUT.actionSticky).toMatch(/\bright-0\b/);
    expect(table).toMatch(/<Th className=\{`bg-gray-50 \$\{L\.actionSticky\}`\}>Action<\/Th>/);
    expect(table).toMatch(/<Td className=\{`bg-white \$\{L\.actionSticky\}`\}>/); // opaque, so scrolled content does not show through
    expect(tab).toMatch(/<HeldSchemesTable /);
  });

  it('keeps table semantics and accessible controls', () => {
    expect(ui).toMatch(/<caption className="sr-only">\{label\}<\/caption>/);
    expect(ui).toMatch(/scope="col"/);
    expect(table).toMatch(/aria-label=\{`\$\{isOpen \? 'Hide' : 'Show'\} details for \$\{h\.displayName\}`\}/);
  });

  it('the Action label is short, constant and never contains the scheme name; the name is in aria-label and title only', () => {
    expect(HELD_ACTION_LABEL).toBe('Enter declared benchmark');
    expect(table).toMatch(/\{HELD_ACTION_LABEL\}/);
    expect(table).toMatch(/ariaLabel=\{`Enter declared benchmark from factsheet for \$\{h\.displayName\}`\}/);
    expect(table).toMatch(/title=\{`Enter the declared benchmark from the factsheet for \$\{h\.fullName\}`\}/);
    expect(table).toMatch(/\bnowrap\b/);
    expect(ui).toMatch(/nowrap \? 'whitespace-nowrap'/);
    // The visible children of the action Btn are the constant only.
    // The visible children of the action Btn are the constant only (the closing of its opening tag is `}>` before the label).
    const visible = /<Btn kind="secondary" nowrap[\s\S]*?\}>\s*([\s\S]*?)\s*<\/Btn>/.exec(table)?.[1] ?? '';
    expect(visible).toBe('{HELD_ACTION_LABEL}');
    expect(visible).not.toMatch(/displayName|fullName|originalName/);
  });

  it('NEGATIVE CONTROL: the OLD action label put the whole scheme name in the visible text', () => {
    const oldLabel = '{`Enter declared benchmark from factsheet (${h.displayName})`}';
    const visibleHasName = (s: string) => /displayName|fullName|originalName/.test(s);
    expect(visibleHasName(oldLabel)).toBe(true); // what the old markup did
    expect(tab).not.toMatch(/Enter declared benchmark from factsheet \(\$\{/);
    expect(table).not.toMatch(/Enter declared benchmark from factsheet \(\$\{/);
  });

  it('day-first dates through the shared formatter, never an ISO literal', () => {
    expect(table).toMatch(/formatDate\(h\.firstHeldDate\)/);
    expect(table).not.toMatch(/toISOString|toLocaleDateString/);
  });
});
