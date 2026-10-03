// NAV2 Stage 2 -- the correction worker's cron route: secret, kill switch, and an end-to-end pass over an in-memory database.
//
// Matrix: Stage 2 row S2-07 (the worker's secret, kill switch and idempotence).
//
// NAMED NEGATIVE CONTROLS
//   NC-K1  no secret / a wrong secret is a 401 and nothing is read;
//   NC-K2  switch OFF (row disabled or missing): nothing is read or written, the answer says it was skipped;
//   NC-K3  switch ON: an unprocessed correction invalidates exactly the affected entry and is marked processed; a second call does nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryDb, type InMemoryDb } from '../support/inMemorySupabase';

let db: InMemoryDb;
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }));

import { POST } from '@/app/api/investment-intelligence/cron/nav2-correction-worker/route';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const req = (secret: string | null, body: unknown = {}) => new Request('http://t/cron', { method: 'POST', headers: secret ? { 'x-cron-secret': secret } : {}, body: JSON.stringify(body) });

function world(switchRow: Record<string, unknown> | null) {
  db = createInMemoryDb();
  db.reset({
    ii_reference_job_control: switchRow ? [switchRow] : [],
    nav2_correction_events: [{ id: 1, kind: 'nav_correction', instrument_id: A, benchmark_id: null, series_id: null, event_date: '2026-09-01', processed_at: null }],
    nav2_result_cache: [
      { cache_key: 'a', instrument_id: A, metric_id: 'scheme_performance_bundle', policy_version: 'p', definition_version: 'd', actual_end: '2026-10-02', benchmark_id: null, risk_free_dataset_id: null, invalidated_at: null },
      { cache_key: 'b', instrument_id: B, metric_id: 'scheme_performance_bundle', policy_version: 'p', definition_version: 'd', actual_end: '2026-10-02', benchmark_id: null, risk_free_dataset_id: null, invalidated_at: null },
    ],
    nav2_report_nav_dependencies: [],
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'right-secret';
  world({ job_key: 'nav2_correction_worker', enabled: true });
});

describe('correction worker route', () => {
  it('NC-K1: no secret or a wrong secret is 401 and reads nothing', async () => {
    expect((await POST(req(null))).status).toBe(401);
    expect((await POST(req('wrong'))).status).toBe(401);
    expect(db.reads).toEqual([]);
    expect(db.writes).toEqual([]);
  });

  it('NC-K2: switch OFF (disabled or missing) skips with no event read and no write', async () => {
    for (const row of [{ job_key: 'nav2_correction_worker', enabled: false }, null]) {
      world(row);
      const res = await POST(req('right-secret'));
      expect(res.status).toBe(200);
      expect((await res.json()).data.status).toBe('skipped_kill_switch');
      expect(db.reads.filter((t) => t === 'nav2_correction_events')).toEqual([]);
      expect(db.writes).toEqual([]);
    }
  });

  it('NC-K3: switch ON invalidates exactly the affected entry, marks the event processed, and is idempotent', async () => {
    const res = await POST(req('right-secret'));
    const body = (await res.json()).data;
    expect(body).toMatchObject({ status: 'completed', eventsProcessed: 1, entriesInvalidated: 1, failed: 0 });
    const by = Object.fromEntries(db.tables.nav2_result_cache.map((c) => [c.cache_key as string, c.invalidated_at]));
    expect(by.a).toBeTruthy();
    expect(by.b).toBeNull();
    expect((await (await POST(req('right-secret'))).json()).data).toMatchObject({ eventsProcessed: 0, entriesInvalidated: 0 });
  });

  it('an out-of-range limit falls back to the default instead of failing', async () => {
    const res = await POST(req('right-secret', { limit: 100000 }));
    expect(res.status).toBe(200);
  });
});
