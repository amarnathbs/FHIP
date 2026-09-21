import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initiateRealMalwareScan, continuePollingRealMalwareScan, isRealScanStatusClean } from '@/lib/aie/malware/realScanGate';
import { GUARD_DUTY_SCAN_STATUS_TAG_KEY, buildExpectedPendingScanObject } from '@/lib/aie/malware/scanPolling';

const ENV_KEYS = ['AIE_REAL_MALWARE_SCAN_ENABLED', 'AIE_MALWARE_S3_BUCKET', 'AIE_MALWARE_S3_REGION', 'AIE_MALWARE_S3_ACCOUNT_ID', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setConfiguredAndEnabled() {
  process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
  process.env.AIE_MALWARE_S3_BUCKET = 'fhip-aie-dev-01-879807128139-ap-southeast-2-an';
  process.env.AIE_MALWARE_S3_REGION = 'ap-southeast-2';
  process.env.AIE_MALWARE_S3_ACCOUNT_ID = '879807128139';
  process.env.AWS_ACCESS_KEY_ID = 'AKID';
  process.env.AWS_SECRET_ACCESS_KEY = 'SECRET';
}

function taggingXmlFor(value: string | null) {
  if (!value) return '<Tagging><TagSet/></Tagging>';
  return `<Tagging><TagSet><Tag><Key>${GUARD_DUTY_SCAN_STATUS_TAG_KEY}</Key><Value>${value}</Value></Tag></TagSet></Tagging>`;
}

function fetchSequence(steps: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = steps[Math.min(call, steps.length - 1)];
    call++;
    return { ok: r.status < 300, status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? '' } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('initiateRealMalwareScan', () => {
  it('is a no-op returning not_required when the shared kill switch is off (shipped default)', async () => {
    delete process.env.AIE_REAL_MALWARE_SCAN_ENABLED;
    const result = await initiateRealMalwareScan({ pipeline: 'aie', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h' });
    expect(result).toEqual({ status: 'not_required' });
  });

  it('fails CLOSED (scan_failed) when the switch is on but AWS config is incomplete -- never silently degrades to not_required', async () => {
    process.env.AIE_REAL_MALWARE_SCAN_ENABLED = 'true';
    delete process.env.AIE_MALWARE_S3_BUCKET;
    const result = await initiateRealMalwareScan({ pipeline: 'aie', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h' });
    expect(result.status).toBe('scan_failed');
  });

  it('returns clean immediately when the scan resolves within the inline poll window', async () => {
    setConfiguredAndEnabled();
    const fetchImpl = fetchSequence([
      { status: 200, headers: { etag: '"e1"', 'x-amz-version-id': 'v1' } }, // PUT
      { status: 200, headers: { etag: '"e1"', 'x-amz-version-id': 'v1' } }, // HEAD
      { status: 200, body: taggingXmlFor('NO_THREATS_FOUND') }, // GET tagging
    ]);
    const result = await initiateRealMalwareScan({ pipeline: 'aie', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1, 2]), contentType: 'application/pdf', contentHash: 'h', fetchImpl });
    expect(result.status).toBe('clean');
    expect(isRealScanStatusClean(result.status)).toBe(true);
  });

  it('returns malicious when GuardDuty reports THREATS_FOUND within the inline window', async () => {
    setConfiguredAndEnabled();
    const fetchImpl = fetchSequence([
      { status: 200, headers: { etag: '"e1"' } },
      { status: 200, headers: { etag: '"e1"' } },
      { status: 200, body: taggingXmlFor('THREATS_FOUND') },
    ]);
    const result = await initiateRealMalwareScan({ pipeline: 'aie', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h', fetchImpl });
    expect(result.status).toBe('malicious');
    expect(isRealScanStatusClean(result.status)).toBe(false);
  });

  it('returns pending when the tag has not appeared by the end of the inline poll window', async () => {
    setConfiguredAndEnabled();
    const fetchImpl = fetchSequence([
      { status: 200, headers: { etag: '"e1"' } },
      { status: 200, headers: { etag: '"e1"' } },
      { status: 200, body: taggingXmlFor(null) },
    ]);
    const result = await initiateRealMalwareScan({ pipeline: 'aie', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h', fetchImpl });
    expect(result.status).toBe('pending');
    expect(isRealScanStatusClean(result.status)).toBe(false);
  });

  it('fails closed (scan_failed) when the upload to S3 itself fails', async () => {
    setConfiguredAndEnabled();
    const fetchImpl = fetchSequence([{ status: 500 }]);
    const result = await initiateRealMalwareScan({ pipeline: 'fdh3', userId: 'u1', documentId: 'd1', bytes: new Uint8Array([1]), contentType: 'application/pdf', contentHash: 'h', fetchImpl });
    expect(result.status).toBe('scan_failed');
  });
});

describe('continuePollingRealMalwareScan (cron-sweep path)', () => {
  const ref = { bucket: 'b', region: 'ap-southeast-2', accountId: '123', objectKey: 'k', eTag: 'e1', versionId: 'v1' };

  it('resolves to clean once the tag finally appears', async () => {
    setConfiguredAndEnabled();
    const expected = buildExpectedPendingScanObject(ref, new Date(Date.now() + 60_000).toISOString());
    const fetchImpl = fetchSequence([{ status: 200, body: taggingXmlFor('NO_THREATS_FOUND') }]);
    const result = await continuePollingRealMalwareScan({ persisted: { status: 'pending', ref, expected }, fetchImpl });
    expect(result.status).toBe('clean');
  });

  it('reports scan_timeout when still pending PAST the admission deadline, even though decideScanResult never saw an event', async () => {
    setConfiguredAndEnabled();
    const expiredDeadline = new Date(Date.now() - 60_000).toISOString();
    const expected = buildExpectedPendingScanObject(ref, expiredDeadline);
    const fetchImpl = fetchSequence([{ status: 200, body: taggingXmlFor(null) }]);
    const result = await continuePollingRealMalwareScan({ persisted: { status: 'pending', ref, expected }, fetchImpl });
    expect(result.status).toBe('scan_timeout');
  });

  it('stays pending when still unresolved and the deadline has not passed yet', async () => {
    setConfiguredAndEnabled();
    const expected = buildExpectedPendingScanObject(ref, new Date(Date.now() + 60_000).toISOString());
    const fetchImpl = fetchSequence([{ status: 200, body: taggingXmlFor(null) }]);
    const result = await continuePollingRealMalwareScan({ persisted: { status: 'pending', ref, expected }, fetchImpl });
    expect(result.status).toBe('pending');
  });
});
