/**
 * Document2 (4) F26 -- the Retirement Forecast reads the target retirement age already saved on the Retirement page.
 *
 * PO (20-10-2026): "I already entered the retirement age in the Retirement tab but the Retirement Forecast shows blank, asks
 * me to enter again. It should take the value from there."
 *
 * Evidence label: UNIT-TESTED. The real runForecast() and the real page loader run against the PostgREST-shaped fake; the pure
 * resolver is tested directly; the page card and the what-if control are rendered with react-dom/server.
 * Cases required by the brief: Self, Spouse, different ages, missing DOB, missing target, updated target, plus reload, what-if
 * not persisted, exact date precedence.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => {
    throw new Error('createClient() must not be called -- every test passes an explicit client.');
  },
}));
vi.mock('@/components/ui/DateInput', () => ({ DateInput: (p: { id?: string; value?: string }) => createElement('input', { id: p.id, defaultValue: p.value ?? '' }) }));
vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown }) => createElement('a', { href: p.href }, p.children as never) }));

import { loadRetirementTimingForPage, runForecast } from '@/lib/services/forecastData';
import { ageAtBaseline, describeMemberTiming, resolveRetirementTiming } from '@/lib/engines/forecast/retirementTiming';
import { RetirementTimingSettings } from '@/components/forecast/RetirementTimingSettings';
import { RetirementForecastPanel, retirementAgeSourceText } from '@/components/forecast/RetirementForecastPanel';
import { forecastRunRequestSchema } from '@/lib/validation/forecast';
import { makeFakeSupabase, type Row } from './readModels/helpers/fakeSupabase';
import { tables, USER } from './readModels/helpers/fixtures';

const PROFILE_ID = 'fp-1';
const SCENARIO_ID = 'sc-1';
const BASELINE = '2026-09-01';

function world(opts: { dob?: string | null; selfAge?: number | null; spouseAge?: number | null; spouseDob?: string | null; profile?: Row; extra?: Record<string, Row[]> } = {}) {
  const members: Row[] = [];
  if (opts.selfAge !== undefined) members.push({ id: 'm-self', user_id: USER, member_type: 'self', target_retirement_age: opts.selfAge, is_active: true });
  if (opts.spouseAge !== undefined) members.push({ id: 'm-spouse', user_id: USER, member_type: 'spouse', target_retirement_age: opts.spouseAge, is_active: true });
  return tables(
    {
      user_profiles: [{ user_id: USER, preferred_currency: 'AUD', country_of_residence: 'AU', date_of_birth: opts.dob === undefined ? '1975-09-01' : opts.dob }],
      household_members: opts.spouseDob ? [{ user_id: USER, relationship: 'spouse', date_of_birth: opts.spouseDob, is_active: true }] : [],
      retirement_members: members,
      forecast_profiles: [{
        id: PROFILE_ID, user_id: USER, status: 'active', name: 'My Forecast', base_currency: 'AUD', country_code: 'AU',
        forecast_start_date: BASELINE, retirement_age: null, retirement_date: null, retirement_timing_override_months: null, created_at: '2026-01-01T00:00:00Z',
        ...(opts.profile ?? {}),
      }],
      forecast_scenarios: [{ id: SCENARIO_ID, user_id: USER, forecast_profile_id: PROFILE_ID, scenario_name: 'Base scenario', scenario_type: 'base', is_default: true, is_active: true }],
      forecast_global_assumptions: [
        { country_code: null, assumption_category: 'fx', assumption_key: 'fx_rate_aud_inr', assumption_value: 56, value_type: 'number', unit: null, source_reference: null, is_active: true },
        { country_code: 'AU', assumption_category: 'retirement', assumption_key: 'retirement_age', assumption_value: 67, value_type: 'number', unit: 'years', source_reference: null, is_active: true },
      ],
    },
    opts.extra ?? {},
  );
}

function runClient(t: Record<string, Row[]>) {
  const fake = makeFakeSupabase(t);
  const explanations: Row[] = [];
  const runsBuilder = () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      insert: (row: Row) => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...row }, error: null }) }) }),
      update: (patch: Row) => ({
        eq: () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const p: any = Promise.resolve({ error: null });
          p.select = () => ({ single: () => Promise.resolve({ data: { id: 'run-1', ...patch }, error: null }) });
          return p;
        },
      }),
    };
    return b;
  };
  const client = {
    from(table: string) {
      if (table === 'forecast_runs') return runsBuilder();
      if (table === 'forecast_results') return { insert: () => Promise.resolve({ error: null }) };
      if (table === 'forecast_explanations') return { insert: (rows: Row[]) => { explanations.push(...rows); return Promise.resolve({ error: null }); } };
      return fake.client.from(table);
    },
  };
  return { client, explanations, tables: t };
}

async function run(t: Record<string, Row[]>, params: Record<string, unknown> = {}) {
  const { client, explanations } = runClient(t);
  await runForecast(USER, { scenarioId: SCENARIO_ID, forecastType: 'retirement', months: 12, ...params } as never, client as never);
  const inputs = (explanations[0]?.calculation_inputs ?? {}) as Record<string, unknown>;
  return { inputs, explanations };
}

describe('F26 pure resolver: which age is used and where it came from', () => {
  const base = { baselineDate: BASELINE, countryDefaultAge: 67 };

  it('Self: the saved target age is used, with its source', () => {
    const t = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 62, dateOfBirth: '1975-09-01' } });
    expect(t.self.retirementAge).toBe(62);
    expect(t.self.ageSource).toBe('saved');
    expect(t.self.currentAge).toBeCloseTo(51, 5);
    expect(t.self.monthsToTargetAge).toBe(132);
    expect(t.monthsUntilRetirement).toBe(132);
    expect(t.timingSource).toBe('age');
  });

  it('Spouse: a saved Spouse age and the Spouse date of birth give the Spouse their own months', () => {
    const t = resolveRetirementTiming({
      ...base,
      self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: '1975-09-01' },
      spouse: { memberType: 'spouse', savedTargetAge: 60, dateOfBirth: '1978-03-01' },
    });
    expect(t.spouse?.retirementAge).toBe(60);
    expect(t.spouse?.ageSource).toBe('saved');
    expect(t.spouse?.monthsToTargetAge).toBe(Math.round((60 - (2026 - 1978 + (8 - 2) / 12)) * 12));
    // The household projection stays on Self.
    expect(t.self.retirementAge).toBe(67);
  });

  it('different ages for Self and Spouse are kept apart', () => {
    const t = resolveRetirementTiming({
      ...base,
      self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: '1975-09-01' },
      spouse: { memberType: 'spouse', savedTargetAge: 62, dateOfBirth: null },
    });
    expect([t.self.retirementAge, t.spouse?.retirementAge]).toEqual([67, 62]);
    expect(t.spouse?.monthsToTargetAge).toBeNull();
  });

  it('missing date of birth: the age is still reported, the time left is not invented, and the manual months fallback applies', () => {
    const t = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: null }, manualMonths: 180 });
    expect(t.self.retirementAge).toBe(67);
    expect(t.self.currentAge).toBeNull();
    expect(t.self.monthsToTargetAge).toBeNull();
    expect(t.timingSource).toBe('manual_months');
    expect(t.monthsUntilRetirement).toBe(180);
    const none = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: null } });
    expect(none.monthsUntilRetirement).toBeNull();
    expect(none.timingSource).toBe('unknown');
  });

  it('missing target: Self falls back to the country default and SAYS so; Spouse gets no made-up age', () => {
    const t = resolveRetirementTiming({
      ...base,
      self: { memberType: 'self', savedTargetAge: null, dateOfBirth: '1975-09-01' },
      spouse: { memberType: 'spouse', savedTargetAge: null, dateOfBirth: '1978-03-01' },
    });
    expect(t.self.retirementAge).toBe(67);
    expect(t.self.ageSource).toBe('country_default');
    expect(t.spouse?.retirementAge).toBeNull();
    expect(t.spouse?.ageSource).toBe('missing');
    expect(describeMemberTiming(t.self)).toMatch(/standard age for your country.*Retirement page/);
    expect(describeMemberTiming(t.spouse!)).toMatch(/no target retirement age is saved/);
  });

  it('the legacy Forecast-settings age is used only when nothing is saved, and the saved age always wins', () => {
    const legacyOnly = resolveRetirementTiming({ ...base, legacyProfileAge: 63, self: { memberType: 'self', savedTargetAge: null, dateOfBirth: '1975-09-01' } });
    expect([legacyOnly.self.retirementAge, legacyOnly.self.ageSource]).toEqual([63, 'legacy_profile']);
    const both = resolveRetirementTiming({ ...base, legacyProfileAge: 63, self: { memberType: 'self', savedTargetAge: 60, dateOfBirth: '1975-09-01' } });
    expect([both.self.retirementAge, both.self.ageSource]).toEqual([60, 'saved']);
  });

  it('updated target: changing the saved age changes the result; a what-if age wins for the run and leaves the saved age visible', () => {
    const before = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: '1975-09-01' } });
    const after = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 60, dateOfBirth: '1975-09-01' } });
    expect(before.monthsUntilRetirement).toBe(192);
    expect(after.monthsUntilRetirement).toBe(108);
    const whatIf = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: '1975-09-01', whatIfAge: 55 } });
    expect([whatIf.self.retirementAge, whatIf.self.ageSource, whatIf.self.savedTargetAge]).toEqual([55, 'what_if', 67]);
  });

  it('an exact retirement date outranks the age (as the forecast always did) and the page can say so', () => {
    const t = resolveRetirementTiming({ ...base, self: { memberType: 'self', savedTargetAge: 67, dateOfBirth: '1975-09-01' }, exactRetirementDate: '2036-09-01' });
    expect(t.timingSource).toBe('exact_date');
    expect(t.monthsUntilRetirement).toBe(120);
  });

  it('an implausible date of birth is treated as missing, not used', () => {
    expect(ageAtBaseline('2026-01-01', BASELINE)).toBeNull();
    expect(ageAtBaseline('not-a-date', BASELINE)).toBeNull();
  });
});

describe('F26 the real run uses the saved age (black box through runForecast)', () => {
  it('Self saved 67, born 1975-09-01: the run reports age 67, source saved, 192 months', async () => {
    const { inputs } = await run(world({ selfAge: 67 }));
    expect(inputs.retirementAge).toBe(67);
    expect(inputs.retirementAgeSource).toBe('saved');
    expect(inputs.monthsUntilRetirement).toBe(192);
  });

  it('[NC] a changed saved age is reflected on the next run (reload) -- no stale value, no second entry', async () => {
    const a = await run(world({ selfAge: 67 }));
    const b = await run(world({ selfAge: 60 }));
    expect(a.inputs.monthsUntilRetirement).toBe(192);
    expect(b.inputs.monthsUntilRetirement).toBe(108);
    expect(b.inputs.retirementAge).toBe(60);
  });

  it('missing target: the run says it used the country default, not a saved age', async () => {
    const { inputs } = await run(world({}));
    expect(inputs.retirementAgeSource).toBe('country_default');
    expect(inputs.retirementAge).toBe(67);
  });

  it('missing date of birth: no months are invented for the household projection', async () => {
    const { inputs } = await run(world({ selfAge: 67, dob: null }));
    expect(inputs.retirementAge).toBe(67);
    expect(inputs.monthsUntilRetirement).toBeNull();
  });

  it('what-if age applies to the run only and writes NOTHING to retirement_members or the forecast profile', async () => {
    const t = world({ selfAge: 67 });
    const snapshot = JSON.stringify([t.retirement_members, t.forecast_profiles]);
    const { inputs } = await run(t, { whatIfRetirementAges: { self: 55 } });
    expect(inputs.retirementAge).toBe(55);
    expect(inputs.retirementAgeSource).toBe('what_if');
    expect(inputs.monthsUntilRetirement).toBe(48);
    expect(JSON.stringify([t.retirement_members, t.forecast_profiles])).toBe(snapshot);
    // and the next run without a what-if is back on the saved age
    const next = await run(t);
    expect(next.inputs.retirementAge).toBe(67);
  });

  it('Self and Spouse with different saved ages are projected on their own ages (Spouse date of birth is read)', async () => {
    const t = world({
      selfAge: 67, spouseAge: 60, spouseDob: '1978-09-01',
      extra: {
        retirement_accounts: [
          { id: 'r-s', user_id: USER, account_name: 'Self super', account_type: 'super', current_balance: 100000, currency_code: 'AUD', owner: 'self', employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, is_active: true },
          { id: 'r-p', user_id: USER, account_name: 'Spouse super', account_type: 'super', current_balance: 50000, currency_code: 'AUD', owner: 'spouse', employer_contribution: 0, personal_contribution: 0, contribution_frequency: 'monthly', source_type: 'manual', retirement_member_id: null, is_active: true },
        ],
      },
    });
    const { inputs } = await run(t);
    const members = inputs.members as Array<{ label: string; retirementAge: number; monthsUntilRetirement: number | null }>;
    expect(members.map((m) => [m.label, m.retirementAge])).toEqual([['Self', 67], ['Spouse/Partner', 60]]);
    // Spouse born 1978-09-01 is 48 at the baseline: 12 years = 144 months to 60.
    expect(members[1].monthsUntilRetirement).toBe(144);
  });
});

describe('F26 the Forecast page states the saved age (loader + card)', () => {
  it('the page loader returns the saved Self and Spouse ages and the sources', async () => {
    const t = world({ selfAge: 67, spouseAge: 62, spouseDob: '1978-09-01' });
    const timing = await loadRetirementTimingForPage(USER, SCENARIO_ID, makeFakeSupabase(t).client as never);
    expect(timing.self.retirementAge).toBe(67);
    expect(timing.self.ageSource).toBe('saved');
    expect(timing.spouse?.retirementAge).toBe(62);
  });

  it('the card tells the person the age is already known, shows it, links to the Retirement page, and does not offer the months fallback when a date of birth exists', async () => {
    const t = world({ selfAge: 67 });
    const timing = await loadRetirementTimingForPage(USER, SCENARIO_ID, makeFakeSupabase(t).client as never);
    const html = renderToStaticMarkup(createElement(RetirementTimingSettings, { initialRetirementDate: null, initialOverrideMonths: null, timing }));
    expect(html).toContain('read from the Retirement page');
    expect(html).toContain('You do not need to enter it again');
    expect(html).toContain('Self: target retirement age 67 (saved on the Retirement page).');
    expect(html).toContain('href="/retirement"');
    expect(html).not.toContain('Months until retirement');
    // the old blank-looking wording is gone
    expect(html).not.toContain('Retirement date (optional, most precise)');
  });

  it('[NC] with no date of birth the months fallback is offered and the reason is named', async () => {
    const t = world({ selfAge: 67, dob: null });
    const timing = await loadRetirementTimingForPage(USER, SCENARIO_ID, makeFakeSupabase(t).client as never);
    const html = renderToStaticMarkup(createElement(RetirementTimingSettings, { initialRetirementDate: null, initialOverrideMonths: null, timing }));
    expect(html).toContain('Months until retirement');
    expect(html).toContain('no date of birth is on file');
    expect(html).toContain('No date of birth is on file, so the time left cannot be worked out.');
  });

  it('an exact date that overrides the age is announced, never silent', async () => {
    const t = world({ selfAge: 67, profile: { retirement_date: '2036-09-01' } });
    const timing = await loadRetirementTimingForPage(USER, SCENARIO_ID, makeFakeSupabase(t).client as never);
    const html = renderToStaticMarkup(createElement(RetirementTimingSettings, { initialRetirementDate: '2036-09-01', initialOverrideMonths: null, timing }));
    expect(html).toContain('uses that date instead of the target age');
  });

  it('the what-if control is labelled "this run only, not saved" and shows the saved ages beside it', () => {
    const html = renderToStaticMarkup(createElement(RetirementForecastPanel, { currency: 'AUD', currentBalance: 1, scenarioId: SCENARIO_ID, savedAges: { self: 67, spouse: 62 } }));
    expect(html).toContain('What-if retirement age (this run only, not saved)');
    expect(html).toContain('Self (saved: 67)');
    expect(html).toContain('Spouse/Partner (saved: 62)');
    const noSpouse = renderToStaticMarkup(createElement(RetirementForecastPanel, { currency: 'AUD', currentBalance: 1, savedAges: { self: null } }));
    expect(noSpouse).toContain('Self (saved: none)');
    expect(noSpouse).not.toContain('Spouse/Partner (saved');
  });

  it('source wording never leaks an internal key', () => {
    for (const s of ['saved', 'what_if', 'legacy_profile', 'country_default', null]) {
      expect(retirementAgeSourceText(s)).not.toMatch(/_|undefined/);
    }
  });

  it('the run request accepts a what-if age only as an integer 1-119', () => {
    const ok = forecastRunRequestSchema.safeParse({ forecast_type: 'retirement', retirement_what_if_age_self: 60 });
    expect(ok.success).toBe(true);
    expect(forecastRunRequestSchema.safeParse({ forecast_type: 'retirement', retirement_what_if_age_self: 0 }).success).toBe(false);
    expect(forecastRunRequestSchema.safeParse({ forecast_type: 'retirement', retirement_what_if_age_spouse: 150 }).success).toBe(false);
  });
});
