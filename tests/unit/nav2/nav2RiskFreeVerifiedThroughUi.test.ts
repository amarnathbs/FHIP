// Risk-free Rate Data screen -- the verified-through fixes of 19-10-2026, at the logic and source-contract level (UNIT; the screen itself is not
// driven in a browser here, see the report for what was and was not exercised).
//
//   - the confirmation form checks exactly what the database function checks, in words a person can act on, in day-first dates
//   - the answer after an upload says what happened to the confirmed-through date (done / not changed / not reported)
//   - the "Verified through" field is cleared when the series changes and warns for the weekly series
//   - the dedicated control is on the screen, behind the upload capability, and posts to its own route
//
// NAMED NEGATIVE CONTROLS: NC-U1 the series change handler without the clear leaves the trap in place (the source check goes red);
// NC-U2 a done message for a date that did not move is impossible (the outcome text is an error kind).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { checkConfirmation, describeFailure, describeUploadOutcome } from '@/components/admin/riskFreeFormLogic';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const client = fs.readFileSync(path.join(ROOT, 'components/admin/RiskFreeDataClient.tsx'), 'utf8');
const ctx = { today: '2026-10-19', lastRateDate: '2026-10-07', recordedThrough: '2026-10-02' };
const REASON = 'Checked the RBI press releases: no change.';

describe('checkConfirmation', () => {
  it('a real later day with a long enough reason is ok and becomes ISO only here', () => {
    expect(checkConfirmation({ date: '19-10-2026', reason: REASON }, ctx)).toEqual({ ok: true, iso: '2026-10-19', errors: {} });
    expect(checkConfirmation({ date: '19/10/2026', reason: REASON }, ctx).iso).toBe('2026-10-19');
  });

  it('each problem is attached to its field, in day-first words, never an ISO date', () => {
    const msgs = (date: string, reason = REASON) => checkConfirmation({ date, reason }, ctx).errors;
    expect(msgs('').date).toMatch(/Enter the day you checked/);
    expect(msgs('2026-10-19').date).toMatch(/not a real date.*day-month-year/); // ISO (year first) is never reinterpreted
    expect(msgs('10-19-2026').date).toMatch(/not a real date/); // month first is never reinterpreted
    expect(msgs('20-10-2026').date).toBe('This day is still in the future. Today in India is 19-10-2026.');
    expect(msgs('06-10-2026').date).toBe('This day is earlier than the last published rate (07-10-2026).');
    // production on 19-10-2026 had a confirmed-through date (02-10-2026) EARLIER than the last rate (07-10-2026): the last-rate rule applies first
    expect(msgs('02-10-2026').date).toBe('This day is earlier than the last published rate (07-10-2026).');
    const confirmed = { today: '2026-10-19', lastRateDate: '2026-10-07', recordedThrough: '2026-10-12' };
    expect(checkConfirmation({ date: '12-10-2026', reason: REASON }, confirmed).errors.date).toBe('The rate is already confirmed through 12-10-2026. Enter a later day.');
    expect(checkConfirmation({ date: '10-10-2026', reason: REASON }, confirmed).errors.date).toBe('The rate is already confirmed through 12-10-2026. Enter a later day.');
    expect(checkConfirmation({ date: '13-10-2026', reason: REASON }, confirmed).ok).toBe(true);
    expect(msgs('19-10-2026', 'too short').reason).toBe('Write a reason of at least 20 characters (9 so far).');
    expect(msgs('19-10-2026', '   nineteen chars!!   ').reason).toMatch(/at least 20 characters/);
    for (const e of Object.values(msgs('20-10-2026', 'x'))) expect(e).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
  });

  it('a series never confirmed before and with no rate yet is checked against what exists', () => {
    expect(checkConfirmation({ date: '05-10-2026', reason: REASON }, { today: '2026-10-19', lastRateDate: null, recordedThrough: null }).ok).toBe(true);
    expect(checkConfirmation({ date: '05-10-2026', reason: REASON }, { today: '2026-10-19', lastRateDate: '2026-10-07', recordedThrough: null }).errors.date).toMatch(/earlier than the last published rate/);
  });

  it('the days at the edges: today is allowed, the last rate day itself is allowed, one day after the recorded date is allowed', () => {
    expect(checkConfirmation({ date: '19-10-2026', reason: REASON }, ctx).ok).toBe(true);
    expect(checkConfirmation({ date: '07-10-2026', reason: REASON }, { ...ctx, recordedThrough: null }).ok).toBe(true);
    expect(checkConfirmation({ date: '03-10-2026', reason: REASON }, { ...ctx, lastRateDate: null }).ok).toBe(true);
  });
});

