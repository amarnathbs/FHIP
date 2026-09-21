import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { updateIntakeStatus, recordAieAuditEvent, recordMalwareScanState, initiateRealMalwareScan } = vi.hoisted(() => ({
  updateIntakeStatus: vi.fn(async () => ({ ok: true })),
  recordAieAuditEvent: vi.fn(async () => {}),
  recordMalwareScanState: vi.fn(async () => {}),
  initiateRealMalwareScan: vi.fn(),
}));

vi.mock('@/lib/aie/db/repository', () => ({ updateIntakeStatus }));
vi.mock('@/lib/aie/audit', () => ({ recordAieAuditEvent }));
vi.mock('@/lib/aie/malware/scanStateRepository', () => ({ recordMalwareScanState }));
vi.mock('@/lib/aie/malware/realScanGate', async () => {
  const actual = await vi.importActual<typeof import('@/lib/aie/malware/realScanGate')>('@/lib/aie/malware/realScanGate');
  return { ...actual, initiateRealMalwareScan };
});

import { runAieRealMalwareScanGate } from '@/lib/aie/malware/aieGateAdapter';

beforeEach(() => {
  updateIntakeStatus.mockClear();
  recordAieAuditEvent.mockClear();
  recordMalwareScanState.mockClear();
  initiateRealMalwareScan.mockReset();
});
afterEach(() => vi.clearAllMocks());

const REF = { bucket: 'b', region: 'r', accountId: 'a', objectKey: 'k', eTag: 'e', versionId: 'v' };
const EXPECTED = { accountId: 'a', region: 'r', bucketName: 'b', objectKey: 'k', expectedVersionId: 'v', expectedETag: 'e', admissionDeadlineIso: '2026-09-21T12:00:00Z' };

describe('runAieRealMalwareScanGate', () => {
  it('proceeds with ZERO extra DB writes when the flag is off (the column already defaults to not_required)', async () => {
    initiateRealMalwareScan.mockResolvedValue({ status: 'not_required' });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result).toEqual({ proceed: true });
    expect(updateIntakeStatus).not.toHaveBeenCalled();
    expect(recordMalwareScanState).not.toHaveBeenCalled();
  });

  it('proceeds without rejecting the intake when clean', async () => {
    initiateRealMalwareScan.mockResolvedValue({ status: 'clean', persisted: { status: 'clean', ref: REF, expected: EXPECTED } });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result).toEqual({ proceed: true });
    expect(updateIntakeStatus).not.toHaveBeenCalled();
  });

  it('rejects the intake with malware_detected for a malicious verdict', async () => {
    initiateRealMalwareScan.mockResolvedValue({ status: 'malicious', persisted: { status: 'malicious', ref: REF, expected: EXPECTED, threatNames: ['x'] } });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result).toEqual({ proceed: false, outcome: 'rejected', failureCode: 'malware_detected' });
    expect(updateIntakeStatus).toHaveBeenCalledWith({ intakeId: 'i1', toStatus: 'rejected', rejectionReason: 'malware_detected' });
  });

  it('returns pending_scan without rejecting the intake while the scan is genuinely pending', async () => {
    initiateRealMalwareScan.mockResolvedValue({ status: 'pending', persisted: { status: 'pending', ref: REF, expected: EXPECTED } });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result).toEqual({ proceed: false, outcome: 'pending_scan' });
    expect(updateIntakeStatus).not.toHaveBeenCalled();
  });

  it('rejects with malware_scan_failed for an early scan_failed with no object reference at all', async () => {
    initiateRealMalwareScan.mockResolvedValue({ status: 'scan_failed', detail: 'AWS configuration incomplete' });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result).toEqual({ proceed: false, outcome: 'rejected', failureCode: 'malware_scan_failed' });
    expect(updateIntakeStatus).toHaveBeenCalledWith({ intakeId: 'i1', toStatus: 'rejected', rejectionReason: 'malware_scan_failed' });
  });

  it.each(['suspicious', 'scan_failed', 'scan_timeout', 'unknown'] as const)('blocks for status=%s with a distinct failure code', async (status) => {
    initiateRealMalwareScan.mockResolvedValue({ status, persisted: { status, ref: REF, expected: EXPECTED } });
    const result = await runAieRealMalwareScanGate({ intakeId: 'i1', userId: 'u1', bytes: new Uint8Array([1]), contentHash: 'h' });
    expect(result.proceed).toBe(false);
    if (!result.proceed && result.outcome === 'rejected') expect(result.failureCode).toMatch(/^malware_/);
  });
});
