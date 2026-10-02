// India MF report header index closes (Nifty 50 / BSE Sensex price index) are CUSTOMER-VISIBLE report content.
// The series row-level security only proves the 'calculation' right, so the reader itself must also require the
// approved customer-display AND report-export rights (benchmark_entitled_actions, migration 0241), stay inside the
// entitlement's data-date scope, and fail closed. A close is never shown on the strength of data being present.
import { describe, it, expect } from 'vitest';
import { fakeSupabase } from '../fixtures/fakeSupabase';
import { latestIndexCloseOnOrBefore, loadIndexCloses } from '@/lib/services/investment-intelligence/marketIndex/indexCloseReader';

const tables = () => ({
  ii_benchmarks: [
    { id: 'b-n', benchmark_key: 'IN_NIFTY_50_PRI' },
    { id: 'b-s', benchmark_key: 'IN_SENSEX_PRI' },
  ],
  ii_benchmark_series: [
    { benchmark_id: 'b-n', series_date: '2026-09-30', value: 22620.45, quality_status: 'ok' },
    { benchmark_id: 'b-n', series_date: '2026-10-01', value: 22421.95, quality_status: 'ok' },
    { benchmark_id: 'b-s', series_date: '2026-10-01', value: 71909.7, quality_status: 'ok' },
  ],
});
const grant = (o: Record<string, unknown> = {}) => ({ can_calculate: true, can_display: true, can_export: true, data_from: null, data_to: null, ...o });
const rpcFor = (g: Record<string, unknown> | null, error?: string) => (name: string, args: Record<string, unknown>) =>
  error ? { data: null, error: { message: error } } : { data: g ? (args.p_benchmark_ids as string[]).map((id) => ({ benchmark_id: id, ...g })) : [], error: null };
const nifty = (rpc: ReturnType<typeof rpcFor>) => latestIndexCloseOnOrBefore(fakeSupabase(tables(), { rpc }).client, 'IN_NIFTY_50_PRI', '2026-10-01');

describe('index close reader: entitlement gate', () => {
  it('entitled (calculation + display + export): the latest eligible close is returned with its real market date', async () => {
    expect(await nifty(rpcFor(grant()))).toEqual({ date: '2026-10-01', value: 22421.95 });
  });
  it('NEGATIVE: no approved entitlement at all => null (not available), although the series rows exist', async () => {
    expect(await nifty(rpcFor(null))).toBeNull();
  });
  it('NEGATIVE: calculation only (display not granted) => null', async () => {
    expect(await nifty(rpcFor(grant({ can_display: false, can_export: false })))).toBeNull();
  });
  it('NEGATIVE: display granted but report export NOT granted => null (a report is an export)', async () => {
    expect(await nifty(rpcFor(grant({ can_export: false })))).toBeNull();
  });
  it('NEGATIVE: the entitlement lookup fails => null, never a number', async () => {
    expect(await nifty(rpcFor(grant(), 'rpc exploded'))).toBeNull();
  });
  it('NEGATIVE: a client without rpc fails closed (null), never throws', async () => {
    const t = tables();
    const noRpc = { from: (fakeSupabase(t).client as unknown as { from: (x: string) => unknown }).from } as never;
    expect(await latestIndexCloseOnOrBefore(noRpc, 'IN_NIFTY_50_PRI', '2026-10-01')).toBeNull();
  });
  it('data-date scope: an entitlement ending 2026-09-30 yields the 09-30 close, not the later one', async () => {
    expect(await nifty(rpcFor(grant({ data_to: '2026-09-30' })))).toEqual({ date: '2026-09-30', value: 22620.45 });
  });
  it('data-date scope: an entitlement starting after every available close yields null', async () => {
    expect(await nifty(rpcFor(grant({ data_from: '2026-10-02' })))).toBeNull();
  });
  it('loadIndexCloses is per index: both entitled => both shown; both un-entitled => both null', async () => {
    const both = await loadIndexCloses(fakeSupabase(tables(), { rpc: rpcFor(grant()) }).client, '2026-10-01');
    expect(both).toEqual({ sensex: { date: '2026-10-01', value: 71909.7 }, nifty: { date: '2026-10-01', value: 22421.95 } });
    const none = await loadIndexCloses(fakeSupabase(tables(), { rpc: rpcFor(null) }).client, '2026-10-01');
    expect(none).toEqual({ sensex: null, nifty: null });
  });
});
