// Behavioural companions to the source contract (dateFormatsDayFirstSourceContract.test.ts): the
// message builders and helpers that put dates into SENTENCES must render them day-first -- dd-mm-yyyy
// for India, dd/mm/yyyy otherwise -- and never ISO year-first or a month name. PO rule (Document2
// findings #8/#19; canonical formatter lib/engines/date.ts).
import { describe, expect, it } from 'vitest';
import { dateFormatKeyForCountry, formatDateInText, formatDateShort } from '@/lib/engines/date';
import { formatIsoDateDMY } from '@/lib/engines/investment-intelligence/indiaMfReport';
import { narrativeDate } from '@/lib/engines/reportSectionsPremium';
import { valueHoldingAsOf, type NavObservationRow, type StatementPositionInput } from '@/lib/engines/investment-intelligence/valuation/currentHoldingValuation';
import { computeEntitlementReminder } from '@/lib/services/entitlementReminder';
import { describePlanStatus, formatIsoDate } from '@/lib/services/entitlementPlanStatus';
import { composeExpiryReminderEmail } from '@/lib/services/premiumExpiryReminderEmail';
import { fmtDate, fmtDateTime } from '@/components/investment-intelligence/dateDisplay';

const ISO = /(^|[^0-9])[0-9]{4}-[0-9]{2}-[0-9]{2}([^0-9]|$)/;

describe('formatDateInText / dateFormatKeyForCountry', () => {
  it('INR is dd-mm-yyyy, everything else dd/mm/yyyy; a missing currency uses the AU shape', () => {
    expect(formatDateInText('2026-10-01', 'INR')).toBe('01-10-2026');
    expect(formatDateInText('2026-10-01', 'inr')).toBe('01-10-2026');
    expect(formatDateInText('2026-10-01', 'AUD')).toBe('01/10/2026');
    expect(formatDateInText('2026-10-01', null)).toBe('01/10/2026');
    expect(formatDateInText('2026-10-01', undefined)).toBe('01/10/2026');
  });
  it('a timestamp keeps only its date part; text that is not a date passes through unchanged; empty is empty', () => {
    expect(formatDateInText('2026-10-01T09:05:33Z', 'INR')).toBe('01-10-2026');
    expect(formatDateInText('not available', 'INR')).toBe('not available');
    expect(formatDateInText('01-10-2026', 'INR')).toBe('01-10-2026');
    expect(formatDateInText(null, 'INR')).toBe('');
    expect(formatDateInText('', 'INR')).toBe('');
  });
  it('the country key: IN is India, any other (and an unresolved country) is the AU shape', () => {
    expect(dateFormatKeyForCountry('IN')).toBe('INR');
    expect(dateFormatKeyForCountry('AU')).toBe('AUD');
    expect(dateFormatKeyForCountry('GB')).toBe('AUD');
    expect(dateFormatKeyForCountry(null)).toBe('AUD');
    expect(dateFormatKeyForCountry(undefined)).toBe('AUD');
  });
});

describe('India MF report and report narratives', () => {
  it('formatIsoDateDMY is dd-mm-yyyy (12-12-2022), not dd-Mon-yyyy', () => {
    expect(formatIsoDateDMY('2022-12-12')).toBe('12-12-2022');
    expect(formatIsoDateDMY('2023-04-01')).toBe('01-04-2023');
    expect(formatIsoDateDMY('2022-12-12')).not.toMatch(/[A-Za-z]/);
    expect(formatIsoDateDMY('n/a')).toBe('n/a');
  });
  it('report narrative dates follow the reporting currency; the India section is always India-shaped', () => {
    expect(narrativeDate('2026-09-30', 'INR')).toBe('30-09-2026');
    expect(narrativeDate('2026-09-30', 'AUD')).toBe('30/09/2026');
    expect(narrativeDate('2026-09-30', undefined)).toBe('30/09/2026');
  });
});