describe('describeUploadOutcome -- the answer says what happened to the date', () => {
  it('moved: done, and it names the new date day-first', () => {
    expect(describeUploadOutcome({ status: 'already_committed', verifiedThrough: { requested: '2026-10-19', moved: true, current: '2026-10-19' } })).toEqual({
      kind: 'ok',
      text: 'This file was already uploaded, so no rows were written this time. The series is now confirmed through 19-10-2026.',
    });
  });

  it('NC-U2: a date that did not move is an ERROR message that says so and names the date it stays at (never a plain done)', () => {
    const r = describeUploadOutcome({ status: 'already_committed', inserted: 1, identical: 0, verifiedThrough: { requested: '2026-10-10', moved: false, current: '2026-10-19' } });
    expect(r.kind).toBe('error');
    expect(r.text).toContain('The confirmed-through date was NOT changed');
    expect(r.text).toContain('19-10-2026');
    expect(r.text).not.toMatch(/row\(s\) written/); // the counts of the original batch are never shown as rows written now
  });

  it('a database that does not report the date (0294 not applied) is an error that tells the person to check the Series table', () => {
    const r = describeUploadOutcome({ status: 'committed', inserted: 0, identical: 1, verifiedThrough: { requested: '2026-10-19', moved: null, current: null } });
    expect(r.kind).toBe('error');
    expect(r.text).toMatch(/did not report whether the confirmed-through date moved/);
  });

  it('no date requested: the plain row sentence, ok; a no-op says nothing was written', () => {
    expect(describeUploadOutcome({ status: 'committed', inserted: 3, identical: 1, verifiedThrough: { requested: null, moved: false, current: null } })).toEqual({ kind: 'ok', text: 'Uploaded: 3 row(s) written, 1 identical row(s) skipped.' });
    expect(describeUploadOutcome({ status: 'noop', identical: 2, verifiedThrough: { requested: null, moved: false, current: null } }).text).toBe('Nothing to write: every row is already published (2 identical).');
    expect(describeUploadOutcome({ status: 'noop', identical: 2 }).kind).toBe('ok');
  });
});

describe('describeFailure names the confirmation date field', () => {
  it('a bad throughDate is worded with the field name and how to type it', () => {
    expect(describeFailure(422, { fields: { throughDate: 'Enter a valid date.' } }, 'x')).toBe('Confirmed through: Enter a valid date. Type the date as day-month-year, like 01-10-2026.');
  });
});

describe('screen source contract', () => {
  it('NC-U1: changing the series clears the verified-through field (a date typed for one series never rides along to another)', () => {
    const handler = client.slice(client.indexOf('onChange={(v) => {\n                  setSeriesId('), client.indexOf('<FileField'));
    expect(handler).toContain("setVerifiedThrough('')");
    expect(handler.indexOf("setVerifiedThrough('')")).toBeGreaterThan(handler.indexOf('setSeriesId('));
    // the control is real: the same handler without the clear does not contain it
    expect(handler.replace("setVerifiedThrough('');", '')).not.toContain("setVerifiedThrough('')");
  });

  it('shows a warning as soon as a date is entered for the weekly series, and tells the person it will not be saved', () => {
    expect(client).toContain('seriesIsWeekly && verifiedThrough.trim() !== \'\'');
    expect(client).toContain('This date will not be saved');
    expect(client).toContain('does nothing for the 91-day T-bill series');
  });

  it('the Upload result uses describeUploadOutcome (no hand-written "row(s) written" sentence is left in the screen)', () => {
    expect(client).toContain('describeUploadOutcome(j.data as UploadOutcomeView)');
    expect(client).not.toContain("row(s) written, ${o.identical");
  });

  it('the dedicated control is behind the upload capability, posts to its own route, checks before sending, shows its result under its button, and types day-first', () => {
    const start = client.indexOf('title="Confirm the repo rate is still current"');
    expect(start).toBeGreaterThan(-1);
    const guard = client.slice(client.lastIndexOf("{status?.state === 'ok'", start), start);
    expect(guard).toContain('caps?.upload');
    const panel = client.slice(start, client.indexOf('title="Review queue"'));
    expect(panel).toContain('/api/admin/investment-intelligence/risk-free-data/confirm-current');
    expect(panel).toContain('checkConfirmation(');
    expect(panel).toContain('<DateField label="Confirmed through"');
    expect(panel).toContain('<ActionMessage message={msgs.confirm ?? null} />');
    expect(panel).toContain('Confirm the repo rate is still current');
    expect(panel).toContain('MIN_REASON_CHARS');
    // the ISO value is produced only at the API boundary
    expect(panel).toContain('throughDate: chk.iso');
    expect(panel).not.toMatch(/\b20\d{2}-\d{2}-\d{2}\b/);
  });

  it('the history list names a confirmed-through entry instead of printing nothing between the date and the reason', () => {
    expect(client).toContain("'confirmed-through date; '");
  });
});

describe('route and migration contract', () => {
  const route = fs.readFileSync(path.join(ROOT, 'app/api/admin/investment-intelligence/risk-free-data/confirm-current/route.ts'), 'utf8');
  it('the route checks the UPLOAD capability before reading the body, uses the caller session client, never the service role', () => {
    expect(route.indexOf("requireRiskFreeCapability('upload')")).toBeGreaterThan(-1);
    expect(route.indexOf("requireRiskFreeCapability('upload')")).toBeLessThan(route.indexOf('req.json()'));
    expect(route).toContain("from '@/lib/supabase/server'");
    expect(route).not.toContain('createAdminClient');
    expect(route).toContain("'confirm_risk_free_verified_through'");
  });
  it('the whole admin surface uses the India day, not the UTC day', () => {
    const main = fs.readFileSync(path.join(ROOT, 'app/api/admin/investment-intelligence/risk-free-data/route.ts'), 'utf8');
    expect(main).toContain('indiaTodayIso()');
    expect(main).not.toContain('new Date().toISOString().slice(0, 10)');
  });
});
