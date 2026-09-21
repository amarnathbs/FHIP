import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listPendingMalwareScans, recordMalwareScanState, continuePollingRealMalwareScan } = vi.hoisted(() => ({
  listPendingMalwareScans: vi.fn(),
  recordMalwareScanState: vi.fn(async () => {}),
  continuePollingRealMalwareScan: vi.fn(),
}));

vi.mock('@/lib/aie/malware/scanStateRepository', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aie/malware/scanStateRepository')>('@/lib/aie/malware/scanStateRepository');
  return { ...actual, listPendingMalwareScans, recordMalwareScanState };
});
vi.mock('@/lib/aie/malware/realScanGate', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aie/malware/realScanGate')>('@/lib/aie/malware/realScanGate');
  return { ...actual, continuePollingRealMalwareScan };
});

import { sweepPendingMalwareScans } from '@/lib/aie/malware/scanSweep';

const REF = { bucket: 'b', region: 'r', accountId: 'a', objectKey: 'k', eTag: 'e', versionId: 'v' };
const EXPECTED = { accountId: 'a', region: 'r', bucketName: 'b', objectKey: 'k', expectedVersionId: 'v', expectedETag: 'e', admissionDeadlineIso: '2026-09-21T12:00:00Z' };

beforeEach(() => {
  listPendingMalwareScans.mockReset();
  recordMalwareScanState.mockClear();
  continuePollingRealMalwareScan.mockReset();
});

describe('sweepPendingMalwareScans', () => {
  it('leaves still-pending rows alone and reports them as such', async () => {
    listPendingMalwareScans.mockResolvedValue([{ id: 'd1', status: 'pending', ref: REF, expected: EXPECTED, threatNames: null, detail: null, admissionDeadlineAt: EXPECTED.admissionDeadlineIso, decidedAt: null }]);
    continuePollingRealMalwareScan.mockResolvedValue({ status: 'pending', persisted: { status: 'pending', ref: REF, expected: EXPECTED } });
    const result = await sweepPendingMalwareScans('aie_document_intake');
    expect(result.stillPending).toBe(1);
    expect(result.resolvedClean).toEqual([]);
    expect(recordMalwareScanState).not.toHaveBeenCalled();
  });

  it('records and reports a row that resolves clean', async () => {
    listPendingMalwareScans.mockResolvedValue([{ id: 'd1', status: 'pending', ref: REF, expected: EXPECTED, threatNames: null, detail: null, admissionDeadlineAt: null, decidedAt: null }]);
    continuePollingRealMalwareScan.mockResolvedValue({ status: 'clean', persisted: { status: 'clean', ref: REF, expected: EXPECTED } });
    const result = await sweepPendingMalwareScans('fdh_statement_uploads');
    expect(result.resolvedClean).toEqual(['d1']);
    expect(recordMalwareScanState).toHaveBeenCalledWith('fdh_statement_uploads', 'd1', expect.objectContaining({ status: 'clean' }));
  });

  it('records and reports a row that resolves to a blocking status with its mapped failure code', async () => {
    listPendingMalwareScans.mockResolvedValue([{ id: 'd1', status: 'pending', ref: REF, expected: EXPECTED, threatNames: null, detail: null, admissionDeadlineAt: null, decidedAt: null }]);
    continuePollingRealMalwareScan.mockResolvedValue({ status: 'scan_timeout', persisted: { status: 'scan_timeout', ref: REF, expected: EXPECTED } });
    const result = await sweepPendingMalwareScans('aie_document_intake');
    expect(result.resolvedBlocked).toEqual([{ id: 'd1', failureCode: 'malware_scan_timeout' }]);
  });

  it('fails closed (unknown) for a pending row that is missing its own object reference -- a data inconsistency, never left silently pending forever', async () => {
    listPendingMalwareScans.mockResolvedValue([{ id: 'd1', status: 'pending', ref: null, expected: null, threatNames: null, detail: null, admissionDeadlineAt: null, decidedAt: null }]);
    const result = await sweepPendingMalwareScans('aie_document_intake');
    expect(result.resolvedBlocked).toEqual([{ id: 'd1', failureCode: 'malware_scan_unknown' }]);
    expect(continuePollingRealMalwareScan).not.toHaveBeenCalled();
  });

  it('returns scanned:0 with an empty pending queue', async () => {
    listPendingMalwareScans.mockResolvedValue([]);
    const result = await sweepPendingMalwareScans('aie_document_intake');
    expect(result).toEqual({ scanned: 0, resolvedClean: [], resolvedBlocked: [], stillPending: 0 });
  });
});
