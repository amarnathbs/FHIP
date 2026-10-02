// BENCH-1 Phase 2 - the central entitlement evaluator (TypeScript mirror of the SQL benchmark_right_allowed()).
// H: rights are evaluated SEPARATELY; a public_open string alone and a licensed string alone establish nothing;
// unknown / blocked / expired / out-of-scope fail closed; post-expiry retention is honoured without blanket deletion.
import { describe, it, expect } from 'vitest';
import { ACTION_REQUIRED_RIGHTS, actionAllowed, describeMissingRights, entitlementGrants, rightAllowed, type BenchmarkIdentity, type EntitlementRecord } from '@/lib/services/investment-intelligence/benchmarkData/entitlements';
import { accessAllows, blockedReason, clampToScope, inDataScope, loadBenchmarkAccess, type BenchmarkAccess } from '@/lib/services/investment-intelligence/benchmarkAccess';

const ID: BenchmarkIdentity = { benchmarkId: 'b1', returnVariant: 'total_return', currencyCode: 'INR' };
const TODAY = '2026-10-01';
const rec = (o: Partial<EntitlementRecord> = {}): EntitlementRecord => ({
  id: 'e1', benchmarkId: 'b1', kind: 'commercial_licence', status: 'approved', returnVariant: 'total_return', currencyCode: 'INR',
  allowManualIngest: true, allowAutomation: false, allowStorage: true, allowCalculation: true, allowCustomerDisplay: true, allowReportExport: false,
  dataFrom: null, dataTo: null, validFrom: '2020-01-01', validTo: '2099-12-31', postExpiryStorage: 'retain', postExpiryCalculation: true, postExpiryDisplay: false, ...o,
});

describe('H: fail closed', () => {
  it('no record => every right is false', () => {
    for (const right of ['ingest_manual', 'automation', 'storage', 'calculation', 'customer_display', 'report_export'] as const) expect(rightAllowed(ID, [], { right, on: TODAY })).toBe(false);
  });
  it('draft and revoked records grant nothing', () => {
    for (const status of ['draft', 'revoked'] as const) {
      expect(rightAllowed(ID, [rec({ status })], { right: 'calculation', on: TODAY })).toBe(false);
      expect(entitlementGrants(rec({ status }), 'calculation', TODAY)).toBe(false);
    }
  });
  it('a record for ANOTHER benchmark grants nothing', () => {
    expect(rightAllowed(ID, [rec({ benchmarkId: 'other' })], { right: 'calculation', on: TODAY })).toBe(false);
  });
  it('variant mismatch (a PRICE entitlement is not a TRI entitlement) and currency mismatch grant nothing', () => {
    expect(rightAllowed(ID, [rec({ returnVariant: 'price' })], { right: 'calculation', on: TODAY })).toBe(false);
    expect(rightAllowed(ID, [rec({ currencyCode: 'USD' })], { right: 'calculation', on: TODAY })).toBe(false);
  });
  it('a catalogue row with no declared variant or currency has no rights even with an approved record', () => {
    expect(rightAllowed({ ...ID, returnVariant: null }, [rec()], { right: 'calculation', on: TODAY })).toBe(false);
    expect(rightAllowed({ ...ID, currencyCode: null }, [rec()], { right: 'calculation', on: TODAY })).toBe(false);
  });
  it('an unknown right or action is an error, never a silent false/true', () => {
    expect(() => rightAllowed(ID, [rec()], { right: 'everything' as never, on: TODAY })).toThrow(/unknown right/);
    expect(() => entitlementGrants(rec(), 'nope' as never, TODAY)).toThrow(/unknown right/);
    expect(() => actionAllowed(ID, [rec()], 'nope' as never, TODAY)).toThrow(/unknown action/);
  });
});

