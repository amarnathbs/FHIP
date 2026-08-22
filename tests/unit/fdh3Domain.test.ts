/**
 * FDH-3 — pure domain-logic tests: file validation, upload-session rules,
 * derived upload substates, the widened document lifecycle, and retention
 * due-date arithmetic. No database, no network, no mocked service — these
 * exercise real functions with real inputs, per the project's convention
 * that domain modules are unit-tested directly.
 */

import { describe, expect, it } from 'vitest';
import {
  detectFileTypeFromBytes,
  FDH_MAX_FILE_SIZE_BYTES,
  isPdfLikelyPasswordProtected,
  looksLikePdf,
  looksLikeText,
  sha256Hex,
  validateUploadedFile,
} from '@/lib/financial-data-hub/domain/fileValidation';
import {
  assertSessionIsLive,
  buildOpaqueStorageKey,
  computeSessionExpiry,
  FdhUploadSessionError,
  isAllowedSessionTransition,
  isSessionExpired,
  UPLOAD_SESSION_TTL_MINUTES,
} from '@/lib/financial-data-hub/domain/uploadSession';
import {
  deriveDocumentStatusLabel,
  deriveUploadSubstate,
} from '@/lib/financial-data-hub/domain/uploadSubstate';
import {
  DOCUMENT_STATUS_TRANSITIONS,
  isAllowedDocumentTransition,
} from '@/lib/financial-data-hub/domain/documentLifecycle';
import { computePurgeDueDate, FDH_DOCUMENT_RETENTION_DAYS } from '@/lib/financial-data-hub/constants/retention';
import { FDH_PROCESSING_STATUSES } from '@/lib/financial-data-hub/constants/enums';

// A minimal, syntactically real (if tiny) synthetic PDF — not a scan of any
// real document. `%PDF-1.4` header, one empty page, `%%EOF` trailer.
const SYNTHETIC_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  'ascii',
);
const SYNTHETIC_ENCRYPTED_PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R/Encrypt 4 0 R>>\n%%EOF',
  'ascii',
);
const SYNTHETIC_CSV = Buffer.from('date,description,amount\n2026-01-01,Sample,10.00\n', 'utf8');

describe('FDH-3 file-signature detection', () => {
  it('recognises a real PDF magic header', () => {
    expect(looksLikePdf(SYNTHETIC_PDF)).toBe(true);
    expect(looksLikePdf(SYNTHETIC_CSV)).toBe(false);
  });

  it('recognises plausible text for CSV', () => {
    expect(looksLikeText(SYNTHETIC_CSV)).toBe(true);
  });

  it('rejects a binary file (e.g. a renamed executable) as text', () => {
    const fakeExe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00]); // "MZ" header
    expect(looksLikeText(fakeExe)).toBe(false);
    expect(looksLikePdf(fakeExe)).toBe(false);
    expect(detectFileTypeFromBytes(fakeExe)).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(detectFileTypeFromBytes(new Uint8Array(0))).toBeNull();
  });

  it('detects the /Encrypt token in a password-protected PDF trailer', () => {
    expect(isPdfLikelyPasswordProtected(SYNTHETIC_ENCRYPTED_PDF)).toBe(true);
    expect(isPdfLikelyPasswordProtected(SYNTHETIC_PDF)).toBe(false);
  });

  it('produces a stable, correctly-shaped sha-256 hex digest', () => {
    const hash = sha256Hex(SYNTHETIC_PDF);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex(SYNTHETIC_PDF)).toBe(hash); // deterministic
    expect(sha256Hex(SYNTHETIC_CSV)).not.toBe(hash); // content-sensitive
  });
});

