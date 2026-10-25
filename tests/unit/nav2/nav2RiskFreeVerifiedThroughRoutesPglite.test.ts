// Risk-free Rate Data -- the click-path of 19-10-2026, END TO END: the real API routes -> the real services -> the real migration SQL in an
// in-process Postgres (PGlite), as the `authenticated` role. Only the HTTP hop to PostgREST and the login are replaced.
//
// EVIDENCE LABEL: PGLITE. Not DEV, not production.
//
// What it proves, through the same entry points the screen calls:
//   1. the PO's sequence on the repo series (history with 02-10-2026, the 07-10-2026 rate, then the same file again with TODAY typed) moves the
//      date AND the answer says so (verifiedThrough.moved), including the "India day is ahead of the UTC day" shape;
//   2. a date that cannot move the series is reported as NOT moved, never as a plain success;
//   3. a date typed for the T-bill series is not stored;
//   4. the dedicated confirmation route: allowed for the upload capability only, forward only, audit row, and the sentence of a refusal reaches the
//      caller (422), a switch-only caller is refused (403) and nothing changes.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { countryRegistryFrom } from '../support/countryRegistryFake';
import { RISK_FREE_ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';
import { indiaTodayIso } from '@/lib/services/investment-intelligence/nav2/riskFreeToday';
import { createRiskFreeDb, one, pgliteClient, U } from './support/riskFreePgliteHarness';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const state: { db: PGlite | null; uid: string | null } = { db: null, uid: null };
vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => { throw new Error('the service-role client must not be used by the risk-free admin surface'); } }));
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const real = pgliteClient(state.db as PGlite, state.uid);
    return {
      auth: { getUser: async () => ({ data: { user: state.uid ? { id: state.uid } : null } }) },
      rpc: real.rpc.bind(real),
      from: (table: string) => {
        const registry = countryRegistryFrom(table);
        if (registry) return registry;
        if (table === 'user_profiles') return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_of_residence: 'IN', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true }, error: null }) }) }) };
        return real.from(table);
      },
    };
  },
}));

import { POST } from '@/app/api/admin/investment-intelligence/risk-free-data/route';
import { GET } from '@/app/api/admin/investment-intelligence/risk-free-data/route';
import { POST as confirmPOST } from '@/app/api/admin/investment-intelligence/risk-free-data/confirm-current/route';

const REPO = 'RBI_POLICY_REPO_RATE';
const TBILL = 'RBI_91D_TBILL_CUTOFF_YIELD';
const HEAD = 'series_id,observation_date,value_percent,frequency,source_document,source_url,retrieved_on,notes';
const row = (series: string, d: string, v: string, retrieved: string, notes = '') => `${series},${d},${v},${series === REPO ? 'policy_change' : 'weekly_auction'},"SYNTHETIC fixture",,${retrieved},${notes}`;
const csv = (...lines: string[]) => [HEAD, ...lines].join('\n') + '\n';
const HISTORY = csv(row(REPO, '2025-12-05', '5.25', '2026-10-01'));
const UPDATE = csv(row(REPO, '2026-10-07', '5.50', '2026-10-08'));
const TBILL_FILE = csv(row(TBILL, '2026-09-30', '5.5199', '2026-10-03'));
const TODAY = indiaTodayIso();

const req = (body: unknown) => new Request('http://test/api', { method: 'POST', body: JSON.stringify(body) });
const upload = (action: 'preview' | 'commit', seriesId: string, csvText: string, verifiedThrough: string | null, extra: Record<string, unknown> = {}) =>
  POST(req({ action, seriesId, fileName: 'f.csv', csvText, verifiedThrough, ...(action === 'commit' ? { attested: true, attestationText: RISK_FREE_ATTESTATION_TEXT } : {}), ...extra }));
const through = async (series = REPO) => (await one<{ v: string | null }>(state.db as PGlite, `select to_char(verified_through_date, 'YYYY-MM-DD') v from ii_risk_free_series where series_id = '${series}'`)).v;

let template: PGlite;
beforeAll(async () => {
  template = await createRiskFreeDb(['0260_nav2_risk_free_governed_dataset.sql', '0294_nav2_risk_free_confirm_verified_through.sql']);
}, 180_000);
afterAll(async () => {
  await template.close();
});
async function fresh(uid: string | null = U.upload) {
  if (state.db) await state.db.close();
  state.db = (await template.clone()) as PGlite;
  state.uid = uid;
}

