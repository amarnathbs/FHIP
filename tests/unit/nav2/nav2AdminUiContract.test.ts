// NAV2 admin and report screens: a button must LOOK and BEHAVE like a button, a date is typed day-first, and every failure is shown
// where it happened. (PO feedback on the live DEV page /admin/investment-intelligence/risk-free-data: "Save" and "Preview" rendered as
// plain text, inputs had no borders, the date asked for yyyy-mm-dd, and a bad date produced a bare 422 far from the button.)
//
// There is no DOM environment, so this is a SOURCE contract over the four components plus pure-logic and static-markup tests of the shared
// pieces they use. NEGATIVE CONTROLS re-run each contract check on a mutated copy of the real source and assert the NAMED failure appears.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ActionMessage, Btn } from '@/components/admin/benchmarkData/ui';
import { checkCorrection, checkVerifiedThrough, describeFailure } from '@/components/admin/riskFreeFormLogic';
import { DateInput, dateInputInvalid, dateInputShown } from '@/components/ui/DateInput';
import { DATE_INPUT_HINT } from '@/lib/engines/dateInput';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

const RISK = 'components/admin/RiskFreeDataClient.tsx';
const MONITOR = 'components/admin/Nav2MonitoringClient.tsx';
const REPORT_CLIENT = 'components/reports/FundAnalyticsReportClient.tsx';
const REPORT_VIEW = 'components/reports/FundAnalyticsReportView.tsx';
const ALL = [RISK, MONITOR, REPORT_CLIENT, REPORT_VIEW];

const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

