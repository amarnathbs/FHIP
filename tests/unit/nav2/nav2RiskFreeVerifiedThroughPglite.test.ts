// Risk-free rate data -- the "verified through" date of a policy-change series (the RBI repo rate), 19-10-2026.
//
// PRODUCTION OBSERVATION (Product Owner, 19-10-2026): the repo rate file was submitted again with "Verified through" typed as 19-10-2026 and
// ii_risk_free_series.verified_through_date stayed at 02-10-2026.
//
// EVIDENCE LABEL: PGLITE. The REAL service functions (planRiskFreeUpload / commitRiskFreeUpload) call the REAL migration SQL in an in-process
// Postgres, as the `authenticated` role with auth.uid() set (tests/unit/nav2/support/riskFreePgliteHarness.ts). It is not DEV and not production.
//
// PART 1 is the investigation: it runs the PRODUCTION function (migration 0260 alone) through every path the operator can take and records what
// each one does. PART 2 is the fix (migration 0294): the dedicated confirmation, the India calendar day, the honest answer, the weekly series
// ignoring a date. PART 3 holds the NAMED NEGATIVE CONTROLS: each removes one rule from the SQL and the assertion that guards it must go red.
//
// ADMIN STANDARD clauses proved here: s2 (the confirmation needs can_upload_risk_free_data and nothing else), s4 database-bypass (the function
// called directly as a switch-only holder, an admin without the capability, an ordinary user and anon; a direct table write), s8 (an
// unauthorised caller gets an exception, a refused confirmation gets an exception with a sentence, never a quiet no-op), s13 (fail closed).
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { commitRiskFreeUpload, planRiskFreeUpload, RISK_FREE_ATTESTATION_TEXT } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';
import { asRole, createRiskFreeDb, migrationText, one, pgliteClient, U, type MigrationSpec } from './support/riskFreePgliteHarness';

const strip = (sql: string): string => sql.replace(/create\s+extension\s+if\s+not\s+exists\s+(pg_cron|pg_net)\s*;/gi, '');
const M0260 = '0260_nav2_risk_free_governed_dataset.sql';
const M0294 = '0294_nav2_risk_free_confirm_verified_through.sql';
const REPO = 'RBI_POLICY_REPO_RATE';
const TBILL = 'RBI_91D_TBILL_CUTOFF_YIELD';
/** The India day the 0294 tests run on (the database function risk_free_today() is pinned to it, so the suite does not depend on the clock). */
const TODAY = '2026-10-19';
const REASON = 'Checked the RBI press releases up to today: no change to the policy repo rate.';

const HEAD = 'series_id,observation_date,value_percent,frequency,source_document,source_url,retrieved_on,notes';
const row = (series: string, d: string, v: string, retrieved = '2026-10-08', notes = '') => `${series},${d},${v},${series === REPO ? 'policy_change' : 'weekly_auction'},"SYNTHETIC fixture",,${retrieved},${notes}`;
const csv = (...lines: string[]) => [HEAD, ...lines].join('\n') + '\n';
const REPO_HISTORY = csv(row(REPO, '2025-12-05', '5.25', '2026-10-01'));
const REPO_UPDATE = csv(row(REPO, '2026-10-07', '5.50'));
/** The same rate, written again on a later day with a different note: a different file hash, every row identical to what is published. */
const REPO_UPDATE_REWRITTEN = csv(row(REPO, '2026-10-07', '5.50', '2026-10-19', 'checked again'));
const TBILL_FILE = csv(row(TBILL, '2026-09-30', '5.5199', '2026-10-03'));

// A PGlite start takes seconds, so each distinct database (a set of migrations and a pinned India day) is built ONCE and every test gets its own
// clone of it. A mutated migration (a negative control) is never cached.
vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });
const templates = new Map<string, Promise<PGlite>>();
const dbs: PGlite[] = [];
afterEach(async () => {
  while (dbs.length) await dbs.pop()!.close();
});
const build = async (files: MigrationSpec[], today: string | null): Promise<PGlite> => {
  const db = await createRiskFreeDb(files);
  if (today) await db.exec(`create or replace function risk_free_today() returns date language sql stable as $f$ select date '${today}' $f$;`);
  return db;
};
const open = async (files: MigrationSpec[], today: string | null = null): Promise<PGlite> => {
  // A mutated migration (a negative control) is applied on top of a clone of the 0260-only database, then the India day is pinned.
  const mutated = files.filter((f): f is Exclude<MigrationSpec, string> => typeof f !== 'string');
  const plain = files.filter((f): f is string => typeof f === 'string');
  const key = `${plain.join('+')}@${mutated.length ? 'mutated' : (today ?? 'clock')}`;
  if (!templates.has(key)) templates.set(key, build(plain, mutated.length ? null : today));
  const db = (await (await templates.get(key)!).clone()) as PGlite;
  for (const m of mutated) await db.exec(strip(migrationText(m)));
  if (mutated.length && today) await db.exec(`create or replace function risk_free_today() returns date language sql stable as $f$ select date '${today}' $f$;`);
  dbs.push(db);
  return db;
};
/** The 0294 database with "today in India" pinned, so every date rule is tested without depending on the clock. */
const openFixed = (files: MigrationSpec[] = [M0260, M0294], today = TODAY): Promise<PGlite> => open(files, today);