describe('the click-path of 19-10-2026 through the real routes', () => {
  it('history with 02-10-2026, the 07-10-2026 rate, then the same file again with TODAY: preview is clean, the commit moves the date and SAYS so', async () => {
    await fresh();
    expect((await upload('commit', REPO, HISTORY, '2026-10-02', { firstLoad: true })).status).toBe(200);
    expect((await upload('commit', REPO, UPDATE, null)).status).toBe(200);
    expect(await through()).toBe('2026-10-02');

    const prev = await (await upload('preview', REPO, UPDATE, TODAY)).json();
    expect(prev.data).toMatchObject({ willInsert: 0, identicalToPublished: 1, canCommit: true, blockers: [] });
    const res = await upload('commit', REPO, UPDATE, TODAY, { expectedSha256: prev.data.fileSha256 });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: 'already_committed', verifiedThrough: { requested: TODAY, moved: true, current: TODAY } });
    expect(await through()).toBe(TODAY);
  });

  it('a date that cannot move the series is reported as NOT moved (the screen shows it as an error, not as done)', async () => {
    await fresh();
    await upload('commit', REPO, HISTORY, '2026-10-02');
    await upload('commit', REPO, UPDATE, TODAY);
    const res = await upload('commit', REPO, UPDATE, '2026-10-10'); // earlier than the recorded TODAY
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ status: 'already_committed', verifiedThrough: { requested: '2026-10-10', moved: false, current: TODAY } });
    expect(await through()).toBe(TODAY);
  });

  it('a day after the India day is refused in the preview with the India day named, and the commit is refused (422) before the database is called', async () => {
    await fresh();
    await upload('commit', REPO, HISTORY, '2026-10-02');
    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const prev = (await (await upload('preview', REPO, UPDATE, tomorrow)).json()).data;
    expect(prev.canCommit).toBe(false);
    expect(prev.blockers.join(' ')).toMatch(/cannot be in the future \(today in India is \d{2}-\d{2}-\d{4}\)/);
    expect((await upload('commit', REPO, UPDATE, tomorrow)).status).toBe(422);
    expect(await through()).toBe('2026-10-02');
  });

  it('a date typed for the T-bill series is dropped with a warning and never stored; re-submitting a T-bill file with a date is a plain no-op', async () => {
    await fresh();
    const prev = (await (await upload('preview', TBILL, TBILL_FILE, '2026-10-02')).json()).data;
    expect(prev.warnings.join(' ')).toMatch(/does nothing for a weekly series and will not be saved/);
    expect(prev.canCommit).toBe(true);
    expect((await upload('commit', TBILL, TBILL_FILE, '2026-10-02')).status).toBe(200);
    expect(await through(TBILL)).toBeNull();
    const again = await (await upload('commit', TBILL, TBILL_FILE, '2026-10-02')).json();
    expect(again.data).toMatchObject({ status: 'noop' });
  });

  it('the status read reports the India day (asOfDate), which the confirmation panel uses', async () => {
    await fresh();
    const body = (await (await GET()).json()).data;
    expect(body.asOfDate).toBe(TODAY);
  });
});

describe('the dedicated confirmation route through the real database function', () => {
  const ok = (over: Record<string, unknown> = {}) => ({ seriesId: REPO, throughDate: TODAY, reason: 'Checked the RBI press releases up to today: no change.', ...over });

  async function seeded(uid: string | null = U.upload) {
    await fresh(U.upload);
    await upload('commit', REPO, HISTORY, '2026-10-02');
    await upload('commit', REPO, UPDATE, null);
    state.uid = uid;
  }

  it('the upload-capability holder confirms: 200, the date moves, one audit row names the actor and both dates, no rate row changes', async () => {
    await seeded();
    const obs = (await (state.db as PGlite).query('select * from ii_risk_free_observations order by observation_date')).rows;
    const res = await confirmPOST(req(ok()));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ series_id: REPO, previous: '2026-10-02', new: TODAY });
    expect(await through()).toBe(TODAY);
    expect((await (state.db as PGlite).query('select * from ii_risk_free_observations order by observation_date')).rows).toEqual(obs);
    const log = (await (state.db as PGlite).query<{ reason: string; actor_user_id: string }>('select reason, actor_user_id from ii_risk_free_series_state_log')).rows;
    expect(log).toHaveLength(1);
    expect(log[0].actor_user_id).toBe(U.upload);
    expect(log[0].reason).toMatch(/^Confirmed still current through \d{2}-\d{2}-\d{4} \(was 02-10-2026\)\. Reason: Checked the RBI press releases/);
  });

  it('the same day again is a 422 with the sentence (never a silent 200); nothing changes', async () => {
    await seeded();
    expect((await confirmPOST(req(ok()))).status).toBe(200);
    const again = await confirmPOST(req(ok()));
    expect(again.status).toBe(422);
    expect((await again.json()).error).toMatch(/already confirmed through \d{2}-\d{2}-\d{4}, a confirmation must be later than that/);
    expect((await (state.db as PGlite).query('select 1 from ii_risk_free_series_state_log')).rows).toHaveLength(1);
  });

  it('a future day, the T-bill series and a day before the last rate are refused with their own sentences', async () => {
    await seeded();
    const tomorrow = new Date(Date.parse(`${TODAY}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const future = await confirmPOST(req(ok({ throughDate: tomorrow })));
    expect(future.status).toBe(422);
    expect((await future.json()).error).toMatch(/the date cannot be in the future, today in India is \d{2}-\d{2}-\d{4}/);
    const weekly = await confirmPOST(req(ok({ seriesId: TBILL })));
    expect(weekly.status).toBe(422);
    expect((await weekly.json()).error).toMatch(/only a policy-change series/);
    const early = await confirmPOST(req(ok({ throughDate: '2026-10-06' })));
    expect(early.status).toBe(422);
    expect((await early.json()).error).toMatch(/earlier than the last published rate \(07-10-2026\)/);
    expect(await through()).toBe('2026-10-02');
  });

  it('a switch-only holder, an admin without the capability and an ordinary user are refused (403 or 401), and nothing changes', async () => {
    for (const [who, uid, status] of [['switch-only', U.switchOnly, 403], ['no capability', U.noCapability, 403], ['ordinary user', U.plainUser, 403], ['no login', null, 401]] as const) {
      await seeded(uid);
      expect((await confirmPOST(req(ok()))).status, who).toBe(status);
      expect(await through(), who).toBe('2026-10-02');
      expect((await (state.db as PGlite).query('select 1 from ii_risk_free_series_state_log')).rows, who).toHaveLength(0);
    }
  });

  it('deploy order: the new route against a database that does not have 0294 yet answers 503 naming the migration, and changes nothing', async () => {
    const old = await createRiskFreeDb(['0260_nav2_risk_free_governed_dataset.sql']);
    if (state.db) await state.db.close();
    state.db = old;
    state.uid = U.upload;
    const res = await confirmPOST(req(ok()));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain('migration 0294');
  });
});
