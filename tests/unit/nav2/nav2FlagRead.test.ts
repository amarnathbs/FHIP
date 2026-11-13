// NAV2 -- the switch reader says WHY a switch reads off. Found 13-11-2026: on production the weekly refresh answered "the switch is off" while the row said
// enabled = true, because a failed read of the switch is reported as off (fail closed) and looked exactly like a switched-off job.
//
// NAMED NEGATIVE CONTROLS
//   NC-F1  a row that says on is on; a row that says off is off; no row is missing; none of them is called a failed read;
//   NC-F2  a database error, and a thrown error, are read_failed, still OFF (fail closed), with the code and a short message and nothing else;
//   NC-F3  isNav2FlagOn gives the same boolean as before for every one of those cases;
//   NC-F4  the refresh route puts the reason in its answer, and a failed read makes no request to RBI and writes nothing.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isNav2FlagOn, NAV2_JOB_KEYS, readNav2Flag } from '@/lib/services/investment-intelligence/nav2/nav2Flags';

const KEY = NAV2_JOB_KEYS.riskFreeWeeklyRefresh;
const clientWith = (result: { data: unknown; error: unknown } | 'throw'): SupabaseClient =>
  ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            if (result === 'throw') throw new Error('fetch failed');
            return result;
          },
        }),
      }),
    }),
  }) as unknown as SupabaseClient;

describe('readNav2Flag', () => {
  it('NC-F1: on, off and missing are told apart and none is a failed read', async () => {
    expect(await readNav2Flag(clientWith({ data: { enabled: true }, error: null }), KEY)).toEqual({ on: true, state: 'on' });
    expect(await readNav2Flag(clientWith({ data: { enabled: false }, error: null }), KEY)).toEqual({ on: false, state: 'off' });
    expect(await readNav2Flag(clientWith({ data: null, error: null }), KEY)).toEqual({ on: false, state: 'missing' });
    expect(await readNav2Flag(clientWith({ data: { enabled: 'true' }, error: null }), KEY)).toEqual({ on: false, state: 'off' }); // only a real true counts
  });

  it('NC-F2: a database error and a thrown error are read_failed, still OFF, with the code and a short message only', async () => {
    const e = await readNav2Flag(clientWith({ data: null, error: { code: 'PGRST301', message: `Project restricted ${'x'.repeat(500)}`, details: 'SECRET-DETAILS', hint: 'SECRET-HINT' } }), KEY);
    expect(e).toMatchObject({ on: false, state: 'read_failed', failure: { code: 'PGRST301' } });
    expect(e.failure?.message.length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(e)).not.toMatch(/SECRET/);
    expect(await readNav2Flag(clientWith('throw'), KEY)).toEqual({ on: false, state: 'read_failed', failure: { code: null, message: 'fetch failed' } });
  });

  it('NC-F2: even an error that arrives together with data never turns the switch on', async () => {
    expect((await readNav2Flag(clientWith({ data: { enabled: true }, error: { code: '500', message: 'boom' } }), KEY)).on).toBe(false);
  });

  it('NC-F3: isNav2FlagOn answers exactly as before in every case', async () => {
    expect(await isNav2FlagOn(clientWith({ data: { enabled: true }, error: null }), KEY)).toBe(true);
    expect(await isNav2FlagOn(clientWith({ data: { enabled: false }, error: null }), KEY)).toBe(false);
    expect(await isNav2FlagOn(clientWith({ data: null, error: null }), KEY)).toBe(false);
    expect(await isNav2FlagOn(clientWith({ data: null, error: { code: 'x', message: 'y' } }), KEY)).toBe(false);
    expect(await isNav2FlagOn(clientWith('throw'), KEY)).toBe(false);
  });
});

// ---- the route ---------------------------------------------------------------------------------------------------
const findAuctionListing = vi.fn();
const readNsdp = vi.fn();
let failRead: 'none' | 'error' = 'none';
const rpc = vi.fn(async () => ({ data: {}, error: null }));
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => (failRead === 'error' ? { data: null, error: { code: 'PGRST000', message: 'Project is restricted' } } : { data: table === 'ii_reference_job_control' ? { enabled: true } : null, error: null }),
        }),
      }),
    }),
    rpc,
  }),
}));
vi.mock('@/lib/services/investment-intelligence/nav2/rbiSource', async (orig) => {
  const actual = await orig<typeof import('@/lib/services/investment-intelligence/nav2/rbiSource')>();
  return { ...actual, createLiveRbiSource: () => ({ findAuctionRelease: vi.fn(), findAuctionListing, readReleasePage: vi.fn(), readNsdp, requestsMade: () => ({ pages: 0, robots: 0 }) }) };
});

import { POST } from '@/app/api/investment-intelligence/cron/nav2-risk-free-refresh/route';

describe('the refresh route says why the switch read as it did (NC-F4)', () => {
  const post = () => POST(new Request('http://t/cron', { method: 'POST', headers: { 'x-cron-secret': 'right-secret' }, body: JSON.stringify({ dryRun: false }) }));

  it('a failed read of the switch is labelled read_failed with the reason, makes no request to RBI and writes nothing', async () => {
    process.env.CRON_SECRET = 'right-secret';
    failRead = 'error';
    const res = await post();
    const data = (await res.json()).data;
    expect(data).toMatchObject({ mode: 'skipped_kill_switch', requests: { pages: 0, robots: 0 }, switchRead: { on: false, state: 'read_failed', failure: { code: 'PGRST000', message: 'Project is restricted' } } });
    expect(findAuctionListing).not.toHaveBeenCalled();
    expect(readNsdp).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    failRead = 'none';
  });
});