const through = async (db: PGlite, series = REPO) => (await one<{ v: string | null }>(db, `select to_char(verified_through_date, 'YYYY-MM-DD') v from ii_risk_free_series where series_id = '${series}'`)).v;
const count = async (db: PGlite, table: string) => (await one<{ v: number }>(db, `select count(*)::int v from ${table}`)).v;
const stateLog = async (db: PGlite) => (await db.query<{ reason: string; actor_user_id: string }>('select reason, actor_user_id from ii_risk_free_series_state_log order by created_at, id')).rows;

const commit = (db: PGlite, series: string, text: string, verifiedThrough: string | null, todayIso = TODAY, uid: string = U.upload) =>
  commitRiskFreeUpload(pgliteClient(db, uid), { seriesId: series, csvText: text, todayIso, verifiedThrough, fileName: 'f.csv', attested: true, attestationText: RISK_FREE_ATTESTATION_TEXT });
const plan = (db: PGlite, series: string, text: string, verifiedThrough: string | null, todayIso = TODAY) =>
  planRiskFreeUpload(pgliteClient(db, U.upload), { seriesId: series, csvText: text, todayIso, verifiedThrough });
const confirm = (db: PGlite, uid: string | null, args: { series?: string; date?: string | null; reason?: string | null }) =>
  pgliteClient(db, uid).rpc('confirm_risk_free_verified_through', { p_series_id: args.series ?? REPO, p_verified_through: args.date === undefined ? '2026-10-19' : args.date, p_reason: args.reason === undefined ? REASON : args.reason });

