// NAV2 Stage 2 -- the risk-free CSV reader/validator and the upload plan/commit service.
//
// All fixture rows are SYNTHETIC (their source_document says so); no RBI-published value is copied into the repository.
// The Product Owner's real first-load files were parsed separately (see the Stage 2 report) and are not committed.
//
// Matrix: Stage 2 rows S2-10 (the PO's CSV format loads: both series, quoted fields, gap rows), S2-11 (an upload never changes a
// published value), S2-12 (commit is attested, hash-bound and goes through the caller's own session), S2-13 (idempotent).
//
// NAMED NEGATIVE CONTROLS
//   NC-C1  a wrong series_id / frequency, a future date, an unreal date, a value with more than 4 decimals, a value
//          outside 0-100, a missing source document, and a gap row with a value are each rejected with their own code;
//   NC-C2  conflicting duplicate rows reject ALL rows of that date; identical duplicates collapse;
//   NC-C3  a date that already holds a different value blocks the whole upload (never an overwrite);
//   NC-C4  any rejected row blocks the commit (a governed dataset is not loaded half-way);
//   NC-C5  no attestation, a changed file, or a blocked plan means the database function is NEVER called;
//   NC-C6  the function is called with the CALLER's client and the whole accepted file, with the entry kind chosen.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { dmy, parseRiskFreeCsv, RISK_FREE_CSV_MAX_ROWS } from '@/lib/services/investment-intelligence/nav2/riskFreeCsv';
import { commitRiskFreeUpload, planRiskFreeUpload, RISK_FREE_ATTESTATION_TEXT, sha256Hex } from '@/lib/services/investment-intelligence/nav2/riskFreeUploadService';
import { createInMemoryDb, type Row } from '../support/inMemorySupabase';

const TODAY = '2026-10-04';
const T = 'RBI_91D_TBILL_CUTOFF_YIELD';
const R = 'RBI_POLICY_REPO_RATE';
const HEAD = 'series_id,observation_date,value_percent,frequency,source_document,source_url,retrieved_on,notes';
const line = (series: string, date: string, v: string, freq = 'weekly_auction', doc = 'SYNTHETIC fixture, quoted, with a comma', retrieved = '2026-10-03', notes = '') =>
  `${series},${date},${v},${freq},"${doc}",https://example.invalid/x,${retrieved},${notes}`;
const csv = (...lines: string[]) => [HEAD, ...lines].join('\n');