describe('FDH-3 full upload validation pipeline', () => {
  it('accepts a valid PDF', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: SYNTHETIC_PDF.byteLength,
      bytes: SYNTHETIC_PDF,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detectedMimeType).toBe('application/pdf');
      expect(result.passwordRequired).toBe(false);
      expect(result.fileHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('accepts a valid CSV', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'text/csv',
      byteLength: SYNTHETIC_CSV.byteLength,
      bytes: SYNTHETIC_CSV,
    });
    expect(result.ok).toBe(true);
  });

  it('flags a password-protected PDF as valid but passwordRequired', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: SYNTHETIC_ENCRYPTED_PDF.byteLength,
      bytes: SYNTHETIC_ENCRYPTED_PDF,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.passwordRequired).toBe(true);
  });

  it('rejects an unsupported declared MIME type outright', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/zip',
      byteLength: 10,
      bytes: Buffer.from('PK\x03\x04xxxxxx'),
    });
    expect(result).toEqual({ ok: false, failureCode: 'unsupported_file_type' });
  });

  it('rejects a zero-byte file as corrupt', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: 0,
      bytes: new Uint8Array(0),
    });
    expect(result).toEqual({ ok: false, failureCode: 'file_corrupt' });
  });

  it('rejects an oversized file as too large, before inspecting content', () => {
    const oversized = FDH_MAX_FILE_SIZE_BYTES['application/pdf'] + 1;
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: oversized,
      bytes: SYNTHETIC_PDF, // deliberately mismatched — size check must win first
    });
    expect(result).toEqual({ ok: false, failureCode: 'file_too_large' });
  });

  it('rejects a renamed non-PDF file declared as PDF (MIME spoofing)', () => {
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: SYNTHETIC_CSV.byteLength,
      bytes: SYNTHETIC_CSV, // real CSV bytes, declared as PDF
    });
    expect(result).toEqual({ ok: false, failureCode: 'mime_mismatch' });
  });

  it('rejects a corrupted/garbage file that matches no known signature', () => {
    const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x00, 0x00]);
    const result = validateUploadedFile({
      declaredMimeType: 'application/pdf',
      byteLength: garbage.byteLength,
      bytes: garbage,
    });
    expect(result).toEqual({ ok: false, failureCode: 'file_corrupt' });
  });
});

describe('FDH-3 upload-session domain rules', () => {
  it('computes a 15-minute expiry from creation time', () => {
    expect(UPLOAD_SESSION_TTL_MINUTES).toBe(15);
    const created = '2026-01-01T00:00:00.000Z';
    expect(computeSessionExpiry(created)).toBe('2026-01-01T00:15:00.000Z');
  });

  it('treats a session as expired exactly at and after its expiry instant', () => {
    expect(isSessionExpired('2026-01-01T00:15:00.000Z', '2026-01-01T00:15:00.000Z')).toBe(true);
    expect(isSessionExpired('2026-01-01T00:15:00.000Z', '2026-01-01T00:14:59.999Z')).toBe(false);
    expect(isSessionExpired('2026-01-01T00:15:00.000Z', '2026-01-01T00:15:00.001Z')).toBe(true);
  });

  it('builds an opaque storage key with no filename, institution or account content', () => {
    const key = buildOpaqueStorageKey('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222');
    expect(key).toBe(
      '11111111-1111-1111-1111-111111111111/22222222-2222-2222-2222-222222222222/22222222-2222-2222-2222-222222222222.bin',
    );
    expect(key).not.toMatch(/statement|bank|@|\.pdf$|\.csv$/i);
  });

  it('rejects a completion attempt on an already-completed session (spec section 96)', () => {
    expect(() =>
      assertSessionIsLive(
        { upload_status: 'upload_complete', expires_at: '2026-01-01T00:15:00.000Z' },
        '2026-01-01T00:10:00.000Z',
      ),
    ).toThrow(FdhUploadSessionError);
  });

  it('rejects a completion attempt on an expired session even if bytes look fine', () => {
    expect(() =>
      assertSessionIsLive(
        { upload_status: 'session_created', expires_at: '2026-01-01T00:15:00.000Z' },
        '2026-01-01T00:16:00.000Z',
      ),
    ).toThrow(/expired/);
  });

  it('allows completion of a live, unexpired session', () => {
    expect(() =>
      assertSessionIsLive(
        { upload_status: 'session_created', expires_at: '2026-01-01T00:15:00.000Z' },
        '2026-01-01T00:05:00.000Z',
      ),
    ).not.toThrow();
  });

  it('a terminal session status has no onward transition', () => {
    expect(isAllowedSessionTransition('upload_complete', 'upload_in_progress')).toBe(false);
    expect(isAllowedSessionTransition('expired', 'session_created')).toBe(false);
    expect(isAllowedSessionTransition('failed', 'upload_complete')).toBe(false);
  });
});