describe('H: rights are separate', () => {
  const r = rec({ allowManualIngest: false, allowStorage: true, allowCalculation: true, allowCustomerDisplay: false, allowAutomation: false });
  it('storage + calculation without ingestion cannot publish; without display cannot show a comparison; without export cannot export', () => {
    expect(actionAllowed(ID, [r], 'publish_manual', TODAY)).toEqual({ allowed: false, missing: ['ingest_manual'] });
    expect(actionAllowed(ID, [r], 'calculate', TODAY).allowed).toBe(true);
    expect(actionAllowed(ID, [r], 'display_comparison', TODAY)).toEqual({ allowed: false, missing: ['customer_display'] });
    expect(actionAllowed(ID, [rec()], 'export_report', TODAY)).toEqual({ allowed: false, missing: ['report_export'] });
    expect(actionAllowed(ID, [rec({ allowReportExport: true })], 'export_report', TODAY).allowed).toBe(true);
  });
  it('a manual-ingest licence is NOT automation permission', () => {
    expect(actionAllowed(ID, [rec()], 'publish_automated', TODAY)).toEqual({ allowed: false, missing: ['automation'] });
    expect(actionAllowed(ID, [rec({ allowAutomation: true })], 'publish_automated', TODAY).allowed).toBe(true);
  });
  it('the action table is the documented one', () => {
    expect(ACTION_REQUIRED_RIGHTS.publish_manual).toEqual(['ingest_manual', 'storage']);
    expect(ACTION_REQUIRED_RIGHTS.display_comparison).toEqual(['calculation', 'customer_display']);
  });
  it('commercial_licence and public_use_permission are evaluated identically: kind never grants a right by itself', () => {
    const none = rec({ kind: 'public_use_permission', allowCalculation: false, allowCustomerDisplay: false, allowManualIngest: false, allowStorage: false });
    for (const right of ['ingest_manual', 'storage', 'calculation', 'customer_display'] as const) expect(rightAllowed(ID, [none], { right, on: TODAY })).toBe(false);
  });
});

describe('H: term, post-expiry retention and data-date scope', () => {
  const expired = (o: Partial<EntitlementRecord> = {}) => rec({ validTo: '2026-06-30', ...o });
  it('expired: ingestion and automation stop; storage/calculation continue only under post-expiry retention; display only if retained+allowed', () => {
    const r = expired({ allowAutomation: true });
    expect(rightAllowed(ID, [r], { right: 'ingest_manual', on: TODAY })).toBe(false);
    expect(rightAllowed(ID, [r], { right: 'automation', on: TODAY })).toBe(false);
    expect(rightAllowed(ID, [r], { right: 'storage', on: TODAY })).toBe(true);
    expect(rightAllowed(ID, [r], { right: 'calculation', on: TODAY })).toBe(true);
    expect(rightAllowed(ID, [r], { right: 'customer_display', on: TODAY })).toBe(false);
    expect(rightAllowed(ID, [expired({ postExpiryDisplay: true })], { right: 'customer_display', on: TODAY })).toBe(true);
  });
  it('expired with post_expiry_storage = delete or unknown: nothing remains', () => {
    for (const postExpiryStorage of ['delete', 'unknown'] as const) {
      for (const right of ['storage', 'calculation', 'customer_display'] as const) expect(rightAllowed(ID, [expired({ postExpiryStorage })], { right, on: TODAY })).toBe(false);
    }
  });
  it('before valid_from nothing is granted', () => {
    expect(rightAllowed(ID, [rec({ validFrom: '2027-01-01' })], { right: 'calculation', on: TODAY })).toBe(false);
  });
  it('data-date scope: a requested range outside the entitled range is refused, inside is allowed', () => {
    const r = rec({ dataFrom: '2010-01-01', dataTo: '2020-12-31' });
    expect(rightAllowed(ID, [r], { right: 'calculation', on: TODAY, dataFrom: '2009-01-01', dataTo: '2012-01-01' })).toBe(false);
    expect(rightAllowed(ID, [r], { right: 'calculation', on: TODAY, dataFrom: '2010-06-01', dataTo: '2012-01-01' })).toBe(true);
    expect(rightAllowed(ID, [r], { right: 'calculation', on: TODAY, dataFrom: '2015-01-01', dataTo: '2021-06-01' })).toBe(false);
  });
  it('any ONE sufficient record is enough, but a record with the right for the wrong scope is not combined with another', () => {
    const narrow = rec({ id: 'n', dataFrom: '2010-01-01', dataTo: '2012-12-31' });
    const other = rec({ id: 'o', dataFrom: '2013-01-01', dataTo: '2020-12-31' });
    expect(rightAllowed(ID, [narrow, other], { right: 'calculation', on: TODAY, dataFrom: '2011-01-01', dataTo: '2012-01-01' })).toBe(true);
    expect(rightAllowed(ID, [narrow, other], { right: 'calculation', on: TODAY, dataFrom: '2011-01-01', dataTo: '2014-01-01' })).toBe(false);
  });
  it('describeMissingRights names each missing right and is empty when nothing is missing', () => {
    expect(describeMissingRights([])).toBe('');
    expect(describeMissingRights(['ingest_manual', 'storage'])).toMatch(/manual ingestion and storage/);
  });
});