describe('CSV reader', () => {
  it('reads the PO format: quoted fields with commas, a BOM, CRLF, both cadences (matrix 51)', () => {
    const t = '﻿' + [HEAD, line(T, '2026-09-16', '5.2801'), line(T, '2026-09-23', '5.3900'), line(T, '2026-09-30', '5.5199')].join('\r\n') + '\r\n';
    const a = parseRiskFreeCsv(t, T, 'weekly_auction', TODAY);
    expect(a.fileRejected).toBe(false);
    expect(a.rejected).toEqual([]);
    expect(a.accepted.map((r) => [r.date, r.value_percent])).toEqual([['2026-09-16', 5.2801], ['2026-09-23', 5.39], ['2026-09-30', 5.5199]]);
    expect(a.accepted[0].source_document).toBe('SYNTHETIC fixture, quoted, with a comma');
    expect(a).toMatchObject({ dateFrom: '2026-09-16', dateTo: '2026-09-30', totalDataRows: 3 });
    const repo = parseRiskFreeCsv(csv(line(R, '2025-12-05', '5.25', 'policy_change'), line(R, '2025-02-07', '6.25', 'policy_change')), R, 'policy_change', TODAY);
    expect(repo.accepted.map((r) => r.date)).toEqual(['2025-02-07', '2025-12-05']); // sorted ascending
  });

  it('accepts a gap row (no accepted bids) and stores no value for it', () => {
    const t = `${HEAD}\n${T},2026-08-12,,weekly_auction,"SYNTHETIC auction cancelled",,2026-10-03,\n`;
    const withReason = t.replace('2026-10-03,\n', '2026-10-03,\n').replace(HEAD, `${HEAD},gap_reason`).replace(',2026-10-03,\n', ',2026-10-03,,no_accepted_bids\n');
    const a = parseRiskFreeCsv(withReason, T, 'weekly_auction', TODAY);
    expect(a.rejected).toEqual([]);
    expect(a.accepted[0]).toMatchObject({ kind: 'gap', value_percent: null, gap_reason: 'no_accepted_bids' });
  });

  it('NC-C1: each defect has its own rejection code and message, and no row is repaired', () => {
    const rows = [
      line('OTHER_SERIES', '2026-09-16', '5.2'),
      line(T, '2026-09-16', '5.2', 'policy_change'),
      line(T, '2026-09-17', '5.2', 'weekly_auction', 'doc', '2026-09-16'), // dated after it was retrieved
      line(T, '2026-02-30', '5.2'),
      line(T, '2026-09-18', '5.12345'),
      line(T, '2026-09-19', '650'),
      line(T, '2026-09-20', 'five'),
      line(T, '2026-09-21', '5.2', 'weekly_auction', ''),
      line(T, '2026-10-09', '5.2', 'weekly_auction', 'doc', '2026-10-09'), // after today
      `${T},2026-09-22,5.1,weekly_auction,"doc",,2026-10-03,`,
    ];
    const a = parseRiskFreeCsv(csv(...rows), T, 'weekly_auction', TODAY);
    expect(a.rejected.map((r) => r.code)).toEqual(['wrong_series', 'wrong_frequency', 'future_date', 'bad_date', 'too_many_decimals', 'out_of_range', 'bad_value', 'missing_source_document', 'future_date']);
    expect(a.accepted.map((r) => r.date)).toEqual(['2026-09-22']);
    expect(a.rejected[2].message).toMatch(/17-09-2026/); // day-first in text, never ISO
    for (const r of a.rejected) expect(r.message).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    expect(a.rejected[0].line).toBe(2);
  });

  it('a gap row carrying a value, or without a reason, is rejected', () => {
    const h = `${HEAD},kind,gap_reason`;
    const a = parseRiskFreeCsv(`${h}\n${T},2026-09-16,5.2,weekly_auction,"d",,2026-10-03,,gap,no_accepted_bids\n${T},2026-09-23,,weekly_auction,"d",,2026-10-03,,gap,\n${T},2026-09-30,,weekly_auction,"d",,2026-10-03,,gap,sold_out\n`, T, 'weekly_auction', TODAY);
    expect(a.rejected.map((r) => r.code)).toEqual(['gap_with_value', 'gap_without_reason', 'bad_gap_reason']);
  });

  it('NC-C2: conflicting duplicates reject every row of that date; identical duplicates collapse', () => {
    const a = parseRiskFreeCsv(csv(line(T, '2026-09-16', '5.2'), line(T, '2026-09-16', '5.3'), line(T, '2026-09-23', '5.4'), line(T, '2026-09-23', '5.4')), T, 'weekly_auction', TODAY);
    expect(a.rejected.map((r) => r.code)).toEqual(['conflicting_duplicate', 'conflicting_duplicate']);
    expect(a.accepted.map((r) => [r.date, r.value_percent])).toEqual([['2026-09-23', 5.4]]);
  });

  it('rejects the whole file for a missing required column, an empty file, a header only, and too many rows', () => {
    expect(parseRiskFreeCsv('', T, 'weekly_auction', TODAY).fileRejected).toBe(true);
    expect(parseRiskFreeCsv('series_id,observation_date\nx,y', T, 'weekly_auction', TODAY).fileRejectionReason).toMatch(/value_percent.*source_document.*retrieved_on/);
    expect(parseRiskFreeCsv(HEAD, T, 'weekly_auction', TODAY).fileRejectionReason).toMatch(/no data rows/);
    const big = csv(...Array.from({ length: RISK_FREE_CSV_MAX_ROWS + 1 }, (_, i) => line(T, '2026-09-16', String(1 + (i % 5)))));
    expect(parseRiskFreeCsv(big, T, 'weekly_auction', TODAY).fileRejectionReason).toMatch(/limit/);
  });

  it('warns (never blocks) on a large weekly move and on a hole in a weekly series; a repeated policy rate is flagged', () => {
    const w = parseRiskFreeCsv(csv(line(T, '2026-06-03', '5.0'), line(T, '2026-06-10', '7.0'), line(T, '2026-09-02', '7.1')), T, 'weekly_auction', TODAY);
    expect(w.rejected).toEqual([]);
    expect(w.warnings.join(' ')).toMatch(/above 1.5 percentage points.*10-06-2026/);
    expect(w.warnings.join(' ')).toMatch(/more than 14 days.*10-06-2026/);
    const p = parseRiskFreeCsv(csv(line(R, '2025-02-07', '6.25', 'policy_change'), line(R, '2025-04-09', '6.25', 'policy_change')), R, 'policy_change', TODAY);
    expect(p.warnings.join(' ')).toMatch(/repeat the previous rate/);
  });

  it('dmy is day-first', () => expect(dmy('2026-09-30')).toBe('30-09-2026'));
});

