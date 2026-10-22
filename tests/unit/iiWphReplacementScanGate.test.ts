// Document2 (4) WP-H -- the real malware scan for a replacement copy runs BEFORE the copy is parsed, never writes to the document row,
// and fails closed. (scanReplacementCandidate / recordAdmittedReplacementScan in realScanAdmission.ts.)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enabled: true,
  verdict: { status: 'clean' } as { status: string; persisted?: unknown },
  initiated: [] as Record<string, unknown>[],
  recorded: [] as unknown[],
}));
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: () => { throw new Error('the document row must not be touched by the pre-attach scan'); } }) }));
vi.mock('@/lib/aie/malware/config', async (orig) => ({ ...(await orig<typeof import('@/lib/aie/malware/config')>()), isRealMalwareScanEnabled: () => h.enabled }));
vi.mock('@/lib/aie/malware/realScanGate', async (orig) => ({
  ...(await orig<typeof import('@/lib/aie/malware/realScanGate')>()),
  initiateRealMalwareScan: async (p: Record<string, unknown>) => {
    h.initiated.push(p);
    return h.verdict;
  },
}));
vi.mock('@/lib/aie/malware/scanStateRepository', () => ({
  recordMalwareScanState: async (table: string, id: string, state: unknown) => {
    h.recorded.push({ table, id, state });
  },
  getMalwareScanState: async () => null,
}));

import { scanReplacementCandidate, recordAdmittedReplacementScan } from '@/lib/services/investment-intelligence/realScanAdmission';

const params = { userId: 'u1', sourceDocumentId: 'doc1', bytes: new Uint8Array([1, 2, 3]), contentType: 'application/pdf', contentHash: 'abc', hasScanColumns: true };

beforeEach(() => {
  h.enabled = true;
  h.verdict = { status: 'clean', persisted: { status: 'clean', ref: {}, expected: {} } };
  h.initiated.length = 0;
  h.recorded.length = 0;
});

describe('scanReplacementCandidate', () => {
  it('scan switched OFF (the documented structural-only mode): admits without scanning anything', async () => {
    h.enabled = false;
    expect(await scanReplacementCandidate(params)).toEqual({ admitted: true, verdict: null });
    expect(h.initiated).toEqual([]);
  });
  it('clean: admitted, carrying the verdict to record once the copy is attached; the scan is for THESE bytes and THIS document, pipeline ii', async () => {
    const r = await scanReplacementCandidate(params);
    expect(r).toMatchObject({ admitted: true });
    expect(h.initiated).toEqual([{ pipeline: 'ii', userId: 'u1', documentId: 'doc1', bytes: params.bytes, contentType: 'application/pdf', contentHash: 'abc' }]);
    expect(h.recorded).toEqual([]); // nothing is written until the copy is attached
  });
  it.each([
    ['pending', 'pending'],
    ['malicious', 'blocked'],
    ['suspicious', 'blocked'],
    ['unknown', 'blocked'],
    ['scan_failed', 'scanner_unavailable'],
    ['scan_timeout', 'scanner_unavailable'],
  ])('%s -> not admitted (%s); fail closed, and the document row is never touched (the mocked client throws if it is)', async (status, reason) => {
    h.verdict = { status };
    expect(await scanReplacementCandidate(params)).toEqual({ admitted: false, reason });
  });
  it('the scan is on but the database cannot record a verdict (migration 0196 absent): fails closed without scanning', async () => {
    expect(await scanReplacementCandidate({ ...params, hasScanColumns: false })).toEqual({ admitted: false, reason: 'scanner_unavailable' });
    expect(h.initiated).toEqual([]);
  });
});

describe('recordAdmittedReplacementScan', () => {
  it('records the clean verdict on the attached document (which also deletes the scan copy); nothing when there was no scan', async () => {
    await recordAdmittedReplacementScan('doc1', { status: 'clean', persisted: { status: 'clean', ref: {} as never, expected: {} as never } });
    expect(h.recorded).toEqual([{ table: 'ii_source_documents', id: 'doc1', state: { status: 'clean', ref: {}, expected: {} } }]);
    h.recorded.length = 0;
    await recordAdmittedReplacementScan('doc1', null);
    expect(h.recorded).toEqual([]);
  });
});