describe('holding valuation notes (Holdings / Net Worth NAV tags) are day-first in the position currency', () => {
  const stmt = (asOfDate: string, units: number, value: number, currencyCode = 'INR'): StatementPositionInput => ({ asOfDate, units, value, currencyCode });
  const nav = (date: string, price: number, currencyCode = 'INR'): NavObservationRow => ({ date, price, currencyCode, qualityStatus: 'ok' });

  it('latest NAV newer than the statement, fresh and stale; statement-only; redeemed; unavailable', () => {
    const fresh = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-25', 120)], asOfDate: '2026-09-28' });
    expect(fresh.note).toBe('Valued at the latest NAV, dated 25-09-2026. The statement dated 30-06-2026 is superseded as the current NAV.');
    const stale = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000)], navs: [nav('2026-09-10', 120)], asOfDate: '2026-09-28' });
    expect(stale.note).toContain('Latest NAV on file is dated 10-09-2026, 18 days before 28-09-2026;');
    expect(stale.note).toContain('The statement dated 30-06-2026 is superseded.');
    const onlyStatement = valueHoldingAsOf({ statements: [stmt('2026-09-26', 100, 10000)], navs: [], asOfDate: '2026-09-28' });
    expect(onlyStatement.note).toBe('Value and NAV come from your statement dated 26-09-2026; no newer market NAV is on file.');
    const redeemed = valueHoldingAsOf({ statements: [stmt('2026-06-30', 0, 0)], navs: [], asOfDate: '2026-09-28' });
    expect(redeemed.note).toContain('Fully redeemed as at 30-06-2026 (0 units).');
    const none = valueHoldingAsOf({ statements: [stmt('2026-10-05', 100, 10000)], navs: [], asOfDate: '2026-09-28', pointInTime: true, currencyCode: 'INR' });
    expect(none.note).toBe('No certified statement valuation exists on or before 28-09-2026, so no value is shown.');
    for (const v of [fresh, stale, onlyStatement, redeemed, none]) expect(v.note, v.note).not.toMatch(ISO);
  });

  it('an AUD position is dd/mm/yyyy; the structured dates stay ISO for the API', () => {
    const v = valueHoldingAsOf({ statements: [stmt('2026-06-30', 100, 10000, 'AUD')], navs: [nav('2026-09-25', 120, 'AUD')], asOfDate: '2026-09-28' });
    expect(v.note).toContain('dated 25/09/2026');
    expect(v.note).toContain('statement dated 30/06/2026');
    expect(v.navDate).toBe('2026-09-25');
    expect(v.statementAsOfDate).toBe('2026-06-30');
  });

  it('unit movements after the statement: the latest transaction date is day-first too', () => {
    const v = valueHoldingAsOf({
      statements: [stmt('2026-06-30', 100, 10000)],
      navs: [nav('2026-09-25', 120)],
      asOfDate: '2026-09-28',
      unitMovements: [{ date: '2026-08-14', units: 10 }] as never,
    });
    expect(v.note).not.toMatch(ISO);
  });
});

describe('Premium access reminders, plan label and email follow the user\'s country', () => {
  const row = { plan_tier: 'premium', entitlement_source: 'admin_grant', effective_from: '2026-09-01', effective_to: '2026-10-12' } as const;

  it('in-app reminder (expiring, today=2026-10-05): AU dd/mm/yyyy, India dd-mm-yyyy, never ISO or a month name', () => {
    const au = computeEntitlementReminder(row, '2026-10-05');
    expect(au.message).toContain('ends on 12/10/2026.');
    const india = computeEntitlementReminder(row, '2026-10-05', 'IN');
    expect(india.message).toContain('ends on 12-10-2026.');
    for (const m of [au.message as string, india.message as string]) {
      expect(m).not.toMatch(ISO);
      expect(m).not.toMatch(/\b12 Oct/);
    }
  });
  it('lapsed reminder is day-first', () => {
    const lapsed = computeEntitlementReminder({ ...row, effective_to: '2026-10-01' }, '2026-10-05', 'IN');
    expect(lapsed.kind).toBe('lapsed');
    expect(lapsed.message).toContain('ended on 01-10-2026 and');
    expect(lapsed.message).not.toMatch(ISO);
  });
  it('the 30-day reminder is day-first and the notice KEY (internal) stays ISO so dismissals keep working', () => {
    const r = computeEntitlementReminder({ ...row, effective_to: '2026-10-25' }, '2026-10-05', 'IN');
    expect(r.kind).toBe('expiring_30');
    expect(r.message).toContain('ends on 25-10-2026.');
    expect(r.key).toBe('expiring_30:2026-10-25');
  });
  it('plan label (profile plan panel) is day-first per country; the API field stays ISO', () => {
    const p = describePlanStatus({ ...row, admin_grant_ends_on: '2026-10-12' }, '2026-10-05', 'IN');
    expect(p.label).toBe('Premium (granted by FHIP admin, ends 12-10-2026)');
    expect(p.grantEndsOn).toBe('2026-10-12');
    expect(describePlanStatus({ ...row, admin_grant_ends_on: '2026-10-12' }, '2026-10-05').label).toBe('Premium (granted by FHIP admin, ends 12/10/2026)');
    expect(formatIsoDate('2026-10-12')).toBe('12/10/2026');
    expect(formatIsoDate('2026-10-12', 'IN')).toBe('12-10-2026');
  });
  it('the reminder email uses the same format key', () => {
    const mail = composeExpiryReminderEmail({ endsOn: '2026-10-12', daysLeft: 7, country: 'IN', baseUrl: 'https://example.test' });
    expect(mail.subject).toContain('12-10-2026');
    expect(mail.text).toContain('12-10-2026');
    expect(mail.text).not.toMatch(ISO);
    const au = composeExpiryReminderEmail({ endsOn: '2026-10-12', daysLeft: 7, country: 'AU', baseUrl: 'https://example.test' });
    expect(au.subject).toContain('12/10/2026');
  });
});

describe('shared Investment Intelligence display helpers still behave (regression for the formatter every II screen uses)', () => {
  it('fmtDate and fmtDateTime are day-first per currency', () => {
    expect(fmtDate('2026-10-01', 'INR')).toBe('01-10-2026');
    expect(fmtDate('2026-10-01', 'AUD')).toBe('01/10/2026');
    expect(fmtDateTime('2026-10-01T09:05:33Z', 'INR')).toMatch(/^01-10-2026, /);
    expect(formatDateShort('2026-10-01', 'INR')).toBe('01-10-2026');
  });
});