describe('consumer gate (benchmarkAccess): fail closed, scope clamp, honest reasons', () => {
  const grant = (o: Partial<BenchmarkAccess> = {}): BenchmarkAccess => ({ benchmarkId: 'b1', canCalculate: true, canDisplay: true, canExport: false, dataFrom: null, dataTo: null, ...o });
  it('undefined access (unknown benchmark) is no access for every need', () => {
    for (const need of ['calculate', 'display_comparison', 'export'] as const) expect(accessAllows(undefined, need)).toBe(false);
  });
  it('a comparison needs calculation AND display; an export additionally needs the export right', () => {
    expect(accessAllows(grant({ canDisplay: false }), 'display_comparison')).toBe(false);
    expect(accessAllows(grant({ canCalculate: false }), 'display_comparison')).toBe(false);
    expect(accessAllows(grant(), 'display_comparison')).toBe(true);
    expect(accessAllows(grant(), 'export')).toBe(false);
    expect(accessAllows(grant({ canExport: true }), 'export')).toBe(true);
  });
  it('series points outside the entitled data-date scope are dropped; with no access nothing is returned', () => {
    const pts = [{ d: '2009-12-31' }, { d: '2010-06-01' }, { d: '2021-01-01' }];
    const a = grant({ dataFrom: '2010-01-01', dataTo: '2020-12-31' });
    expect(clampToScope(pts, a, (p) => p.d)).toEqual([{ d: '2010-06-01' }]);
    expect(inDataScope(a, '2010-01-01') && inDataScope(a, '2020-12-31')).toBe(true);
    expect(clampToScope(pts, undefined, (p) => p.d)).toEqual([]);
  });
  it('blockedReason is specific (no entitlement / not calculable / not displayable / not exportable / lookup failed) and never a number', () => {
    expect(blockedReason('X', undefined, 'display_comparison', null)).toMatch(/no approved entitlement covers/);
    expect(blockedReason('X', grant({ canCalculate: false }), 'display_comparison', null)).toMatch(/calculating/);
    expect(blockedReason('X', grant({ canDisplay: false }), 'display_comparison', null)).toMatch(/not customer display/);
    expect(blockedReason('X', grant(), 'export', null)).toMatch(/report\/export/);
    expect(blockedReason('X', grant(), 'display_comparison', 'rpc failed')).toMatch(/could not be checked/);
  });
  it('loadBenchmarkAccess: an RPC error blocks EVERYTHING (empty map + error), a missing function likewise', async () => {
    const failing = { rpc: async () => ({ data: null, error: { message: 'function does not exist' } }) };
    const r = await loadBenchmarkAccess(failing as never, ['b1', 'b2']);
    expect(r.access.size).toBe(0);
    expect(r.error).toMatch(/does not exist/);
    const ok = { rpc: async (_n: string, a: { p_benchmark_ids: string[] }) => ({ data: a.p_benchmark_ids.map((id) => ({ benchmark_id: id, can_calculate: true, can_display: true, can_export: false, data_from: null, data_to: null })), error: null }) };
    const g = await loadBenchmarkAccess(ok as never, ['b1', 'b1', 'b2']);
    expect([...g.access.keys()].sort()).toEqual(['b1', 'b2']);
    expect((await loadBenchmarkAccess(ok as never, [])).access.size).toBe(0);
  });
});
