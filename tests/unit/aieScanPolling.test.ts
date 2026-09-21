import { describe, it, expect, vi } from 'vitest';
import { pollRealMalwareScanOnce, buildExpectedPendingScanObject, GUARD_DUTY_SCAN_STATUS_TAG_KEY } from '@/lib/aie/malware/scanPolling';
import type { RealScanObjectRef } from '@/lib/aie/malware/quarantineS3';
import type { RealMalwareScanAwsConfig } from '@/lib/aie/malware/config';

const REF: RealScanObjectRef = {
  bucket: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an',
  region: 'ap-southeast-2',
  accountId: '879807128139',
  objectKey: 'aie/user-1/doc-1/upload-1.bin',
  eTag: 'abc',
  versionId: 'v1',
};

const CONFIG: RealMalwareScanAwsConfig = {
  bucket: REF.bucket,
  region: REF.region,
  accountId: REF.accountId,
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  admissionWindowMinutes: 20,
};

const NOW = '2026-09-21T10:00:00Z';
const expected = buildExpectedPendingScanObject(REF, '2026-09-21T11:00:00Z');

function taggingXmlFor(value: string | null) {
  if (!value) return '<Tagging><TagSet/></Tagging>';
  return `<Tagging><TagSet><Tag><Key>${GUARD_DUTY_SCAN_STATUS_TAG_KEY}</Key><Value>${value}</Value></Tag></TagSet></Tagging>`;
}

function fetchReturning(bodies: Array<{ status: number; body?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = bodies[Math.min(call, bodies.length - 1)];
    call++;
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.body ?? '' } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('pollRealMalwareScanOnce', () => {
  it('a NO_THREATS_FOUND tag decides admit_extraction via the frozen decideScanResult', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('NO_THREATS_FOUND') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result).toEqual({ outcome: 'decided', decision: { outcome: 'admit_extraction', matchedVersionId: REF.versionId } });
  });

  it('a THREATS_FOUND tag decides block_threats_found', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('THREATS_FOUND') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('block_threats_found');
  });

  it('an UNSUPPORTED tag decides block_unsupported_or_access_denied (mapped to a SKIPPED scanStatus)', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('UNSUPPORTED') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('block_unsupported_or_access_denied');
  });

  it('a FAILED tag decides block_scan_incomplete', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('FAILED') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('block_scan_incomplete');
  });

  it('an absent tag across every attempt reports still_pending, never a fabricated decision', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor(null) }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 3, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result).toEqual({ outcome: 'still_pending' });
  });

  it('retries across attempts and picks up a tag that appears on a LATER attempt', async () => {
    const fetchImpl = fetchReturning([
      { status: 200, body: taggingXmlFor(null) },
      { status: 200, body: taggingXmlFor(null) },
      { status: 200, body: taggingXmlFor('NO_THREATS_FOUND') },
    ]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 3, delayMs: 0, fetchImpl, nowIso: NOW, sleepImpl: async () => {} });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('admit_extraction');
  });

  it('an unrecognised tag value is a poll_error, never treated as still-pending or as clean', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('SOMETHING_NEW_AWS_ADDED') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('poll_error');
  });

  it('a persistent network error is reported as poll_error after exhausting attempts', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: false, maxAttempts: 2, delayMs: 0, fetchImpl, nowIso: NOW, sleepImpl: async () => {} });
    expect(result.outcome).toBe('poll_error');
  });

  it('correlates against the CALLER-SUPPLIED expected identity, not a client-asserted one -- a mismatched bucket in the ref itself still blocks via decideScanResult', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('NO_THREATS_FOUND') }]);
    const mismatchedExpected = buildExpectedPendingScanObject({ ...REF, bucketName: 'attacker-bucket' } as unknown as RealScanObjectRef, expected.admissionDeadlineIso);
    // Force a mismatch between what the object ref reports and what the
    // caller's OWN recorded `expected` demands.
    const badExpected = { ...expected, bucketName: 'a-different-bucket-than-the-real-object' };
    const result = await pollRealMalwareScanOnce({ ref: REF, expected: badExpected, config: CONFIG, alreadyProcessed: false, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('block_identity_mismatch');
    void mismatchedExpected;
  });

  it('a duplicate already-processed decision is reported distinctly, never re-admitted as fresh', async () => {
    const fetchImpl = fetchReturning([{ status: 200, body: taggingXmlFor('NO_THREATS_FOUND') }]);
    const result = await pollRealMalwareScanOnce({ ref: REF, expected, config: CONFIG, alreadyProcessed: true, maxAttempts: 1, delayMs: 0, fetchImpl, nowIso: NOW });
    expect(result.outcome).toBe('decided');
    if (result.outcome === 'decided') expect(result.decision.outcome).toBe('duplicate_already_processed');
  });
});