/** Every failure of the "real controls, inline results" contract, by name. */
function contractFailures(file: string, source: string): string[] {
  const s = code(source);
  const out: string[] = [];
  if (/<button\b/.test(s)) out.push('bare-button: a <button> that does not use the shared Btn');
  if (/<select\b/.test(s)) out.push('bare-select: a <select> that does not use the shared SelectField');
  if (/<input\b/.test(s)) out.push('bare-input: an <input> that does not use the shared fields');
  if (/<textarea\b/.test(s)) out.push('bare-textarea');
  if (/style=\{\{/.test(s)) out.push('inline-style: inline styles instead of the shared tokens');
  if (!/from '@\/components\/admin\/benchmarkData\/ui'/.test(s)) out.push('no-shared-kit: does not import the shared admin kit');
  if (/<Btn\b/.test(s) && !/\bActionMessage\b/.test(s)) out.push('no-inline-result: has buttons but never renders an ActionMessage next to them');
  if (file === RISK) {
    // Every area a message can be written to must be rendered next to its own button.
    const areas = new Set<string>();
    for (const m of s.matchAll(/setMsg\('(\w+)'/g)) areas.add(m[1]);
    for (const m of s.matchAll(/\bsend\('(\w+)'/g)) areas.add(m[1]);
    for (const a of areas) if (!new RegExp(`<ActionMessage message=\\{msgs\\.${a}\\b`).test(s)) out.push(`error-not-inline: area "${a}" writes a message that is not rendered next to its button`);
    if ((s.match(/<ActionMessage message=\{msgs\[area\]/g) ?? []).length < 2) out.push('error-not-inline: the review and series-switch buttons do not render their own result');
    if (!/data-testid="page-top-banner"/.test(s)) out.push('banner-removed: the page-top banner was removed');
    // The three numbered steps, in plain words.
    for (const [n, title] of [[1, 'Choose the file'], [2, 'Check the file']] as const) if (!s.includes(`<Step n={${n}} title="${title}"`)) out.push(`step-missing: step ${n} "${title}"`);
    if (!/<Step n=\{3\} title=\{preview \? `Upload \$\{preview\.willInsert\} rows` : 'Upload the rows'\}/.test(s)) out.push('step-missing: step 3 "Upload N rows"');
    if (!s.includes('Check file (writes nothing)')) out.push('label: the check button must read "Check file (writes nothing)"');
    if (/Preview \(writes nothing\)/.test(s)) out.push('label: the old "Preview (writes nothing)" label is back');
    if (/Commit \$\{|Commit \{/.test(s)) out.push('label: the old "Commit N row(s)" label is back');
    // The attestation sits directly above the Upload button, and Upload is the primary button.
    const att = s.indexOf('label={status.attestationText}');
    const upload = s.indexOf('{preview ? `Upload ${preview.willInsert} rows` : \'Upload rows\'}');
    if (att < 0 || upload < 0 || att > upload) out.push('attestation-order: the attestation must come before the Upload button');
    else if (/<ActionMessage|<Step\b|<Notice/.test(s.slice(att, upload))) out.push('attestation-order: something sits between the attestation and the Upload button');
    if (!/<Btn kind="primary" busy=\{busyArea === 'upload'\}/.test(s)) out.push('upload-not-primary: the Upload button must be the primary button');
    if (!/disabled=\{busy \|\| !preview \|\| !preview\.canCommit \|\| !attested\}/.test(s)) out.push('upload-enabled-early: Upload must stay disabled until the file is checked and the box is ticked');
    // Dates: typed day-first, converted at the boundary.
    if (!/<DateField[\s]+label="Verified through/.test(s) || !/<DateField label="Date"/.test(s)) out.push('date-field: Verified through and the correction Date must be DateField (DD-MM-YYYY)');
    if (!/checkVerifiedThrough\(verifiedThrough\)/.test(s) || !/checkCorrection\(corr\)/.test(s)) out.push('date-boundary: the typed date must be converted with checkVerifiedThrough / checkCorrection');
    if (/yyyy/i.test(s)) out.push('iso-wording: yyyy appears in code');
  }
  return out;
}

describe('NAV2 admin screens: real controls, results shown where they happened', () => {
  for (const f of ALL) {
    it(`${f}: no bare button/select/input/textarea or inline styles, uses the shared kit`, () => {
      expect(contractFailures(f, read(f))).toEqual([]);
    });
  }

  it('the shared Btn is a real button: bordered or filled, 44px target, visible focus ring, clear disabled state, busy state', () => {
    const on = renderToStaticMarkup(createElement(Btn, { kind: 'primary', onClick: () => {} } as never, 'Upload 12 rows'));
    expect(on).toContain('<button');
    for (const c of ['bg-trust', 'text-white', 'min-h-11', 'focus-visible:outline', 'rounded', 'font-semibold']) expect(on, c).toContain(c);
    const off = renderToStaticMarkup(createElement(Btn, { kind: 'primary', disabled: true } as never, 'Upload rows'));
    expect(off).toContain('disabled=""');
    expect(off).toContain('disabled:opacity-50');
    expect(off).toContain('disabled:cursor-not-allowed');
    const secondary = renderToStaticMarkup(createElement(Btn, { kind: 'secondary' } as never, 'Check file (writes nothing)'));
    expect(secondary).toContain('border border-line');
    const busy = renderToStaticMarkup(createElement(Btn, { kind: 'primary', busy: true } as never, 'Save'));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('Working...');
  });

  it('ActionMessage: an error is role=alert, a success is role=status, both focusable so they can take focus; nothing when there is no message', () => {
    const err = renderToStaticMarkup(createElement(ActionMessage, { message: { kind: 'error', text: 'The "Verified through" date is not a real date.' } }));
    expect(err).toContain('role="alert"');
    expect(err).toContain('tabindex="-1"');
    expect(err).toContain('not a real date');
    const ok = renderToStaticMarkup(createElement(ActionMessage, { message: { kind: 'ok', text: 'Uploaded.' } }));
    expect(ok).toContain('role="status"');
    expect(renderToStaticMarkup(createElement(ActionMessage, { message: null }))).toBe('');
  });

  it('ActionMessage scrolls into view and takes focus when a message arrives (source)', () => {
    const ui = read('components/admin/benchmarkData/ui.tsx');
    const block = ui.slice(ui.indexOf('export function ActionMessage'), ui.indexOf('export function CheckField'));
    expect(block).toContain('scrollIntoView');
    expect(block).toContain('.focus(');
    expect(block).toContain('useEffect');
  });

  it('the Fund Analytics report page shows a failed Generate / Export right under its buttons', () => {
    const s = code(read(REPORT_CLIENT));
    expect(s.indexOf('<ActionMessage')).toBeGreaterThan(s.indexOf('Generate a new version'));
    expect(s.indexOf('<ActionMessage')).toBeLessThan(s.indexOf('<FundAnalyticsReportView'));
    expect(s).toContain('Export PDF');
  });

  it('the monitoring page has a Refresh button whose result is shown next to it', () => {
    const s = code(read(MONITOR));
    expect(s).toContain('Refresh the figures');
    expect(s.indexOf('<ActionMessage')).toBeGreaterThan(s.indexOf('Refresh the figures'));
  });
});

describe('the risk-free form logic: dates typed day-first, failures worded for a person', () => {
  it('Verified through: empty is none; DD-MM-YYYY (also / and .) becomes ISO only at the boundary', () => {
    expect(checkVerifiedThrough('')).toEqual({ ok: true, iso: null });
    expect(checkVerifiedThrough('03-10-2026')).toEqual({ ok: true, iso: '2026-10-03' });
    expect(checkVerifiedThrough('3/10/2026')).toEqual({ ok: true, iso: '2026-10-03' });
    expect(checkVerifiedThrough('03.10.2026')).toEqual({ ok: true, iso: '2026-10-03' });
  });

  it('Verified through: year-first, month-first nonsense and impossible dates are refused with the day-first hint, never with yyyy-mm-dd', () => {
    for (const bad of ['2026-10-03', '10-31-2026', '31-02-2026', '03-13-2026', 'tomorrow', '3-10-26']) {
      const r = checkVerifiedThrough(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain(DATE_INPUT_HINT);
        expect(r.error).toContain('Verified through');
        expect(/yyyy/i.test(r.error)).toBe(false);
        expect(r.error).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      }
    }
  });

  it('correction: each problem is attached to its own field; a valid draft converts the date to ISO', () => {
    const empty = checkCorrection({ date: '', newValue: '', reason: '' });
    expect(empty.ok).toBe(false);
    expect(Object.keys(empty.errors).sort()).toEqual(['date', 'newValue', 'reason']);
    const bad = checkCorrection({ date: '2026-10-03', newValue: '120', reason: 'too short' });
    expect(bad.errors.date).toContain(DATE_INPUT_HINT);
    expect(bad.errors.newValue).toContain('between 0 and 100');
    expect(bad.errors.reason).toContain('at least 20');
    const good = checkCorrection({ date: '03-10-2026', newValue: '6,5', reason: 'The RBI release shows 6.5 not 6.25.' });
    expect(good).toMatchObject({ ok: true, iso: '2026-10-03', value: 6.5, errors: {} });
  });

  it('describeFailure: names the field and shows the day-first hint for a bad date; never a bare status code', () => {
    const t = describeFailure(422, { error: 'Please check: Verified Through.', fields: { verifiedThrough: 'Enter a valid date.' } }, 'The file could not be checked.');
    expect(t).toContain('Verified through');
    expect(t).toContain(DATE_INPUT_HINT);
    expect(t).not.toMatch(/^\d{3}:/);
    expect(describeFailure(401, null, 'x')).toMatch(/Sign in again/);
    expect(describeFailure(403, {}, 'x')).toMatch(/permission/);
    expect(describeFailure(500, {}, 'The rows could not be uploaded.')).toMatch(/The rows could not be uploaded\. The server could not finish this/);
    expect(describeFailure(409, { error: 'This file was already uploaded.' }, 'x')).toBe('This file was already uploaded.');
    expect(describeFailure(400, {}, 'The file could not be checked.')).toBe('The file could not be checked.');
  });
});

describe('the shared day-first date input', () => {
  it('renders a text box with the DD-MM-YYYY placeholder and shows an ISO value day-first (never a native picker)', () => {
    const html = renderToStaticMarkup(createElement(DateInput, { value: '2026-10-03', id: 'd1', showHint: true }));
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="DD-MM-YYYY"');
    expect(html).toContain('value="03-10-2026"');
    expect(html).toContain(DATE_INPUT_HINT);
    expect(html).not.toContain('type="date"');
    expect(html).not.toContain('2026-10-03');
    expect(renderToStaticMarkup(createElement(DateInput, { value: '' }))).toContain('value=""');
  });

  it('while typing, the text typed is kept; a different value from outside replaces it', () => {
    expect(dateInputShown('3-10-26', '')).toBe('3-10-26');
    expect(dateInputShown('03-10-2026', '2026-10-03')).toBe('03-10-2026');
    expect(dateInputShown('3/10/2026', '2026-10-03')).toBe('3/10/2026');
    expect(dateInputShown('03-10-2026', '2026-11-04')).toBe('04-11-2026');
    expect(dateInputShown(null, '2026-10-03')).toBe('03-10-2026');
  });

  it('invalid: not a real date, or outside the ISO bounds; empty is fine', () => {
    expect(dateInputInvalid('')).toBe(false);
    expect(dateInputInvalid('31-02-2026')).toBe(true);
    expect(dateInputInvalid('2026-10-03')).toBe(true);
    expect(dateInputInvalid('03-10-2026')).toBe(false);
    expect(dateInputInvalid('03-10-1890', '1900-01-01')).toBe(true);
    expect(dateInputInvalid('03-10-2026', undefined, '2026-10-01')).toBe(true);
    expect(dateInputInvalid('01-10-2026', undefined, '2026-10-01')).toBe(false);
  });
});

describe('NEGATIVE CONTROLS: each contract check demonstrably fails on a mutated copy of the real source', () => {
  const real = read(RISK);
  const mutate = (from: string | RegExp, to: string): string => {
    const next = real.replace(from, to);
    if (next === real) throw new Error(`the control did not change the source: ${String(from)}`);
    return next;
  };
  const failures = (src: string) => contractFailures(RISK, src);

  it('UI-NC-0: the real source passes (the controls are not noise)', () => {
    expect(failures(real)).toEqual([]);
  });

  it('UI-NC-1: a plain <button> (the reported defect) is caught', () => {
    expect(failures(mutate('<Btn kind="primary" busy={busyArea === \'upload\'}', '<button type="button"')).some((x) => x.startsWith('bare-button'))).toBe(true);
  });

  it('UI-NC-2: a bare <input> or <select> and an inline style (the unstyled fields) are caught', () => {
    expect(failures(mutate('<CheckField label="This is the first load of the historical file"', '<input type="checkbox" /><CheckField label="This is the first load of the historical file"')).some((x) => x.startsWith('bare-input'))).toBe(true);
    expect(failures(mutate('<ol className="space-y-4">', '<ol style={{ margin: 0 }}>')).some((x) => x.startsWith('inline-style'))).toBe(true);
  });

  it('UI-NC-3: an error that is not rendered next to its button is caught (correction, upload, check)', () => {
    expect(failures(mutate('<ActionMessage message={msgs.correction ?? null} />', '')).some((x) => x.includes('area "correction"'))).toBe(true);
    expect(failures(mutate('<ActionMessage message={msgs.upload ?? null} />', '')).some((x) => x.includes('area "upload"'))).toBe(true);
    expect(failures(mutate('<ActionMessage message={msgs.check ?? null} />', '')).some((x) => x.includes('area "check"'))).toBe(true);
  });

  it('UI-NC-4: the per-item review and series Save results must render too', () => {
    expect(failures(mutate(/<ActionMessage message=\{msgs\[area\] \?\? null\} \/>/g, '')).some((x) => x.includes('review and series-switch'))).toBe(true);
  });

  it('UI-NC-5: the old button labels are caught (Preview (writes nothing), Commit N row(s))', () => {
    expect(failures(mutate('Check file (writes nothing)', 'Preview (writes nothing)')).some((x) => x.startsWith('label'))).toBe(true);
    expect(failures(mutate("{preview ? `Upload ${preview.willInsert} rows` : 'Upload rows'}", '{`Commit ${preview?.willInsert} row(s)`}')).length).toBeGreaterThan(0);
  });

  it('UI-NC-6: Upload enabled before the file is checked and the box ticked is caught', () => {
    expect(failures(mutate('disabled={busy || !preview || !preview.canCommit || !attested}', 'disabled={busy}')).some((x) => x.startsWith('upload-enabled-early'))).toBe(true);
  });

  it('UI-NC-7: something between the attestation and the Upload button is caught', () => {
    expect(failures(mutate("onChange={setAttested} />", "onChange={setAttested} /><Notice>x</Notice>")).some((x) => x.startsWith('attestation-order'))).toBe(true);
  });

  it('UI-NC-8: removing the page-top banner, or a step, or the date boundary conversion is caught', () => {
    expect(failures(mutate('data-testid="page-top-banner"', 'data-testid="x"')).some((x) => x.startsWith('banner-removed'))).toBe(true);
    expect(failures(mutate('title="Check the file"', 'title="Preview"')).some((x) => x.startsWith('step-missing'))).toBe(true);
    expect(failures(mutate('checkVerifiedThrough(verifiedThrough)', 'verifiedThrough')).some((x) => x.startsWith('date-boundary'))).toBe(true);
  });

  it('UI-NC-9: yyyy wording in the page code is caught', () => {
    expect(failures(mutate('label="Verified through (optional)"', 'label="Verified through (yyyy-mm-dd)"')).some((x) => x.startsWith('iso-wording'))).toBe(true);
  });

  it('UI-NC-10: the same checks catch a bare button in the other three screens', () => {
    for (const f of [MONITOR, REPORT_CLIENT, REPORT_VIEW]) {
      const src = read(f);
      expect(contractFailures(f, `${src}\nconst x = <button type="button">Save</button>;`).some((x) => x.startsWith('bare-button')), f).toBe(true);
    }
  });
});
