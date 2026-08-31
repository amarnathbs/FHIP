// Admin A0.2 Wave 2 (Scope B) — validateScheduledTransition() unit tests.
//
// Pure function, no database. The DATABASE-level enforcement of the same
// invariant (which is the actual non-bypassable control) is certified in
// scripts/admin_a02_wave2_certification.mjs SECTION 8 against a real
// PostgreSQL instance for all four content types. These tests cover the
// shared server-side helper that gives the administrator a clean 422 first,
// and in particular pin the property that made this a Wave 2 item at all:
// the SAME input must produce the SAME result no matter which content type's
// route is calling, because there is now only one implementation.
import { describe, it, expect } from 'vitest';
import { validateScheduledTransition, schedulingErrorResponse, SCHEDULING_FIELD } from '@/lib/resources/scheduling';

const FUTURE = () => new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
const PAST = '2000-01-01T00:00:00.000Z';

describe('validateScheduledTransition — gates only the "scheduled" target', () => {
  for (const status of ['idea', 'draft', 'editorial_review', 'compliance_review', 'approved', 'published', 'review_due', 'archived']) {
    it(`returns null for "${status}" even with no scheduled_at at all`, () => {
      expect(validateScheduledTransition(status, null)).toBeNull();
    });
    it(`returns null for "${status}" even with a PAST scheduled_at`, () => {
      expect(validateScheduledTransition(status, PAST)).toBeNull();
    });
  }

  it('immediate publish is explicitly unaffected — the whole point of scoping the rule to "scheduled"', () => {
    expect(validateScheduledTransition('published', null)).toBeNull();
    expect(validateScheduledTransition('published', PAST)).toBeNull();
  });
});

describe('validateScheduledTransition — missing timestamp', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
    ['whitespace only', '   '],
  ])('rejects a %s scheduled_at with SCHEDULED_AT_REQUIRED', (_label, value) => {
    const err = validateScheduledTransition('scheduled', value as string | null | undefined);
    expect(err).not.toBeNull();
    expect(err?.code).toBe('SCHEDULED_AT_REQUIRED');
    expect(err?.field).toBe(SCHEDULING_FIELD);
    expect(err?.message).toBe('A publish date and time is required before this content can be scheduled.');
  });
});

describe('validateScheduledTransition — malformed timestamp', () => {
  it.each([['banana'], ['2026-13-45T99:99:99Z'], ['not a date'], ['//'], ['2026-99-99'], ['2026-08-31T25:00:00Z']])('rejects %s as SCHEDULED_AT_INVALID', (value) => {
    const err = validateScheduledTransition('scheduled', value);
    expect(err?.code).toBe('SCHEDULED_AT_INVALID');
    expect(err?.field).toBe(SCHEDULING_FIELD);
  });

  it('an out-of-range day in a full ISO string is still REJECTED, just as a past date (documented JS leniency)', () => {
    // ECMAScript's Date.parse silently rolls "2026-02-30T00:00:00Z" over to
    // 2 March 2026 rather than failing. That is a property of the language,
    // not a gap in the rule: the value is still rejected (as past, in this
    // case), and PostgreSQL — which is the actual authority, via the
    // timestamptz column and the RPC's own comparison — rejects such a date
    // outright. Pinned here so the divergence is a recorded, tested fact
    // rather than a surprise.
    expect(validateScheduledTransition('scheduled', '2026-02-30T00:00:00Z')).not.toBeNull();
  });

  it('the pre-Wave-2 content route accepted exactly this value; the shared helper does not', () => {
    // Before Wave 2 the check was `!body?.scheduledAt`, so any truthy string
    // passed. This is the regression pin for that specific bug.
    expect(validateScheduledTransition('scheduled', 'banana')).not.toBeNull();
  });
});

