import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForDocumentToLeaveValidating } from '@/components/financial-data-hub/scanStatusPolling';

/**
 * Real-malware-gate async fix (2026-09-21) — the shared client-side polling
 * helper every FDH-3 upload panel (Payslip, Expenses/Bank statement,
 * Investments, Liabilities, Retirement) now calls instead of firing its
 * next step immediately after a document leaves `completeUpload()`/the
 * upload route still `validating`.
 *
 * No React rendering harness exists anywhere in this repo's test suite
 * (`@testing-library/react` is not a dependency) — this file proves the
 * plain-TypeScript logic every panel's "scanning…" / timeout / resumed
 * state is driven by, which is the part of the fix that is meaningfully
 * unit-testable without introducing a new testing convention.
 */

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const originalFetch = global.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('waitForDocumentToLeaveValidating -- fast-resolving scan (unchanged-path proof)', () => {
  it('returns immediately (no extra polling) when the document has already left validating on the first check', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { document: { processing_status: 'queued', error_code: null } } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 1000 });

    expect(result).toEqual({ outcome: 'left_validating', processingStatus: 'queued', errorCode: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/financial-data-hub/documents/doc-1');
  });
});

describe('waitForDocumentToLeaveValidating -- slower scan resolved by a later sweep tick', () => {
  it('keeps polling while still validating, then reports left_validating once the status changes', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      // Simulates the cron sweep resolving the scan on its own schedule --
      // the first two checks still see `validating`, the third sees the
      // sweep's resumed `queued`.
      if (call < 3) {
        return jsonResponse({ data: { document: { processing_status: 'validating', error_code: null } } });
      }
      return jsonResponse({ data: { document: { processing_status: 'queued', error_code: null } } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 1000 });

    expect(result).toEqual({ outcome: 'left_validating', processingStatus: 'queued', errorCode: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reports the real rejection (processing_status "failed" + the real error_code), not a generic success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { document: { processing_status: 'failed', error_code: 'malware_detected' } } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 1000 });

    expect(result).toEqual({ outcome: 'left_validating', processingStatus: 'failed', errorCode: 'malware_detected' });
  });
});

describe('waitForDocumentToLeaveValidating -- never resolves within the bound (honest timeout, no silent success)', () => {
  it('returns {outcome: "timeout"} once the timeout elapses, without ever claiming the document is ready', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { document: { processing_status: 'validating', error_code: null } } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 30 });

    expect(result).toEqual({ outcome: 'timeout' });
    // Bounded: this must not have spun forever -- a handful of 5ms ticks
    // inside a 30ms budget, not an unbounded loop.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(fetchMock.mock.calls.length).toBeLessThan(20);
  });

  it('does not duplicate work or throw if called again after a prior timeout -- each call is independent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { document: { processing_status: 'validating', error_code: null } } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const first = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 20 });
    const second = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 20 });

    expect(first).toEqual({ outcome: 'timeout' });
    expect(second).toEqual({ outcome: 'timeout' });
  });
});

describe('waitForDocumentToLeaveValidating -- resilience and cancellation', () => {
  it('treats a transient fetch/network failure as "not resolved yet" rather than throwing', async () => {
    let call = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      call += 1;
      if (call === 1) throw new Error('network blip');
      return jsonResponse({ data: { document: { processing_status: 'queued', error_code: null } } });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 1000 });

    expect(result).toEqual({ outcome: 'left_validating', processingStatus: 'queued', errorCode: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops polling promptly once the caller signals cancellation (e.g. the panel unmounted)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ data: { document: { processing_status: 'validating', error_code: null } } }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const signal = { cancelled: false };

    const promise = waitForDocumentToLeaveValidating('doc-1', { intervalMs: 5, timeoutMs: 5000, signal });
    signal.cancelled = true;

    const result = await promise;
    expect(result).toEqual({ outcome: 'timeout' });
    // Cancelled almost immediately -- nowhere near the 5000ms timeout budget.
    expect(fetchMock.mock.calls.length).toBeLessThan(5);
  });
});