// ---------------------------------------------------------------------------
function world(existing: Row[] = [], seriesRows: Row[] = [{ series_id: T, cadence: 'weekly_auction' }, { series_id: R, cadence: 'policy_change' }]) {
  const db = createInMemoryDb({ strictSchema: true });
  db.reset({ ii_risk_free_series: seriesRows, ii_risk_free_observations: existing });
  return db;
}
const stored = (date: string, v: number | null, series = T, kind = 'value'): Row => ({ series_id: series, observation_date: date, kind, value_percent: v });
const CLEAN = csv(line(T, '2026-09-16', '5.2801'), line(T, '2026-09-23', '5.39'), line(T, '2026-09-30', '5.5199'));

describe('upload plan (preview writes nothing)', () => {
  it('a clean file against an empty store has every row new and no blockers; nothing is written', async () => {
    const db = world();
    const plan = await planRiskFreeUpload(db.client as unknown as SupabaseClient, { seriesId: T, csvText: CLEAN, todayIso: TODAY });
    expect(plan.blockers).toEqual([]);
    expect(plan.newRows).toHaveLength(3);
    expect(plan.fileSha256).toBe(sha256Hex(CLEAN));
    expect(db.writes).toEqual([]);
  });

  it('NC-C3 / matrix 52: a date already holding a DIFFERENT value blocks the whole upload; an identical one is counted', async () => {
    const db = world([stored('2026-09-23', 5.39), stored('2026-09-30', 5.6)]);
    const plan = await planRiskFreeUpload(db.client as unknown as SupabaseClient, { seriesId: T, csvText: CLEAN, todayIso: TODAY });
    expect(plan.identicalExisting).toBe(1);
    expect(plan.conflicts).toEqual([{ date: '2026-09-30', existing: 5.6, incoming: 5.5199 }]);
    expect(plan.blockers.join(' ')).toMatch(/30-09-2026.*never changes a published value/);
    expect(plan.newRows.map((r) => r.date)).toEqual(['2026-09-16']);
  });

  it('NC-C4: a rejected row blocks the commit even though the other rows are fine', async () => {
    const db = world();
    const plan = await planRiskFreeUpload(db.client as unknown as SupabaseClient, { seriesId: T, csvText: csv(line(T, '2026-09-16', '5.2801'), line(T, '2026-09-23', '650')), todayIso: TODAY });
    expect(plan.blockers.join(' ')).toMatch(/not loaded half-way/);
  });

  it('an unknown series, or storage that does not exist yet (migration not applied), is a blocker, not a crash', async () => {
    const none = world([], []);
    const a = await planRiskFreeUpload(none.client as unknown as SupabaseClient, { seriesId: T, csvText: CLEAN, todayIso: TODAY });
    expect(a.blockers.join(' ')).toMatch(/0260 has not been applied/);
    const broken = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'relation does not exist' } }) }) }) }) } as unknown as SupabaseClient;
    const b = await planRiskFreeUpload(broken, { seriesId: T, csvText: CLEAN, todayIso: TODAY });
    expect(b.blockers.join(' ')).toMatch(/could not be read/);
  });

  it('a policy-change series warns until a verified-through date is given, and validates the date', async () => {
    const repoCsv = csv(line(R, '2025-12-05', '5.25', 'policy_change'));
    const db = world();
    const c = db.client as unknown as SupabaseClient;
    expect((await planRiskFreeUpload(c, { seriesId: R, csvText: repoCsv, todayIso: TODAY })).warnings.join(' ')).toMatch(/verified through/);
    expect((await planRiskFreeUpload(c, { seriesId: R, csvText: repoCsv, todayIso: TODAY, verifiedThrough: '2026-10-02' })).blockers).toEqual([]);
    expect((await planRiskFreeUpload(c, { seriesId: R, csvText: repoCsv, todayIso: TODAY, verifiedThrough: '2026-10-09' })).blockers.join(' ')).toMatch(/future/);
    expect((await planRiskFreeUpload(c, { seriesId: R, csvText: repoCsv, todayIso: TODAY, verifiedThrough: '2025-01-01' })).blockers.join(' ')).toMatch(/earlier than the last observation/);
    expect((await planRiskFreeUpload(c, { seriesId: R, csvText: repoCsv, todayIso: TODAY, verifiedThrough: '02/10/2026' })).blockers.join(' ')).toMatch(/not a real date/);
  });
});

