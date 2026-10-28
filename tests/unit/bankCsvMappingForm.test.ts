/**
 * Bank CSV column mapping screen (28-10-2026) -- what the person SEES, rendered on the server from the real component with real state:
 * the columns found with sample values, required fields marked, suggestions flagged and never accepted, the live preview day-first, the
 * date style asked when the values do not prove it, and a Continue button that stays disabled with a plain reason until everything is
 * assigned. Plus the panel's wiring to the map, process and remap routes.
 *
 * No browser here (the repository has no DOM test library); the browser proof is in the report. Evidence label: UNIT-TESTED.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BankCsvMappingForm, initialMappingState, type MappingFormState, type MappingSample } from '@/components/expenses/BankCsvMappingStep';
import { detectBankCsvFormat } from '@/lib/financial-data-hub/bank-csv/detection';
import { buildCustomCsv, buildPoShapedCsv, UNRECOGNISED_VARIANT } from '../support/buildPoShapedBankCsv';

function sampleOf(bytes: Uint8Array): MappingSample {
  const parsed = detectBankCsvFormat(bytes).parsed!;
  return { header: parsed.header, rows: parsed.rows.slice(0, 100), total_rows: parsed.rows.length, delimiter: ',' };
}

function render(sample: MappingSample, state: MappingFormState, extra: { country?: 'AU' | 'IN'; mode?: 'new' | 'change'; error?: string | null; busy?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(BankCsvMappingForm, {
      sample,
      country: extra.country ?? 'AU',
      mode: extra.mode ?? 'new',
      busy: extra.busy ?? false,
      error: extra.error ?? null,
      state,
      onChange: () => undefined,
      onConfirm: () => undefined,
      onCancel: () => undefined,
    }),
  );
}
const continueDisabled = (html: string) => /<button[^>]*data-testid="map-continue"[^>]*>/.exec(html)![0].includes(' disabled=""');

const variantSample = sampleOf(buildPoShapedCsv(342, 1, UNRECOGNISED_VARIANT).bytes);

describe('the screen for the PO-shaped variant', () => {
  const initial = initialMappingState(variantSample);
  const html = render(variantSample, initial);

  it('lists every column found with sample values, and the total', () => {
    expect(html).toContain('Columns found in your file (10)');
    for (const h of variantSample.header) expect(html).toContain(h);
    expect(html).toContain('SYNTH MERCHANT 000');
    expect(html).toContain('Tell us which column is which');
  });
  it('marks required and optional fields and flags every pre-selection as a suggestion to check', () => {
    expect(html).toContain('(required)');
    expect(html).toContain('(optional)');
    expect(html).toContain('Suggested from the column heading. Check it.');
    expect(initial.suggested.length).toBeGreaterThan(5);
  });
  it('proves the date style from the values and says so (the "12:00am Tue 30 June, 2026" shape)', () => {
    expect(html).toContain('reads only one way');
    expect(html).toContain('Time, weekday, day, month name, year');
    expect(initial.dateFormat).toBe('h:mma ddd D MMMM, YYYY');
  });
  it('shows the live preview day-first, never year-first, and never accepts silently: Continue is disabled until the person ticks the check', () => {
    expect(html).toContain('01/07/2025');
    expect(html).not.toContain('2025-07-01');
    expect(html).toContain('How we will read your first rows');
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('Tick the box below once you have checked that the preview matches your file.');
    const ticked = render(variantSample, { ...initial, checked: true });
    expect(continueDisabled(ticked)).toBe(false);
    expect(ticked).not.toContain('Before you can continue');
  });
  it('India shows dd-mm-yyyy', () => {
    const inHtml = render(variantSample, { ...initial, checked: true }, { country: 'IN' });
    expect(inHtml).toContain('01-07-2025');
    expect(inHtml).not.toContain('01/07/2025');
  });
  it('says it will remember the layout, and says how to change it', () => {
    expect(html).toContain('Remember this layout');
    expect(html).toContain('will not ask again');
  });
  it('the change mode explains that nothing needs uploading again and nothing approved is touched', () => {
    const change = render(variantSample, initial, { mode: 'change' });
    expect(change).toContain('Change which column is which');
    expect(change).toContain('do not need to upload it again');
    expect(change).toContain('nothing you approved is touched');
  });
  it('a server error is shown, with the controls still usable', () => {
    const withError = render(variantSample, { ...initial, checked: true }, { error: 'The column "X" chosen for the date is not in this file.' });
    expect(withError).toContain('not in this file');
    expect(continueDisabled(withError)).toBe(false);
  });
});

describe('Continue stays disabled with a plain reason', () => {
  const initial = initialMappingState(variantSample);

  it('a required field left empty is named', () => {
    const html = render(variantSample, { ...initial, checked: true, draft: { ...initial.draft, description: null } });
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('Choose the column that holds the description.');
    expect(html).toContain('Before you can continue:');
  });
  it('no amount style chosen is explained', () => {
    const html = render(variantSample, { ...initial, style: null });
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('Choose how this file shows the amount');
  });
  it('one column given to two fields is refused unless explicitly allowed', () => {
    const twice = { ...initial, checked: true, draft: { ...initial.draft, balance: 'Debit amount' } };
    const refused = render(variantSample, twice);
    expect(continueDisabled(refused)).toBe(true);
    expect(refused).toContain('already used for');
    const allowed = render(variantSample, { ...twice, allowShared: true });
    expect(continueDisabled(allowed)).toBe(false);
  });
  it('a wrong date style reads nothing: the preview says so and Continue is disabled even with the box ticked', () => {
    const html = render(variantSample, { ...initial, checked: true, dateFormat: 'DD/MM/YYYY' });
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('None of the rows checked can be read');
    expect(html).toContain('the date could not be read with the chosen date style');
  });
  it('is disabled while saving, and says so', () => {
    const html = render(variantSample, { ...initial, checked: true }, { busy: true });
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('Saving...');
  });
});

describe('dates that do not prove their own order are asked, never guessed', () => {
  // 12 days of data only, every day-of-month <= 12: dd/mm and mm/dd read every value, differently.
  const base = buildCustomCsv({ count: 20, shape: 'debit_credit', names: { date: 'Txn Dt', description: 'Narration', debit: 'Withdrawal', credit: 'Deposit' } });
  const text = Buffer.from(base.bytes).toString('utf-8').split('\n');
  const ambiguousText = [text[0], ...text.slice(1, 21).map((l, i) => l.replace(/^\d\d\/\d\d\/\d{4}/, `${String((i % 12) + 1).padStart(2, '0')}/${String(((i + 3) % 12) + 1).padStart(2, '0')}/2025`))].join('\n');
  const sample = sampleOf(new Uint8Array(Buffer.from(ambiguousText)));
  const initial = initialMappingState(sample);

  it('no date style is pre-selected, the reason is shown, and Continue is disabled', () => {
    expect(initial.dateFormat).toBeNull();
    const html = render(sample, { ...initial, checked: true });
    expect(html).toContain('could mean different days depending on the order');
    expect(html).toContain('Choose a date style');
    expect(html).toContain('Day/Month/Year');
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('Choose how this file writes dates.');
  });
  it('once the person chooses day-first, the preview and Continue follow', () => {
    const html = render(sample, { ...initial, checked: true, dateFormat: 'DD/MM/YYYY' });
    expect(continueDisabled(html)).toBe(false);
    expect(html).toContain('01/04/2025');
  });
});

describe('any number of columns, any names', () => {
  it('a 27-column file lists all 27 columns and still previews', () => {
    const built = buildCustomCsv({ count: 30, shape: 'single_signed', names: { date: 'Posted On', description: 'Details', amount: 'Value' }, extraColumns: 24 });
    const sample = sampleOf(built.bytes);
    expect(sample.header).toHaveLength(27);
    const html = render(sample, { ...initialMappingState(sample), checked: true });
    expect(html).toContain('Columns found in your file (27)');
    expect(html).toContain('Extra field 24');
    expect(html).toContain('One Amount column');
    expect(continueDisabled(html)).toBe(false);
  });
  it('a file whose headings say nothing is not guessed into a complete mapping: Continue is disabled and says what to choose', () => {
    const text = ['colA,colB,colC', '30/06/2026,hello world,12.50', '29/06/2026,other thing,3.20'].join('\n');
    const sample = sampleOf(new Uint8Array(Buffer.from(text)));
    const initial = initialMappingState(sample);
    const html = render(sample, initial);
    expect(initial.style).toBeNull();
    expect(continueDisabled(html)).toBe(true);
    expect(html).toContain('The column headings do not tell us');
  });
  it('a column with no heading, or a heading used twice, cannot be chosen', () => {
    const text = ['Date,Amt,Amt,', '30/06/2026,1,2,x'].join('\n');
    const sample = sampleOf(new Uint8Array(Buffer.from(text)));
    const html = render(sample, { ...initialMappingState(sample), style: 'single_signed' });
    expect(html).toContain('name used twice, cannot be used');
    expect(html).toContain('no heading, cannot be used');
  });
});

describe('the panel is wired to the new steps (no dead end)', () => {
  const root = join(__dirname, '..', '..');
  const panel = readFileSync(join(root, 'components/expenses/BankStatementImportPanel.tsx'), 'utf8');
  it('opens the mapping step from the detect answer and from the process answer, then carries on without a second upload', () => {
    expect(panel).toContain("detectedStatus === 'manual_mapping_required'");
    expect(panel).toContain("processJson.error === 'mapping_required'");
    expect(panel).toContain("setPhase('map_columns')");
    expect(panel).toContain('<BankCsvMappingStep');
    expect(panel).toMatch(/handleMappingConfirmed[\s\S]*runProcessing\(documentId, true, undefined, true\)/);
  });
  it('after a wrong reading it offers to change the columns and calls the remap route', () => {
    expect(panel).toContain('/remap');
    expect(panel).toContain('Change which column is which');
    expect(panel).toContain('mapping-looks-wrong');
  });
  it('the step itself calls the columns route and the existing map route', () => {
    const step = readFileSync(join(root, 'components/expenses/BankCsvMappingStep.tsx'), 'utf8');
    expect(step).toContain('/bank-csv/${documentId}/columns');
    expect(step).toContain('/bank-csv/${documentId}/map');
  });
});