/** The repo series as production had it before 19-10-2026: history loaded with "verified through 02-10-2026", then the 07-10-2026 rate file with no date. */
async function seedRepo(db: PGlite) {
  expect((await commit(db, REPO, REPO_HISTORY, '2026-10-02', '2026-10-02')).status).toBe('committed');
  expect((await commit(db, REPO, REPO_UPDATE, null)).status).toBe('committed');
  expect(await through(db)).toBe('2026-10-02');
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe('PART 1 -- investigation: the production function (0260 only) on every path the operator has', () => {
  it('PATH A: the same file again with a later date MOVES the date and writes one state-log row (the path works)', async () => {
    const db = await open([M0260]);
    await seedRepo(db);
    const preview = await plan(db, REPO, REPO_UPDATE, '2026-10-19');
    expect(preview.blockers).toEqual([]);
    expect(preview.newRows).toHaveLength(0); // nothing new: this is the "re-submitted" case
    const out = await commit(db, REPO, REPO_UPDATE, '2026-10-19', '2026-10-19');
    expect(out.status).toBe('already_committed');
    expect(await through(db)).toBe('2026-10-19');
    expect((await stateLog(db)).map((r) => r.reason)).toEqual(['Verified-through date confirmed through 19-10-2026 (re-submitted file).']);
  });

  it('PATH B: a NEW file whose rows are all identical, with a later date, also MOVES the date (batch with 0 rows written)', async () => {
    const db = await open([M0260]);
    await seedRepo(db);
    expect((await commit(db, REPO, REPO_UPDATE_REWRITTEN, '2026-10-19', '2026-10-19')).status).toBe('committed');
    expect(await through(db)).toBe('2026-10-19');
    expect((await one<{ n: number; i: number }>(db, `select rows_inserted n, rows_identical_skipped i from ii_risk_free_batches order by created_at desc limit 1`))).toEqual({ n: 0, i: 1 });
    expect(await count(db, 'ii_risk_free_observations')).toBe(2);
  });

  it('PATH C (the trap): a date that does NOT move the series is answered like a success -- "verified_through_recorded" is true for a date that was ignored', async () => {
    const db = await open([M0260]);
    await seedRepo(db);
    const r = await pgliteClient(db, U.upload).rpc('commit_risk_free_upload', {
      p_series_id: REPO, p_file_sha256: (await planRiskFreeUpload(pgliteClient(db, U.upload), { seriesId: REPO, csvText: REPO_UPDATE, todayIso: TODAY })).fileSha256,
      p_file_name: 'f.csv', p_rows: [{ date: '2026-10-07', value_percent: 5.5, kind: 'value', gap_reason: null, source_document: 'SYNTHETIC fixture', source_url: null, retrieved_on: '2026-10-08', notes: null }],
      p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'admin_upload', p_verified_through: '2026-09-01',
    });
    expect(r.error).toBeNull();
    expect(r.data).toMatchObject({ already_committed: true, verified_through_recorded: true }); // "recorded" -- yet:
    expect(await through(db)).toBe('2026-10-02'); // not moved, and nothing in the answer says so
  });

  it('PATH D: the future-date rule is the server UTC day (current_date): a day after the UTC day is refused whatever day it is in India or Australia', async () => {
    const db = await open([M0260]);
    await seedRepo(db);
    const ahead = (await one<{ v: string }>(db, `select to_char(current_date + 1, 'YYYY-MM-DD') v`)).v;
    const r = await pgliteClient(db, U.upload).rpc('commit_risk_free_upload', {
      p_series_id: REPO, p_file_sha256: 'a'.repeat(64), p_file_name: 'f.csv',
      p_rows: [{ date: '2026-10-07', value_percent: 5.5, kind: 'value', gap_reason: null, source_document: 'SYNTHETIC fixture', source_url: null, retrieved_on: '2026-10-08', notes: null }],
      p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'admin_upload', p_verified_through: ahead,
    });
    expect(r.error?.message).toMatch(/cannot be in the future/);
    expect(await through(db)).toBe('2026-10-02');
  });

  it('PATH E: a date sent for the weekly T-bill series is STORED (it means nothing there)', async () => {
    const db = await open([M0260]);
    const r = await pgliteClient(db, U.upload).rpc('commit_risk_free_upload', {
      p_series_id: TBILL, p_file_sha256: 'd'.repeat(64), p_file_name: 'f.csv',
      p_rows: [{ date: '2026-09-30', value_percent: 5.5199, kind: 'value', gap_reason: null, source_document: 'SYNTHETIC fixture', source_url: null, retrieved_on: '2026-10-03', notes: null }],
      p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'admin_upload', p_verified_through: '2026-10-02',
    });
    expect(r.error).toBeNull();
    expect(await through(db, TBILL)).toBe('2026-10-02');
  });

  it('there is no way to confirm "still current" without a data file: the only functions that write verified_through_date take a file or are the service-role refresh job', async () => {
    const db = await open([M0260]);
    const fns = (await db.query<{ proname: string }>(`select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and pg_get_functiondef(p.oid) like '%verified_through_date =%' order by 1`)).rows.map((r) => r.proname);
    expect(fns).toEqual(['commit_risk_free_upload', 'record_risk_free_refresh_results']);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('PART 2 -- the fix (migration 0294)', () => {
  it('applies on top of 0260, twice (idempotent), and leaves every table, row and constraint alone', async () => {
    const db = await open([M0260]);
    const before = (await db.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and table_name like 'ii_risk_free%' order by 1, 2`)).rows;
    await db.exec(migrationText(M0294));
    await db.exec(migrationText(M0294));
    const after = (await db.query(`select table_name, column_name, data_type from information_schema.columns where table_schema = 'public' and table_name like 'ii_risk_free%' order by 1, 2`)).rows;
    expect(after).toEqual(before);
  });

  it('commit_risk_free_upload in 0294 differs from the 0260 function in exactly the lines the header names (multiset diff of code lines)', () => {
    const code = (sql: string) =>
      sql
        .slice(sql.indexOf('create or replace function commit_risk_free_upload('), sql.indexOf('grant execute on function commit_risk_free_upload'))
        .split(String.fromCharCode(10))
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('--'));
    const diff = (x: string[], y: string[]) => {
      const rest = [...y];
      return x.filter((l) => {
        const i = rest.indexOf(l);
        if (i >= 0) {
          rest.splice(i, 1);
          return false;
        }
        return true;
      });
    };
    const old = code(migrationText(M0260));
    const now = code(migrationText(M0294));
    const removed = diff(old, now);
    const added = diff(now, old);
    expect({ removed: removed.length, added: added.length }).toEqual({ removed: 10, added: 21 });
    // Every removed line is one that handled the verified-through date or the answer: no validation, attestation, hash, conflict or insert line is gone.
    for (const l of removed) expect(l, l).toMatch(/verified_through|series_id = p_series_id|jsonb_build_object/);
    expect(removed.filter((l) => /raise exception|attest|file_sha256|conflict|insert into public\.ii_risk_free_(observations|batches)/.test(l))).toEqual([]);
    // And the three changes are all there: the India day, the weekly ignore, the honest answer.
    expect(added.join(' ')).toContain('public.risk_free_today()');
    expect(added.join(' ')).toContain("v_cadence = 'policy_change'");
    expect(added.join(' ')).toContain("'verified_through_moved', v_moved");
  });

  describe('risk_free_today() is the India calendar day', () => {
    it('equals the Asia/Kolkata day of the database clock, and the TypeScript helper agrees with it at fixed instants', async () => {
      const db = await open([M0260, M0294]);
      const r = await one<{ a: string; b: string }>(db, `select to_char(risk_free_today(), 'YYYY-MM-DD') a, to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') b`);
      expect(r.a).toBe(r.b);
      const { indiaTodayIso } = await import('@/lib/services/investment-intelligence/nav2/riskFreeToday');
      expect(indiaTodayIso(new Date('2026-10-18T18:29:59Z'))).toBe('2026-10-18'); // 23:59:59 in India
      expect(indiaTodayIso(new Date('2026-10-18T18:30:00Z'))).toBe('2026-10-19'); // 00:00:00 in India: the operator's own day has started
      expect(indiaTodayIso(new Date('2026-10-18T22:00:00Z'))).toBe('2026-10-19'); // 09:00 in Melbourne on 19-10, still 18-10 in UTC
    });

    it('a verified-through date equal to the India day is accepted by the upload path even when it is later than the UTC day (the 19-10-2026 morning case)', async () => {
      const db = await openFixed([M0260, M0294], '2090-06-15'); // India day pinned far after the real UTC day
      await commit(db, REPO, REPO_HISTORY, '2026-10-02', '2090-06-15');
      expect((await commit(db, REPO, REPO_UPDATE, '2090-06-15', '2090-06-15')).status).toBe('committed');
      expect(await through(db)).toBe('2090-06-15');
      // ...and the day after is the future.
      await expect(commit(db, REPO, REPO_UPDATE_REWRITTEN, '2090-06-16', '2090-06-16')).rejects.toMatchObject({ message: expect.stringMatching(/future/) });
    });

    it('the plan names the India day in the refusal, and the plan refuses a day after it', async () => {
      const db = await openFixed();
      await seedRepoFixed(db);
      const p = await plan(db, REPO, REPO_UPDATE, '2026-10-20');
      expect(p.blockers.join(' ')).toMatch(/cannot be in the future \(today in India is 19-10-2026\)/);
    });
  });

  describe('the answer says what happened to the date', () => {
    it('a later date: moved = true and the new date is reported; the same date again: moved = false and the current date is reported', async () => {
      const db = await openFixed();
      await seedRepoFixed(db);
      const first = await commit(db, REPO, REPO_UPDATE_REWRITTEN, '2026-10-19');
      expect(first).toMatchObject({ status: 'committed', verifiedThrough: { requested: '2026-10-19', moved: true, current: '2026-10-19' } });
      const again = await commit(db, REPO, REPO_UPDATE_REWRITTEN, '2026-10-19');
      expect(again).toMatchObject({ status: 'already_committed', verifiedThrough: { requested: '2026-10-19', moved: false, current: '2026-10-19' } });
      const earlier = await commit(db, REPO, REPO_UPDATE_REWRITTEN, '2026-10-10');
      expect(earlier).toMatchObject({ status: 'already_committed', verifiedThrough: { requested: '2026-10-10', moved: false, current: '2026-10-19' } });
      expect(await through(db)).toBe('2026-10-19'); // never backwards
    });

    it('the plan warns BEFORE the commit that an entered date is not later than the recorded one', async () => {
      const db = await openFixed();
      await seedRepoFixed(db);
      // The history file ends in 2025, so a date between its end and the recorded 02-10-2026 is allowed but changes nothing.
      const earlier = await plan(db, REPO, REPO_HISTORY, '2026-10-01');
      expect(earlier.blockers).toEqual([]);
      expect(earlier.warnings.join(' ')).toMatch(/already confirmed through 02-10-2026.*01-10-2026.*not later/);
      const same = await plan(db, REPO, REPO_HISTORY, '2026-10-02');
      expect(same.warnings.join(' ')).toMatch(/already confirmed through 02-10-2026.*02-10-2026.*not later/);
      const later = await plan(db, REPO, REPO_HISTORY, '2026-10-03');
      expect(later.warnings.join(' ')).not.toMatch(/not later/);
    });
  });

  describe('a weekly series ignores a verified-through date (it is not sent, not stored)', () => {
    it('the plan drops it with a warning, the commit never sends it, and nothing is stored', async () => {
      const db = await openFixed();
      const p = await plan(db, TBILL, TBILL_FILE, '2026-10-02');
      expect(p.verifiedThrough).toBeNull();
      expect(p.warnings.join(' ')).toMatch(/does nothing for a weekly series and will not be saved/);
      expect(p.blockers).toEqual([]);
      const out = await commit(db, TBILL, TBILL_FILE, '2026-10-02');
      expect(out).toMatchObject({ status: 'committed', verifiedThrough: { requested: null, moved: false } });
      expect(await through(db, TBILL)).toBeNull();
    });

    it('re-submitting a T-bill file with a date is a plain no-op (no database call)', async () => {
      const db = await openFixed();
      await commit(db, TBILL, TBILL_FILE, null);
      expect(await commit(db, TBILL, TBILL_FILE, '2026-10-02')).toMatchObject({ status: 'noop', identical: 1 });
    });

    it('the database function ignores a date for a weekly series even when called directly (defence in depth)', async () => {
      const db = await openFixed();
      const r = await pgliteClient(db, U.upload).rpc('commit_risk_free_upload', {
        p_series_id: TBILL, p_file_sha256: 'b'.repeat(64), p_file_name: 'f.csv',
        p_rows: [{ date: '2026-09-30', value_percent: 5.5199, kind: 'value', gap_reason: null, source_document: 'SYNTHETIC fixture', source_url: null, retrieved_on: '2026-10-03', notes: null }],
        p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'admin_upload', p_verified_through: '2026-10-02',
      });
      expect(r.error).toBeNull();
      expect(r.data).toMatchObject({ verified_through_moved: false, verified_through: null });
      expect(await through(db, TBILL)).toBeNull();
    });

    it('a weekly series already holding a stored date (production today: 02-10-2026) is harmless to the rate lookup and to freshness', async () => {
      const { riskFreeObservationOn, riskFreeFreshness } = await import('@/lib/engines/nav2/riskFree');
      const obs = [{ observationDate: '2026-09-30', yieldPercent: 5.5199, sourceDocument: 'SYNTHETIC', sourceUrl: null, retrievedOn: '2026-10-03', kind: 'value' as const }];
      const withDate = riskFreeObservationOn(obs as never, '2026-10-10', { cadence: 'weekly_auction', maxStalenessDays: 21, verifiedThroughDate: '2026-10-02' });
      const without = riskFreeObservationOn(obs as never, '2026-10-10', { cadence: 'weekly_auction', maxStalenessDays: 21, verifiedThroughDate: null });
      expect(withDate).toEqual(without);
      const base = { seriesId: TBILL, seriesName: 'x', source: 's', attributionText: 'a', cadence: 'weekly_auction', datasetVersion: 'v', retrievedOn: '2026-10-03', termsReviewStatus: 'po_accepted_2026-10-03', enabled: true, yieldBasis: 'annualised_percent_as_published', maxStalenessDays: 21, observations: obs };
      expect(riskFreeFreshness({ ...base, verifiedThroughDate: '2026-10-02' } as never, '2026-10-19')).toMatchObject({ basis: 'last_observation', daysSince: 19, state: 'fresh' });
      expect(riskFreeFreshness({ ...base, verifiedThroughDate: null } as never, '2026-10-19')).toMatchObject({ basis: 'last_observation', daysSince: 19, state: 'fresh' });
    });
  });

  describe('confirm_risk_free_verified_through -- the dedicated control', () => {
    it('moves the date forward, changes no rate, and writes one audit row with the actor, both dates and the reason', async () => {
      const db = await openFixed();
      await seedRepoFixed(db);
      const obsBefore = (await db.query(`select * from ii_risk_free_observations order by observation_date`)).rows;
      const batchesBefore = await count(db, 'ii_risk_free_batches');
      const r = await confirm(db, U.upload, {});
      expect(r.error).toBeNull();
      expect(r.data).toEqual({ series_id: REPO, previous: '2026-10-02', new: '2026-10-19' });
      expect(await through(db)).toBe('2026-10-19');
      expect((await db.query(`select * from ii_risk_free_observations order by observation_date`)).rows).toEqual(obsBefore); // no rate touched
      expect(await count(db, 'ii_risk_free_batches')).toBe(batchesBefore); // no data file, no batch
      const log = await stateLog(db);
      expect(log).toHaveLength(1);
      expect(log[0].actor_user_id).toBe(U.upload);
      expect(log[0].reason).toBe(`Confirmed still current through 19-10-2026 (was 02-10-2026). Reason: ${REASON}`);
      expect(await one(db, `select (enabled and terms_review_status = 'po_accepted_2026-10-03') v from ii_risk_free_series where series_id = '${REPO}'`)).toEqual({ v: true }); // switch and terms untouched
    });

    it('the first confirmation of a series that never had a date says so in the audit row', async () => {
      const db = await openFixed();
      await commit(db, REPO, REPO_UPDATE, null);
      expect((await confirm(db, U.upload, { date: '2026-10-08' })).error).toBeNull();
      expect((await stateLog(db))[0].reason).toMatch(/^Confirmed still current through 08-10-2026 \(not confirmed before\)\. Reason: /);
    });

    it('the audit row is permanent: it cannot be updated or deleted, even by the table owner', async () => {
      const db = await openFixed();
      await seedRepoFixed(db);
      await confirm(db, U.upload, {});
      await expect(db.exec(`update ii_risk_free_series_state_log set reason = 'changed after the fact, long enough'`)).rejects.toThrow(/append-only/);
      await expect(db.exec(`delete from ii_risk_free_series_state_log`)).rejects.toThrow(/append-only/);
    });

    describe('refusals: each one is an exception with a sentence, and nothing changes', () => {
      const cases: Array<[string, (db: PGlite) => ReturnType<typeof confirm>, RegExp]> = [
        ['a reason of 19 characters', (db) => confirm(db, U.upload, { reason: 'nineteen characters' }), /reason of at least 20 characters/],
        ['no reason', (db) => confirm(db, U.upload, { reason: null }), /reason of at least 20 characters/],
        ['a blank reason padded with spaces', (db) => confirm(db, U.upload, { reason: '                         ' }), /reason of at least 20 characters/],
        ['a day in the future (India day 19-10-2026)', (db) => confirm(db, U.upload, { date: '2026-10-20' }), /cannot be in the future, today in India is 19-10-2026/],
        ['a day earlier than the last published rate (07-10-2026)', (db) => confirm(db, U.upload, { date: '2026-10-06' }), /earlier than the last published rate \(07-10-2026\)/],
        ['the day the series is already confirmed through', (db) => confirm(db, U.upload, { date: '2026-10-02' }), /earlier than the last published rate|already confirmed through/],
        ['no date', (db) => confirm(db, U.upload, { date: null }), /the series and the date are required/],
        ['the weekly T-bill series', (db) => confirm(db, U.upload, { series: TBILL }), /only a policy-change series/],
        ['an unknown series', (db) => confirm(db, U.upload, { series: 'RBI_NOT_A_SERIES' }), /unknown series/],
      ];
      for (const [name, run, message] of cases) {
        it(name, async () => {
          const db = await openFixed();
          await seedRepoFixed(db);
          const logBefore = await count(db, 'ii_risk_free_series_state_log');
          const r = await run(db);
          expect(r.error?.code).toBe('22023');
          expect(r.error?.message).toMatch(message);
          expect(await through(db)).toBe('2026-10-02');
          expect(await count(db, 'ii_risk_free_series_state_log')).toBe(logBefore);
        });
      }

      it('a day that is not later than the recorded one is refused with the recorded date named (never a silent no-op)', async () => {
        const db = await openFixed();
        await seedRepoFixed(db);
        expect((await confirm(db, U.upload, { date: '2026-10-15' })).error).toBeNull();
        const same = await confirm(db, U.upload, { date: '2026-10-15' });
        expect(same.error?.message).toMatch(/already confirmed through 15-10-2026, a confirmation must be later than that/);
        const earlier = await confirm(db, U.upload, { date: '2026-10-10' });
        expect(earlier.error?.message).toMatch(/already confirmed through 15-10-2026/);
        expect(await through(db)).toBe('2026-10-15');
        expect(await count(db, 'ii_risk_free_series_state_log')).toBe(1);
      });

      it('a series with no published rate cannot be confirmed (there is nothing to confirm)', async () => {
        const db = await openFixed();
        const r = await confirm(db, U.upload, {});
        expect(r.error?.message).toMatch(/no published rate yet/);
      });

      it('a gap row is not a rate: a series holding only a gap row has no published rate', async () => {
        const db = await openFixed();
        await db.exec(`insert into ii_risk_free_batches (series_id, source_kind, rows_submitted, rows_inserted) values ('${REPO}', 'weekly_refresh', 1, 1)`);
        await db.exec(`insert into ii_risk_free_observations (series_id, observation_date, kind, gap_reason, source_document, retrieved_on, entry_kind) values ('${REPO}', '2026-10-05', 'gap', 'no_row_in_source', 'SYNTHETIC', '2026-10-06', 'admin_upload')`);
        expect((await confirm(db, U.upload, {})).error?.message).toMatch(/no published rate yet/);
      });
    });

    describe('capability and database bypass (Admin standard s2, s4, s8)', () => {
      it('the upload capability holder is allowed; a switch-only holder, an admin without the capability, an ordinary user and a caller with no identity are refused with 42501 and nothing changes', async () => {
        const db = await openFixed();
        await seedRepoFixed(db);
        for (const [who, uid] of [['switch-only holder', U.switchOnly], ['admin without the capability', U.noCapability], ['ordinary user', U.plainUser], ['no identity', null]] as const) {
          const r = await confirm(db, uid, {});
          expect(r.error?.code, who).toBe('42501');
          expect(r.error?.message, who).toMatch(/not authorised/);
        }
        expect(await through(db)).toBe('2026-10-02');
        expect(await count(db, 'ii_risk_free_series_state_log')).toBe(0);
        expect((await confirm(db, U.upload, {})).error).toBeNull();
      });

      it('anon cannot execute either function (execute revoked), and a signed-in session cannot write the series table or the state log directly', async () => {
        const db = await openFixed();
        await seedRepoFixed(db);
        await expect(asRole(db, 'anon', null, () => db.query(`select confirm_risk_free_verified_through('${REPO}', date '2026-10-19', '${REASON}')`))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, 'anon', null, () => db.query(`select risk_free_today()`))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, 'authenticated', U.upload, () => db.query(`update ii_risk_free_series set verified_through_date = date '2026-10-19' where series_id = '${REPO}'`))).rejects.toThrow(/permission denied/);
        await expect(asRole(db, 'authenticated', U.upload, () => db.query(`insert into ii_risk_free_series_state_log (series_id, previous_enabled, new_enabled, previous_terms_status, new_terms_status, reason, actor_user_id) values ('${REPO}', true, true, 'x', 'x', 'a long enough reason to pass the check', '${U.upload}')`))).rejects.toThrow(/permission denied/);
        expect(await through(db)).toBe('2026-10-02');
      });

      it('the function is SECURITY DEFINER with a fixed search_path, and execute is granted to authenticated and service_role only', async () => {
        const db = await openFixed();
        const f = await one<{ secdef: boolean; cfg: string[] | null; auth: boolean; anon: boolean; svc: boolean; pub: boolean }>(db, `
          select p.prosecdef secdef, p.proconfig cfg,
                 has_function_privilege('authenticated', p.oid, 'execute') auth, has_function_privilege('anon', p.oid, 'execute') anon,
                 has_function_privilege('service_role', p.oid, 'execute') svc,
                 coalesce((select bool_or(a.grantee = 0) from aclexplode(p.proacl) a), false) pub
            from pg_proc p where p.proname = 'confirm_risk_free_verified_through'`);
        expect(f).toMatchObject({ secdef: true, auth: true, anon: false, svc: true, pub: false });
        expect(f.cfg).toContain('search_path=public');
      });
    });
  });
});

/** The fixed-today variant of seedRepo: history loaded on 02-10-2026 with that date, then the 07-10-2026 rate file with none. */
async function seedRepoFixed(db: PGlite) {
  expect((await commit(db, REPO, REPO_HISTORY, '2026-10-02', '2026-10-02')).status).toBe('committed');
  expect((await commit(db, REPO, REPO_UPDATE, null)).status).toBe('committed');
  expect(await through(db)).toBe('2026-10-02');
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe('PART 2b -- the hand-run package (docs/nav2/po_apply_verified_through/sql) really runs, in the order the README gives', () => {
  const PKG = path.resolve(__dirname, '..', '..', '..', 'docs', 'nav2', 'po_apply_verified_through', 'sql');
  const pkg = (f: string) => fs.readFileSync(path.join(PKG, f), 'utf8');
  const PART_D = path.resolve(__dirname, '..', '..', '..', 'docs', 'nav2', 'po_apply_production', 'sql', 'parts', '0260d.sql');

  it('before: P1 to P4 and the backup run and check out; apply 0294; C0294 is one row of true values; P4 flips; the confirmation works; then the rollback restores the 0260 function and removes the two new ones', async () => {
    const db = await open([M0260]);
    await commit(db, REPO, REPO_HISTORY, '2026-10-02', '2026-10-02');
    await commit(db, REPO, REPO_UPDATE, null, '2026-10-08');
    const rows = async (f: string) => (await db.query<Record<string, unknown>>(pkg(f))).rows;

    const p1 = await rows('P1_read_only_state.sql');
    expect(p1.map((r) => [r.series_id, r.confirmed_through, r.last_rate_day])).toEqual([[TBILL, null, null], [REPO, '02-10-2026', '07-10-2026']]);
    await rows('P2_read_only_what_happened_on_19_10.sql');
    await rows('P3_read_only_state_log.sql');
    expect(await rows('P4_read_only_function_version.sql')).toEqual([{ has_same_file_confirmation: true, new_version: false, confirm_function: false }]);

    await db.exec(pkg('B1_backup_series_and_log.sql'));
    await db.exec(pkg('B1_backup_series_and_log.sql')); // safe twice
    expect(await rows('B2_backup_check.sql')).toEqual([{ series_saved: 2, series_now: 2, state_log_saved: 0, state_log_now: 0, copies_locked_to_service_role: true }]);

    await db.exec(pkg('0294_apply.sql'));
    await db.exec(pkg('0294_apply.sql')); // safe twice
    expect(await rows('C0294_check_after.sql')).toEqual([{ india_day_function_ok: true, confirm_function_ok: true, signed_in_can_call_confirm: true, anon_cannot_call_confirm: true, confirm_runs_with_definer_rights: true, signed_in_can_call_upload: true, anon_cannot_call_upload: true, upload_function_is_new_version: true, both_series_still_there: true }]);
    expect(await rows('P4_read_only_function_version.sql')).toEqual([{ has_same_file_confirmation: true, new_version: true, confirm_function: true }]);

    // The Product Owner step 5: confirm through the India day with a reason (the only way the production date is fixed).
    const today = (await one<{ v: string }>(db, `select to_char(risk_free_today(), 'YYYY-MM-DD') v`)).v;
    expect((await confirm(db, U.upload, { date: today })).error).toBeNull();
    expect(await through(db)).toBe(today);
    expect((await rows('P3_read_only_state_log.sql')).map((r) => String(r.reason_start).startsWith('Confirmed still current through'))).toEqual([true]);

    // Rollback: step 1 the 0260 part d again, step 2 the rollback file.
    await db.exec(fs.readFileSync(PART_D, 'utf8'));
    await db.exec(pkg('rollback_0294.sql'));
    expect(await rows('P4_read_only_function_version.sql')).toEqual([{ has_same_file_confirmation: true, new_version: false, confirm_function: false }]);
    expect(await through(db)).toBe(today); // no data lost by the rollback
    expect(await count(db, 'ii_risk_free_series_state_log')).toBe(1); // the audit row stays
    // and the 0260 function works again
    expect((await commit(db, REPO, REPO_UPDATE_REWRITTEN, today, '2026-10-19')).status).toBe('committed');

    await db.exec(pkg('B3_drop_backups_after_release.sql'));
    expect((await db.query(`select 1 from information_schema.tables where table_name like 'nav2_backup_20261019%'`)).rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe('PART 3 -- NAMED NEGATIVE CONTROLS: remove one rule from the SQL and the assertion that guards it must go red', () => {
  const mutate = (name: string, from: string | RegExp, to: string): MigrationSpec => ({
    name,
    transform: (sql) => {
      const out = sql.replace(from, to);
      if (out === sql) throw new Error(`the mutation did not change the SQL: ${String(from)}`);
      return out;
    },
  });

  it('NC-V1 (forward only): without the "not later than recorded" rule a confirmation of an earlier or equal day SUCCEEDS and the date goes back', async () => {
    const db = await openFixed([M0260, mutate(M0294, /  if v_s\.verified_through_date is not null and p_verified_through <= v_s\.verified_through_date then[\s\S]*?end if;\n/, '')]);
    await seedRepoFixed(db);
    expect((await confirm(db, U.upload, { date: '2026-10-15' })).error).toBeNull();
    const back = await confirm(db, U.upload, { date: '2026-10-10' });
    expect(back.error).toBeNull(); // red in the real function (see the refusal tests above): here the date moved BACK
    expect(await through(db)).toBe('2026-10-10');
  });

  it('NC-V2 (capability): without the predicate a switch-only holder and a plain user CAN confirm', async () => {
    const db = await openFixed([M0260, mutate(M0294, "if v_uid is null or not public.is_risk_free_data_admin() then\n    raise exception 'risk-free confirmation: not authorised'", "if false then\n    raise exception 'risk-free confirmation: not authorised'")]);
    await seedRepoFixed(db);
    expect((await confirm(db, U.switchOnly, { date: '2026-10-15' })).error).toBeNull();
    expect((await confirm(db, U.plainUser, { date: '2026-10-16' })).error).toBeNull();
  });

  it('NC-V3 (weekly): without the cadence rule the T-bill series CAN be confirmed', async () => {
    const db = await openFixed([M0260, mutate(M0294, "if v_s.cadence <> 'policy_change' then", 'if false then')]);
    await commit(db, TBILL, TBILL_FILE, null);
    expect((await confirm(db, U.upload, { series: TBILL, date: '2026-10-10' })).error).toBeNull();
  });

  it('NC-V4 (future): without the future rule a day after the India day is accepted', async () => {
    const db = await openFixed([M0260, mutate(M0294, 'if p_verified_through > v_today then', 'if false then')]);
    await seedRepoFixed(db);
    expect((await confirm(db, U.upload, { date: '2026-12-31' })).error).toBeNull();
  });

  it('NC-V5 (reason): without the length rule a one-letter reason is accepted', async () => {
    const db = await openFixed([M0260, mutate(M0294, "if p_reason is null or length(trim(p_reason)) < 20 then\n    raise exception 'risk-free confirmation", "if false then\n    raise exception 'risk-free confirmation")]);
    await seedRepoFixed(db);
    expect((await confirm(db, U.upload, { reason: 'x' })).error).toBeNull();
  });

  it('NC-V6 (nothing to confirm): without the last-rate rule a day before the last published rate is accepted', async () => {
    const db = await openFixed([M0260, mutate(M0294, 'if p_verified_through < v_last then', 'if false then')]);
    await seedRepoFixed(db);
    expect((await confirm(db, U.upload, { date: '2026-10-03' })).error).toBeNull();
  });

  it('NC-V7 (weekly ignore in the upload): without it a date typed for the T-bill series is stored again', async () => {
    const db = await openFixed([M0260, mutate(M0294, "v_through := case when v_cadence = 'policy_change' then p_verified_through else null end;", 'v_through := p_verified_through;')]);
    // The TypeScript plan already drops the date, so call the function directly to reach it.
    const r = await pgliteClient(db, U.upload).rpc('commit_risk_free_upload', {
      p_series_id: TBILL, p_file_sha256: 'c'.repeat(64), p_file_name: 'f.csv',
      p_rows: [{ date: '2026-09-23', value_percent: 5.39, kind: 'value', gap_reason: null, source_document: 'SYNTHETIC fixture', source_url: null, retrieved_on: '2026-10-03', notes: null }],
      p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'admin_upload', p_verified_through: '2026-10-02',
    });
    expect(r.error).toBeNull();
    expect(await through(db, TBILL)).toBe('2026-10-02'); // stored: the real function leaves it null (tested above)
  });

  it('NC-V8 (India day): with the UTC day instead of the India day the upload refuses an India-day date that is later than the UTC day', async () => {
    const db = await openFixed([M0260, mutate(M0294, 'if p_verified_through is not null and p_verified_through > public.risk_free_today() then', 'if p_verified_through is not null and p_verified_through > current_date then')], '2090-06-15');
    await commit(db, REPO, REPO_HISTORY, '2026-10-02', '2090-06-15');
    // red in the real function (it accepts this exact call, see "a verified-through date equal to the India day is accepted"): here it is refused
    await expect(commit(db, REPO, REPO_UPDATE, '2090-06-15', '2090-06-15')).rejects.toMatchObject({ message: expect.stringMatching(/future/) });
  });

  it('the harness itself is real: a mutation that changes nothing throws, so a green control cannot be a control that never applied', () => {
    expect(() => (mutate(M0294, 'text that is not in the file', 'x') as { transform: (s: string) => string }).transform(migrationText(M0294))).toThrow(/did not change the SQL/);
  });
});