describe('commit (NC-C5, NC-C6)', () => {
  const rpcClient = (db: ReturnType<typeof world>, data: unknown = { already_committed: false, batch_id: 'b-1', inserted: 3, identical: 0 }, error: unknown = null) => {
    const rpc = vi.fn(async () => ({ data, error }));
    return { client: Object.assign(Object.create(null), { from: (db.client as { from: (t: string) => unknown }).from, rpc }) as unknown as SupabaseClient, rpc };
  };
  const base = { seriesId: T, csvText: CLEAN, todayIso: TODAY, fileName: 'first_load.csv', attested: true, attestationText: RISK_FREE_ATTESTATION_TEXT };

  it('calls commit_risk_free_upload ONCE on the caller\'s client with the whole accepted file, the attestation and the entry kind', async () => {
    const db = world();
    const { client, rpc } = rpcClient(db);
    const out = await commitRiskFreeUpload(client, { ...base, firstLoad: true, expectedSha256: sha256Hex(CLEAN) });
    expect(out).toEqual({ status: 'committed', batchId: 'b-1', inserted: 3, identical: 0 });
    expect(rpc).toHaveBeenCalledTimes(1);
    const [fn, params] = rpc.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(fn).toBe('commit_risk_free_upload');
    expect(params).toMatchObject({ p_series_id: T, p_file_sha256: sha256Hex(CLEAN), p_file_name: 'first_load.csv', p_attested: true, p_attestation_text: RISK_FREE_ATTESTATION_TEXT, p_entry_kind: 'first_load_csv', p_verified_through: null });
    expect((params.p_rows as unknown[]).length).toBe(3);
    expect(db.writes).toEqual([]); // the service itself writes nothing; the database function is the only writer
  });

  it('the entry kind is admin_upload unless the operator says first load', async () => {
    const { client, rpc } = rpcClient(world());
    await commitRiskFreeUpload(client, base);
    expect((rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].p_entry_kind).toBe('admin_upload');
  });

  it('NC-C5: no attestation, a wrong attestation text, a changed file, or a blocked plan never reach the database function', async () => {
    const db = world([stored('2026-09-30', 5.6)]);
    const { client, rpc } = rpcClient(db);
    expect((await commitRiskFreeUpload(client, { ...base, attested: false })).status).toBe('refused');
    expect((await commitRiskFreeUpload(client, { ...base, attestationText: 'I agree' })).status).toBe('refused');
    expect(await commitRiskFreeUpload(client, { ...base, csvText: csv(line(T, '2026-09-16', '5.2801')), expectedSha256: sha256Hex(CLEAN) })).toMatchObject({ status: 'refused', blockers: [expect.stringMatching(/changed between the preview and the commit/)] });
    expect((await commitRiskFreeUpload(client, base)).status).toBe('refused'); // 30-09-2026 holds a different value
    expect(rpc).not.toHaveBeenCalled();
  });

  it('matrix 54: a file whose rows are all already published is a no-op and does not call the function', async () => {
    const db = world([stored('2026-09-16', 5.2801), stored('2026-09-23', 5.39), stored('2026-09-30', 5.5199)]);
    const { client, rpc } = rpcClient(db);
    expect(await commitRiskFreeUpload(client, base)).toEqual({ status: 'noop', identical: 3 });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('a re-submitted file that the database already holds is reported as already committed; a database refusal propagates', async () => {
    const { client } = rpcClient(world(), { already_committed: true, batch_id: 'b-0', inserted: 3, identical: 0 });
    expect(await commitRiskFreeUpload(client, base)).toEqual({ status: 'already_committed', batchId: 'b-0', inserted: 3, identical: 0 });
    const { client: failing } = rpcClient(world(), null, { message: 'risk-free upload: not authorised', code: '42501' });
    await expect(commitRiskFreeUpload(failing, base)).rejects.toMatchObject({ code: '42501' });
  });
});

describe('a separate file of documented gap rows (the first-load gaps CSV)', () => {
  const GH = `${HEAD},kind,gap_reason`;
  const gline = (date: string, reason: string) => `${T},${date},,weekly_auction,"SYNTHETIC gap row",,2026-10-03,,gap,${reason}`;
  it('loads gap rows of all three reasons, sorted; a gap-only file raises no weekly-spacing warning', () => {
    const a = parseRiskFreeCsv([GH, gline('2025-12-31', 'no_row_in_source'), gline('2023-03-29', 'no_accepted_bids'), gline('2024-09-18', 'no_auction_held')].join('\n'), T, 'weekly_auction', TODAY);
    expect(a.rejected).toEqual([]);
    expect(a.accepted.map((r) => [r.date, r.kind, r.value_percent, r.gap_reason])).toEqual([
      ['2023-03-29', 'gap', null, 'no_accepted_bids'],
      ['2024-09-18', 'gap', null, 'no_auction_held'],
      ['2025-12-31', 'gap', null, 'no_row_in_source'],
    ]);
    expect(a.warnings).toEqual([]);
  });
  it('an unknown reason is refused and names the three valid ones', () => {
    const a = parseRiskFreeCsv([GH, gline('2025-12-31', 'because')].join('\n'), T, 'weekly_auction', TODAY);
    expect(a.rejected[0]).toMatchObject({ code: 'bad_gap_reason' });
    expect(a.rejected[0].message).toMatch(/no_row_in_source/);
  });
  it('a gap on a date that already holds a value is a conflict that blocks the upload (a gap never replaces a value)', async () => {
    const db = world([stored('2025-12-31', 5.3)]);
    const plan = await planRiskFreeUpload(db.client as unknown as SupabaseClient, { seriesId: T, csvText: [GH, gline('2025-12-31', 'no_row_in_source')].join('\n'), todayIso: TODAY });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.blockers.join(' ')).toMatch(/already hold a different published value/);
  });
});
