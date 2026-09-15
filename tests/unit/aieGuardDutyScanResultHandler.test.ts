/**
 * M12D TRACEABILITY — Product-Owner requirement ids this file is evidence for.
 *
 * Added by the M12 Phase D mapping pass. Each id below was checked against this
 * file's ACTUAL assertions; ids it only touches incidentally are deliberately
 * omitted, and where this file does NOT discharge a neighbouring requirement,
 * that is said so explicitly rather than left to be assumed.
 * Full matrix: docs/aie-programme/AIE_1_REQUIREMENT_TRACEABILITY_FINAL_2026-09-15.md
 *
 *   AIE11-QUA-03     Malware scanning with signature/version recorded, failing closed
 *                    on scanner failure. IMPORTANT: this suite proves the DECISION
 *                    FUNCTION only — it has zero production callers and no scanner
 *                    exists (PO-BLOCKER-1 / OA-2a).
 *   AIE16-PDF-08     Verify malware scanner failure is fail-closed according to policy
 *                    — proven in isolation, never in a live pipeline.
 */
/**
 * AIE-1 closure mission (section 6, section 14.A) — the GuardDuty
 * scan-result decision gate. Pure-logic tests against AWS's real,
 * documented event shapes (see scanResultTypes.ts's header for the exact
 * source). No AWS credentials exist in this environment -- this is BLOCKED
 * from real-GuardDuty verification and reported as such; these tests prove
 * the decision logic itself is correct against the documented contract.
 */
import { describe, it, expect } from 'vitest';
import { decideScanResult, type ExpectedPendingScanObject } from '@/lib/aie/malware/scanResultHandler';
import type { GuardDutyObjectScanResultEvent } from '@/lib/aie/malware/scanResultTypes';

const EXPECTED: ExpectedPendingScanObject = {
  accountId: '111122223333',
  region: 'us-east-1',
  bucketName: 'aie-quarantine-dev',
  objectKey: 'tenant-a/intake-1/intake-1.bin',
  expectedVersionId: 'v1-clean',
  expectedETag: 'etag-v1',
  admissionDeadlineIso: '2026-09-13T12:00:00Z',
};

function baseEvent(overrides: Partial<GuardDutyObjectScanResultEvent['detail']> = {}, envelopeOverrides: Partial<GuardDutyObjectScanResultEvent> = {}): GuardDutyObjectScanResultEvent {
  return {
    version: '0',
    id: 'event-1',
    'detail-type': 'GuardDuty Malware Protection Object Scan Result',
    source: 'aws.guardduty',
    account: EXPECTED.accountId,
    time: '2026-09-13T10:00:00Z',
    region: EXPECTED.region,
    resources: ['arn:aws:guardduty:us-east-1:111122223333:malware-protection-plan/plan-1'],
    detail: {
      schemaVersion: '1.0',
      scanStatus: 'COMPLETED',
      resourceType: 'S3_OBJECT',
      s3ObjectDetails: {
        bucketName: EXPECTED.bucketName,
        objectKey: EXPECTED.objectKey,
        eTag: EXPECTED.expectedETag,
        versionId: EXPECTED.expectedVersionId,
        s3Throttled: false,
      },
      scanResultDetails: { scanResultStatus: 'NO_THREATS_FOUND', threats: null, statusReasons: null },
      ...overrides,
    },
    ...envelopeOverrides,
  };
}

const NOW = '2026-09-13T10:00:01Z';

