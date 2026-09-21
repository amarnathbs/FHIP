import { describe, it, expect, vi } from 'vitest';
import { uploadForRealMalwareScan, buildRealScanObjectKey } from '@/lib/aie/malware/quarantineS3';
import type { RealMalwareScanAwsConfig } from '@/lib/aie/malware/config';

const CONFIG: RealMalwareScanAwsConfig = {
  bucket: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an',
  region: 'ap-southeast-2',
  accountId: '879807128139',
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  admissionWindowMinutes: 20,
};

function fakeFetchSequence(responses: Array<{ status: number; headers?: Record<string, string> }>) {
  let call = 0;
  return vi.fn(async () => {
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
      text: async () => '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('buildRealScanObjectKey', () => {
  it('scopes the object key by pipeline then userId then documentId first (no guessable cross-user path)', () => {
    const key = buildRealScanObjectKey('aie', 'user-123', 'doc-456');
    expect(key.startsWith('aie/user-123/doc-456/')).toBe(true);
  });

  it('two calls for the same document never collide (fresh UUID per upload attempt)', () => {
    const a = buildRealScanObjectKey('fdh3', 'user-1', 'doc-1');
    const b = buildRealScanObjectKey('fdh3', 'user-1', 'doc-1');
    expect(a).not.toBe(b);
  });
});

describe('uploadForRealMalwareScan', () => {
  it('returns not_configured when no AWS config is available', async () => {
    const result = await uploadForRealMalwareScan({
      pipeline: 'aie',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: null,
    });
    expect(result).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('uploads then independently verifies via HeadObject, returning a full object ref on success', async () => {
    const fetchImpl = fakeFetchSequence([
      { status: 200, headers: { etag: '"abc"', 'x-amz-version-id': 'v1' } }, // PUT
      { status: 200, headers: { etag: '"abc"', 'x-amz-version-id': 'v1', 'content-length': '3' } }, // HEAD
    ]);
    const result = await uploadForRealMalwareScan({
      pipeline: 'aie',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: CONFIG,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ref.bucket).toBe(CONFIG.bucket);
      expect(result.ref.region).toBe(CONFIG.region);
      expect(result.ref.accountId).toBe(CONFIG.accountId);
      expect(result.ref.eTag).toBe('abc');
      expect(result.ref.versionId).toBe('v1');
      expect(result.ref.objectKey.startsWith('aie/u1/d1/')).toBe(true);
    }
  });

  it('fails closed (verification_failed) when HeadObject reports a different ETag than PutObject claimed', async () => {
    const fetchImpl = fakeFetchSequence([
      { status: 200, headers: { etag: '"abc"' } }, // PUT claims abc
      { status: 200, headers: { etag: '"different"' } }, // HEAD reports something else
    ]);
    const result = await uploadForRealMalwareScan({
      pipeline: 'aie',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: CONFIG,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'verification_failed' });
  });

  it('fails closed (verification_failed) when HeadObject reports the object does not exist right after upload', async () => {
    const fetchImpl = fakeFetchSequence([{ status: 200, headers: { etag: '"abc"' } }, { status: 404 }]);
    const result = await uploadForRealMalwareScan({
      pipeline: 'aie',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: CONFIG,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'verification_failed' });
  });

  it('fails closed (upload_failed) when the PUT itself fails', async () => {
    const fetchImpl = fakeFetchSequence([{ status: 500 }]);
    const result = await uploadForRealMalwareScan({
      pipeline: 'aie',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: CONFIG,
      fetchImpl,
    });
    expect(result).toMatchObject({ ok: false, reason: 'upload_failed' });
  });

  it("represents a missing version id as the literal string 'null' (unversioned bucket support)", async () => {
    const fetchImpl = fakeFetchSequence([
      { status: 200, headers: { etag: '"abc"' } }, // no x-amz-version-id
      { status: 200, headers: { etag: '"abc"' } },
    ]);
    const result = await uploadForRealMalwareScan({
      pipeline: 'fdh3',
      userId: 'u1',
      documentId: 'd1',
      bytes: new Uint8Array([1]),
      contentType: 'application/pdf',
      contentHash: 'hash',
      config: CONFIG,
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.ref.versionId).toBe('null');
  });
});
