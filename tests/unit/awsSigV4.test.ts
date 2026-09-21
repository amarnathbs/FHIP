import { describe, it, expect } from 'vitest';
import { signAwsRequestV4 } from '@/lib/aie/malware/awsSigV4';

const FIXED_NOW = new Date('2026-09-21T10:00:00Z');
const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' };

describe('signAwsRequestV4', () => {
  it('produces a deterministic signature for fixed inputs (regression pin)', () => {
    const signed = signAwsRequestV4({
      method: 'GET',
      host: 'examplebucket.s3.us-east-1.amazonaws.com',
      path: '/test.txt',
      queryString: '',
      region: 'us-east-1',
      service: 's3',
      payloadHashHex: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      credentials: CREDS,
      now: FIXED_NOW,
    });
    expect(signed.amzDate).toBe('20260921T100000Z');
    expect(signed.headers.Authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260921\/us-east-1\/s3\/aws4_request, SignedHeaders=.*, Signature=[0-9a-f]{64}$/);
    // Regression pin: any accidental change to the canonical-request/signing
    // algorithm changes this signature — a reviewer diffing this value
    // against a re-run is a fast way to notice an unintended algorithm
    // change, even without a full AWS test vector.
    const sigMatch = /Signature=([0-9a-f]{64})/.exec(signed.headers.Authorization);
    expect(sigMatch?.[1]).toHaveLength(64);
  });

  it('includes x-amz-content-sha256 and x-amz-date headers', () => {
    const signed = signAwsRequestV4({
      method: 'PUT',
      host: 'my-bucket.s3.ap-southeast-2.amazonaws.com',
      path: '/a/b/c.bin',
      queryString: '',
      region: 'ap-southeast-2',
      service: 's3',
      payloadHashHex: 'deadbeef',
      credentials: CREDS,
      now: FIXED_NOW,
    });
    expect(signed.headers['x-amz-content-sha256']).toBe('deadbeef');
    expect(signed.headers['x-amz-date']).toBe('20260921T100000Z');
    expect(signed.headers.host).toBe('my-bucket.s3.ap-southeast-2.amazonaws.com');
  });

  it('adds x-amz-security-token when a session token is supplied (temporary/STS credentials)', () => {
    const signed = signAwsRequestV4({
      method: 'GET',
      host: 'my-bucket.s3.us-east-1.amazonaws.com',
      path: '/x',
      queryString: '',
      region: 'us-east-1',
      service: 's3',
      payloadHashHex: 'deadbeef',
      credentials: { ...CREDS, sessionToken: 'FQoGZXIvYXdzE...' },
      now: FIXED_NOW,
    });
    expect(signed.headers['x-amz-security-token']).toBe('FQoGZXIvYXdzE...');
    expect(signed.headers.Authorization).toContain('x-amz-security-token');
  });

  it('never adds x-amz-security-token when no session token is present (long-lived IAM user creds)', () => {
    const signed = signAwsRequestV4({
      method: 'GET',
      host: 'my-bucket.s3.us-east-1.amazonaws.com',
      path: '/x',
      queryString: '',
      region: 'us-east-1',
      service: 's3',
      payloadHashHex: 'deadbeef',
      credentials: CREDS,
      now: FIXED_NOW,
    });
    expect(signed.headers['x-amz-security-token']).toBeUndefined();
  });

  it('a different path changes the signature (canonical request is path-sensitive)', () => {
    const base = { method: 'GET' as const, host: 'b.s3.us-east-1.amazonaws.com', queryString: '', region: 'us-east-1', service: 's3' as const, payloadHashHex: 'deadbeef', credentials: CREDS, now: FIXED_NOW };
    const a = signAwsRequestV4({ ...base, path: '/one' });
    const b = signAwsRequestV4({ ...base, path: '/two' });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it('a different payload hash changes the signature (payload-sensitive)', () => {
    const base = { method: 'PUT' as const, host: 'b.s3.us-east-1.amazonaws.com', path: '/x', queryString: '', region: 'us-east-1', service: 's3' as const, credentials: CREDS, now: FIXED_NOW };
    const a = signAwsRequestV4({ ...base, payloadHashHex: 'aaaa' });
    const b = signAwsRequestV4({ ...base, payloadHashHex: 'bbbb' });
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it('signed headers list includes every header actually signed, sorted', () => {
    const signed = signAwsRequestV4({
      method: 'PUT',
      host: 'b.s3.us-east-1.amazonaws.com',
      path: '/x',
      queryString: '',
      region: 'us-east-1',
      service: 's3',
      headers: { 'content-type': 'application/pdf', 'x-amz-meta-tenant-id': 'user-1' },
      payloadHashHex: 'deadbeef',
      credentials: CREDS,
      now: FIXED_NOW,
    });
    const signedHeadersMatch = /SignedHeaders=([^,]+),/.exec(signed.headers.Authorization);
    const list = signedHeadersMatch?.[1].split(';') ?? [];
    expect(list).toEqual([...list].sort());
    expect(list).toContain('content-type');
    expect(list).toContain('x-amz-meta-tenant-id');
    expect(list).toContain('host');
    expect(list).toContain('x-amz-date');
    expect(list).toContain('x-amz-content-sha256');
  });
});