describe('decideScanResult — mission section 14.A required security evidence', () => {
  it('A. a clean scan for the exact expected object is admitted', () => {
    const decision = decideScanResult(baseEvent(), EXPECTED, false, NOW);
    expect(decision.outcome).toBe('admit_extraction');
  });

  it('A. THREATS_FOUND is blocked unconditionally, threat names surfaced', () => {
    const event = baseEvent({
      scanResultDetails: {
        scanResultStatus: 'THREATS_FOUND',
        threats: [{ name: 'EICAR-Test-File (not a virus)', source: 'AMAZON', itemDetails: [{ hash: 'x', itemPath: 'y' }] }],
        statusReasons: null,
      },
    });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_threats_found');
    if (decision.outcome === 'block_threats_found') {
      expect(decision.threatNames).toEqual(['EICAR-Test-File (not a virus)']);
    }
  });

  it('A. FAILED scan status blocks (never treated as clean)', () => {
    const event = baseEvent({ scanStatus: 'FAILED', scanResultDetails: { scanResultStatus: 'FAILED', threats: null, statusReasons: null } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_scan_incomplete');
  });

  it('A. SKIPPED (UNSUPPORTED, e.g. password-protected) blocks with the reason surfaced', () => {
    const event = baseEvent({ scanStatus: 'SKIPPED', scanResultDetails: { scanResultStatus: 'UNSUPPORTED', threats: null, statusReasons: ['PASSWORD_PROTECTED'] } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_unsupported_or_access_denied');
    if (decision.outcome === 'block_unsupported_or_access_denied') {
      expect(decision.reasons).toEqual(['PASSWORD_PROTECTED']);
    }
  });

  it('A. SKIPPED (ACCESS_DENIED) blocks', () => {
    const event = baseEvent({ scanStatus: 'SKIPPED', scanResultDetails: { scanResultStatus: 'ACCESS_DENIED', threats: null, statusReasons: ['SSE_C_ENCRYPTED_OBJECT'] } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_unsupported_or_access_denied');
  });

  it('A. a forged/mismatched event (wrong bucket) is rejected, never coerced into matching', () => {
    const event = baseEvent({ s3ObjectDetails: { ...baseEvent().detail.s3ObjectDetails, bucketName: 'attacker-controlled-bucket' } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });

  it('A. a forged/mismatched event (wrong AWS account) is rejected', () => {
    const event = baseEvent({}, { account: '999999999999' });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });

  it('A. a forged/mismatched event (wrong region) is rejected', () => {
    const event = baseEvent({}, { region: 'eu-west-1' });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });

  it('A. a forged/mismatched event (wrong object key) is rejected', () => {
    const event = baseEvent({ s3ObjectDetails: { ...baseEvent().detail.s3ObjectDetails, objectKey: 'tenant-b/other-intake/x.bin' } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });

  it('A. an OLD clean scan cannot release REPLACEMENT bytes -- version id mismatch is rejected even though the scan itself says clean', () => {
    const event = baseEvent({ s3ObjectDetails: { ...baseEvent().detail.s3ObjectDetails, versionId: 'v0-stale-clean-scan' } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
    if (decision.outcome === 'block_identity_mismatch') {
      expect(decision.reason).toMatch(/version/i);
    }
  });

  it('A. an eTag mismatch alone (same versionId) is also rejected -- defense in depth for unversioned buckets', () => {
    const event = baseEvent({ s3ObjectDetails: { ...baseEvent().detail.s3ObjectDetails, eTag: 'different-etag' } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });

  it('D. duplicate delivery of an already-processed clean result is reported distinctly, never re-admitted as a fresh event', () => {
    const decision = decideScanResult(baseEvent(), EXPECTED, true, NOW);
    expect(decision.outcome).toBe('duplicate_already_processed');
  });

  it('a clean result delivered after the admission deadline is blocked, not admitted', () => {
    const decision = decideScanResult(baseEvent(), EXPECTED, false, '2026-09-13T13:00:00Z');
    expect(decision.outcome).toBe('block_deadline_expired');
  });

  it('an unrecognised scanResultStatus on a COMPLETED scan fails closed rather than being admitted', () => {
    const event = baseEvent({ scanResultDetails: { scanResultStatus: 'SOMETHING_NEW_AWS_ADDED' as never, threats: null, statusReasons: null } });
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_unsupported_or_access_denied');
  });

  it('identity checks are evaluated before the scan result -- a mismatched-identity THREATS_FOUND event is reported as identity_mismatch, not threats_found (never trust content of a forged event)', () => {
    const event = baseEvent(
      { scanResultDetails: { scanResultStatus: 'THREATS_FOUND', threats: [{ name: 'x', source: 'y', itemDetails: [] }], statusReasons: null } },
      { account: '000000000000' },
    );
    const decision = decideScanResult(event, EXPECTED, false, NOW);
    expect(decision.outcome).toBe('block_identity_mismatch');
  });
});