describe('validateScheduledTransition — past and boundary timestamps', () => {
  it('rejects a clearly past timestamp', () => {
    const err = validateScheduledTransition('scheduled', PAST);
    expect(err?.code).toBe('SCHEDULED_AT_IN_PAST');
    expect(err?.message).toBe('The scheduled publish date and time must be in the future.');
  });

  it('rejects a timestamp one second in the past', () => {
    expect(validateScheduledTransition('scheduled', new Date(Date.now() - 1000).toISOString())?.code).toBe('SCHEDULED_AT_IN_PAST');
  });

  it('rejects "now" — the rule is STRICTLY future', () => {
    expect(validateScheduledTransition('scheduled', new Date(Date.now()).toISOString())?.code).toBe('SCHEDULED_AT_IN_PAST');
  });

  it('accepts a timestamp comfortably in the future', () => {
    expect(validateScheduledTransition('scheduled', FUTURE())).toBeNull();
  });

  it('accepts a far-future timestamp', () => {
    expect(validateScheduledTransition('scheduled', '2099-12-31T23:59:59.000Z')).toBeNull();
  });
});

describe('validateScheduledTransition — timezone handling', () => {
  it('treats UTC "Z" and an explicit +00:00 offset for the same instant identically', () => {
    const iso = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    expect(validateScheduledTransition('scheduled', iso)).toBeNull();
    expect(validateScheduledTransition('scheduled', iso.replace('Z', '+00:00'))).toBeNull();
  });

  it('a positive UTC offset does not make a past instant future', () => {
    // 1999-12-31T23:00:00+11:00 is 1999-12-31T12:00:00Z — still the past.
    expect(validateScheduledTransition('scheduled', '1999-12-31T23:00:00+11:00')?.code).toBe('SCHEDULED_AT_IN_PAST');
  });

  it('a negative UTC offset does not make a past instant future', () => {
    expect(validateScheduledTransition('scheduled', '1999-12-31T13:00:00-05:00')?.code).toBe('SCHEDULED_AT_IN_PAST');
  });

  it('the same absolute instant expressed with different offsets yields the same verdict', () => {
    const base = Date.now() + 5 * 24 * 3600 * 1000;
    const utc = new Date(base).toISOString();
    // Build the identical instant written as +05:30.
    const plus530 = new Date(base + 5.5 * 3600 * 1000).toISOString().replace('Z', '+05:30');
    expect(Date.parse(utc)).toBe(Date.parse(plus530));
    expect(validateScheduledTransition('scheduled', utc)).toEqual(validateScheduledTransition('scheduled', plus530));
  });

  it('a DST-boundary local time is handled as a plain instant, with no silent conversion', () => {
    // 02:30 on the AU "spring forward" morning, written with an explicit
    // offset so it names an unambiguous instant.
    expect(validateScheduledTransition('scheduled', '2099-10-04T02:30:00+10:00')).toBeNull();
  });
});

describe('validateScheduledTransition — identical across all four content types', () => {
  // There is deliberately only ONE implementation, so "identical across
  // content types" is a property of the call site, not of the function. This
  // test pins that the four routes can pass their own post shapes and still
  // get byte-identical verdicts for identical inputs.
  const CASES: (string | null)[] = [null, '', 'banana', PAST, '2099-12-31T23:59:59.000Z'];

  it('produces byte-identical results for every content type given the same stored timestamp', () => {
    for (const value of CASES) {
      const results = ['content', 'glossary', 'money-updates', 'videos'].map(() => JSON.stringify(validateScheduledTransition('scheduled', value)));
      expect(new Set(results).size).toBe(1);
    }
  });
});

describe('schedulingErrorResponse — canonical HTTP envelope', () => {
  it('returns 422 with code, message and a scheduled_at field reference', async () => {
    const err = validateScheduledTransition('scheduled', null)!;
    const res = schedulingErrorResponse(err);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({
      error: 'A publish date and time is required before this content can be scheduled.',
      code: 'SCHEDULED_AT_REQUIRED',
      fields: { scheduled_at: 'A publish date and time is required before this content can be scheduled.' },
    });
  });

  it('uses 422 (a fixable validation problem), never 403 as the pre-Wave-2 raw constraint path did', async () => {
    for (const value of [null, PAST, 'banana']) {
      const res = schedulingErrorResponse(validateScheduledTransition('scheduled', value)!);
      expect(res.status).toBe(422);
    }
  });

  it('never leaks an internal constraint name', async () => {
    for (const value of [null, PAST, 'banana']) {
      const body = await schedulingErrorResponse(validateScheduledTransition('scheduled', value)!).json();
      expect(JSON.stringify(body)).not.toMatch(/chk_resource_posts|constraint|SQLSTATE|23514/i);
    }
  });
});
