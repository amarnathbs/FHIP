import { describe, it, expect } from 'vitest';
import { validateUploadedFile, generateObjectKey, MAX_FILE_SIZE_BYTES } from '@/lib/services/investment-intelligence/storage';

describe('validateUploadedFile (spec section 15 — file validation shell)', () => {
  it('accepts a valid PDF', () => {
    expect(validateUploadedFile({ filename: 'statement.pdf', mimeType: 'application/pdf', sizeBytes: 1024 }).ok).toBe(true);
  });

  it('accepts a valid CSV', () => {
    expect(validateUploadedFile({ filename: 'holdings.csv', mimeType: 'text/csv', sizeBytes: 512 }).ok).toBe(true);
  });

  it('rejects an unsupported extension', () => {
    const result = validateUploadedFile({ filename: 'malware.exe', mimeType: 'application/pdf', sizeBytes: 1024 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/extension/i);
  });

  it('rejects an unsupported MIME type even with an allowed-looking extension', () => {
    const result = validateUploadedFile({ filename: 'statement.pdf', mimeType: 'application/x-msdownload', sizeBytes: 1024 });
    expect(result.ok).toBe(false);
  });

  it('rejects a mismatched extension/MIME pair (renamed-executable gap)', () => {
    // A ".pdf" filename carrying a CSV MIME type (or vice versa) is exactly
    // the "trust filename alone" gap spec section 15 requires closing.
    const result = validateUploadedFile({ filename: 'fake.pdf', mimeType: 'text/csv', sizeBytes: 1024 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/do not match/i);
  });

  it('rejects an empty file', () => {
    expect(validateUploadedFile({ filename: 'empty.pdf', mimeType: 'application/pdf', sizeBytes: 0 }).ok).toBe(false);
  });

  it('rejects a file over the configured size limit', () => {
    const result = validateUploadedFile({ filename: 'huge.pdf', mimeType: 'application/pdf', sizeBytes: MAX_FILE_SIZE_BYTES + 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exceeds/i);
  });

  it('accepts a file exactly at the size limit', () => {
    expect(validateUploadedFile({ filename: 'atlimit.pdf', mimeType: 'application/pdf', sizeBytes: MAX_FILE_SIZE_BYTES }).ok).toBe(true);
  });
});

describe('generateObjectKey (never trusts a user-provided filename as the storage path)', () => {
  it('scopes the object key by user_id first (cross-user path guess is non-functional)', () => {
    const key = generateObjectKey('user-123', 'statement.pdf');
    expect(key.startsWith('user-123/')).toBe(true);
  });

  it('never embeds the raw user-provided filename in the key', () => {
    const key = generateObjectKey('user-123', 'my very (sensitive!) statement.pdf');
    expect(key).not.toContain('my very');
    expect(key).not.toContain('sensitive');
  });

  it('preserves only the file extension from the original filename', () => {
    const key = generateObjectKey('user-123', 'holdings.csv');
    expect(key.endsWith('.csv')).toBe(true);
  });

  it('generates a distinct key on every call (no collision across repeated uploads)', () => {
    const a = generateObjectKey('user-123', 'statement.pdf');
    const b = generateObjectKey('user-123', 'statement.pdf');
    expect(a).not.toBe(b);
  });
});