describe('FDH-3 derived upload substates (spec section 14 — display only)', () => {
  it('maps a live session through its mechanical stages', () => {
    expect(
      deriveUploadSubstate({ sessionStatus: 'session_created', processingStatus: 'created', errorCode: null }),
    ).toBe('UPLOAD_CREATED');
    expect(
      deriveUploadSubstate({ sessionStatus: 'upload_in_progress', processingStatus: 'created', errorCode: null }),
    ).toBe('UPLOAD_IN_PROGRESS');
    expect(
      deriveUploadSubstate({ sessionStatus: 'upload_complete', processingStatus: 'uploaded', errorCode: null }),
    ).toBe('UPLOAD_COMPLETE');
    expect(
      deriveUploadSubstate({ sessionStatus: 'upload_complete', processingStatus: 'validating', errorCode: null }),
    ).toBe('VALIDATION_PENDING');
    expect(
      deriveUploadSubstate({ sessionStatus: 'upload_complete', processingStatus: 'queued', errorCode: null }),
    ).toBe('VALIDATED');
  });

  it('a failed/rejected document is FILE_REJECTED regardless of session state', () => {
    expect(
      deriveUploadSubstate({ sessionStatus: 'upload_complete', processingStatus: 'failed', errorCode: 'file_corrupt' }),
    ).toBe('FILE_REJECTED');
    expect(
      deriveUploadSubstate({ sessionStatus: null, processingStatus: 'rejected', errorCode: 'password_required' }),
    ).toBe('FILE_REJECTED');
  });

  it('every processing status has a non-empty, non-enum-leaking label', () => {
    for (const status of FDH_PROCESSING_STATUSES) {
      const label = deriveDocumentStatusLabel(status);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(status);
    }
  });
});

describe('FDH-3 widened document lifecycle (cancellation from pre-review stages)', () => {
  it('rejected is now reachable from every pre-approval stage — the FDH-3 cancellation addition', () => {
    for (const status of [
      'created', 'uploaded', 'validating', 'queued', 'processing', 'extracted',
      'review_required', 'ready_for_approval', 'failed',
    ] as const) {
      expect(isAllowedDocumentTransition(status, 'rejected'), status).toBe(true);
    }
  });

  it('approved never transitions directly to rejected — purge_pending only', () => {
    expect(isAllowedDocumentTransition('approved', 'rejected')).toBe(false);
    expect(isAllowedDocumentTransition('approved', 'purge_pending')).toBe(true);
  });

  it('rejected and purged remain terminal', () => {
    expect(DOCUMENT_STATUS_TRANSITIONS.rejected).toHaveLength(0);
    expect(DOCUMENT_STATUS_TRANSITIONS.purged).toHaveLength(0);
  });

  it('every transition target is itself a known status (no typo introduced by the widening)', () => {
    for (const [from, targets] of Object.entries(DOCUMENT_STATUS_TRANSITIONS)) {
      for (const to of targets) {
        expect(FDH_PROCESSING_STATUSES as readonly string[], `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it('still refuses an impossible jump (e.g. created -> approved)', () => {
    expect(isAllowedDocumentTransition('created', 'approved')).toBe(false);
    expect(isAllowedDocumentTransition('purged', 'processing')).toBe(false);
  });
});

describe('FDH-3 retention configuration', () => {
  it('every retention window is finite and positive — never indefinite', () => {
    expect(FDH_DOCUMENT_RETENTION_DAYS.approved).toBeGreaterThan(0);
    expect(FDH_DOCUMENT_RETENTION_DAYS.rejected_or_failed).toBeGreaterThan(0);
    expect(FDH_DOCUMENT_RETENTION_DAYS.abandoned_days).toBeGreaterThan(0);
  });

  it('computes a due date the correct number of days ahead', () => {
    expect(computePurgeDueDate('2026-01-01T00:00:00.000Z', 7)).toBe('2026-01-08T00:00:00.000Z');
  });
});

describe('FDH-3 orphan-artefact detection (pure set comparison)', () => {
  it('finds a storage object with no DB reference, and a DB reference with no storage object', async () => {
    const { detectOrphans } = await import('@/lib/financial-data-hub/domain/orphanDetection');
    const report = detectOrphans(
      ['u1/d1/d1.bin', 'u1/d2/d2.bin', 'u1/d3/d3.bin'],
      ['u1/d1/d1.bin', 'u1/d2/d2.bin', 'u1/d4/d4.bin'],
    );
    expect(report.orphanStorageObjects).toEqual(['u1/d3/d3.bin']);
    expect(report.orphanDbReferences).toEqual(['u1/d4/d4.bin']);
  });

  it('reports no orphans when both sides match exactly', async () => {
    const { detectOrphans } = await import('@/lib/financial-data-hub/domain/orphanDetection');
    const report = detectOrphans(['a', 'b'], ['a', 'b']);
    expect(report.orphanStorageObjects).toEqual([]);
    expect(report.orphanDbReferences).toEqual([]);
  });
});
