import { describe, it, expect, vi } from 'vitest';
import { putObjectToS3, getObjectTaggingFromS3, headObjectInS3, parseTaggingXml } from '@/lib/aie/malware/s3RestClient';

const CREDS = { accessKeyId: 'AKID', secretAccessKey: 'SECRET' };
const LOCATION = { bucket: 'fhip-aie-dev-01-879807128139-ap-southeast-2-an', region: 'ap-southeast-2' };

function fakeFetch(responses: Array<{ status: number; headers?: Record<string, string>; body?: string }>) {
  let call = 0;
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const r = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (name: string) => r.headers?.[name.toLowerCase()] ?? null },
      text: async () => r.body ?? '',
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, requests };
}

describe('putObjectToS3', () => {
  it('returns the ETag and version id from a successful PUT', async () => {
    const { impl, requests } = fakeFetch([{ status: 200, headers: { etag: '"abc123"', 'x-amz-version-id': 'v1' } }]);
    const result = await putObjectToS3({
      location: LOCATION,
      key: 'aie/user-1/doc-1/upload-1.bin',
      bytes: new Uint8Array([1, 2, 3]),
      contentType: 'application/pdf',
      metadata: { pipeline: 'aie', 'document-id': 'doc-1' },
      credentials: CREDS,
      fetchImpl: impl,
    });
    expect(result).toEqual({ ok: true, eTag: 'abc123', versionId: 'v1' });
    expect(requests[0].init.method).toBe('PUT');
    expect(requests[0].url).toContain('fhip-aie-dev-01-879807128139-ap-southeast-2-an.s3.ap-southeast-2.amazonaws.com');
  });

  it('signs the request with a real Authorization header', async () => {
    const { impl, requests } = fakeFetch([{ status: 200, headers: { etag: '"x"' } }]);
    await putObjectToS3({ location: LOCATION, key: 'k', bytes: new Uint8Array(), contentType: 'application/pdf', metadata: {}, credentials: CREDS, fetchImpl: impl });
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^AWS4-HMAC-SHA256/);
  });

  it('carries metadata as x-amz-meta-* headers', async () => {
    const { impl, requests } = fakeFetch([{ status: 200, headers: { etag: '"x"' } }]);
    await putObjectToS3({ location: LOCATION, key: 'k', bytes: new Uint8Array(), contentType: 'application/pdf', metadata: { 'tenant-id': 'user-42' }, credentials: CREDS, fetchImpl: impl });
    const headers = requests[0].init.headers as Record<string, string>;
    expect(headers['x-amz-meta-tenant-id']).toBe('user-42');
  });

  it('fails with a message (never throws) on a non-2xx response', async () => {
    const { impl } = fakeFetch([{ status: 403, body: 'AccessDenied' }]);
    const result = await putObjectToS3({ location: LOCATION, key: 'k', bytes: new Uint8Array(), contentType: 'application/pdf', metadata: {}, credentials: CREDS, fetchImpl: impl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.httpStatus).toBe(403);
  });

  it('fails when the response carries no ETag at all', async () => {
    const { impl } = fakeFetch([{ status: 200, headers: {} }]);
    const result = await putObjectToS3({ location: LOCATION, key: 'k', bytes: new Uint8Array(), contentType: 'application/pdf', metadata: {}, credentials: CREDS, fetchImpl: impl });
    expect(result.ok).toBe(false);
  });

  it('reports a network error distinctly rather than throwing', async () => {
    const impl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const result = await putObjectToS3({ location: LOCATION, key: 'k', bytes: new Uint8Array(), contentType: 'application/pdf', metadata: {}, credentials: CREDS, fetchImpl: impl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('ECONNRESET');
  });
});

describe('parseTaggingXml', () => {
  it('parses a real GetObjectTagging response shape', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Tagging><TagSet><Tag><Key>GuardDutyMalwareScanStatus</Key><Value>NO_THREATS_FOUND</Value></Tag></TagSet></Tagging>`;
    expect(parseTaggingXml(xml)).toEqual({ GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' });
  });

  it('parses multiple tags', () => {
    const xml = `<Tagging><TagSet><Tag><Key>a</Key><Value>1</Value></Tag><Tag><Key>b</Key><Value>2</Value></Tag></TagSet></Tagging>`;
    expect(parseTaggingXml(xml)).toEqual({ a: '1', b: '2' });
  });

  it('returns an empty object for an object with no tags', () => {
    expect(parseTaggingXml('<Tagging><TagSet/></Tagging>')).toEqual({});
  });

  it('decodes XML entities in tag values', () => {
    const xml = `<Tagging><TagSet><Tag><Key>k</Key><Value>a &amp; b</Value></Tag></TagSet></Tagging>`;
    expect(parseTaggingXml(xml)).toEqual({ k: 'a & b' });
  });
});

describe('getObjectTaggingFromS3', () => {
  it('returns parsed tags for the exact bucket/key/versionId requested', async () => {
    const xml = '<Tagging><TagSet><Tag><Key>GuardDutyMalwareScanStatus</Key><Value>NO_THREATS_FOUND</Value></Tag></TagSet></Tagging>';
    const { impl, requests } = fakeFetch([{ status: 200, body: xml }]);
    const result = await getObjectTaggingFromS3({ location: LOCATION, key: 'k', versionId: 'v1', credentials: CREDS, fetchImpl: impl });
    expect(result).toEqual({ ok: true, tags: { GuardDutyMalwareScanStatus: 'NO_THREATS_FOUND' } });
    expect(requests[0].url).toContain('tagging=');
    expect(requests[0].url).toContain('versionId=v1');
  });

  it('reports failure distinctly for a 404 (object not found)', async () => {
    const { impl } = fakeFetch([{ status: 404, body: 'NoSuchKey' }]);
    const result = await getObjectTaggingFromS3({ location: LOCATION, key: 'k', credentials: CREDS, fetchImpl: impl });
    expect(result.ok).toBe(false);
  });
});

describe('headObjectInS3', () => {
  it('reports exists:false for a 404', async () => {
    const { impl } = fakeFetch([{ status: 404 }]);
    const result = await headObjectInS3({ location: LOCATION, key: 'k', credentials: CREDS, fetchImpl: impl });
    expect(result).toEqual({ ok: true, exists: false });
  });

  it('reports the ETag/versionId/size for an existing object', async () => {
    const { impl } = fakeFetch([{ status: 200, headers: { etag: '"e1"', 'x-amz-version-id': 'v9', 'content-length': '1024' } }]);
    const result = await headObjectInS3({ location: LOCATION, key: 'k', credentials: CREDS, fetchImpl: impl });
    expect(result).toEqual({ ok: true, exists: true, eTag: 'e1', versionId: 'v9', contentLength: 1024 });
  });
});
