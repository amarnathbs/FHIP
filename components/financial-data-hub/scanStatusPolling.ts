/**
 * FDH-3 real-malware-gate async fix (2026-09-21).
 *
 * SHARED by every FDH-3 upload panel (Income/Payslip, Expenses/Bank
 * statement, Investments, Liabilities, Retirement). When the real S3 +
 * GuardDuty malware gate (`lib/aie/malware/*`, `lib/financial-data-hub/
 * services/malwareScanGate.ts` — none of which this fix touches) has not
 * yet resolved a just-uploaded document, `completeUpload()` legitimately
 * leaves `processing_status` at `validating` rather than advancing it. Every
 * FDH-3 processing service correctly refuses to process a document still in
 * that state (either explicitly, or via `documentLifecycle.ts`'s own
 * transition guard) — so a panel that fires its next step immediately,
 * with no wait, previously surfaced that refusal as a raw error to the user
 * even though nothing had actually gone wrong. GuardDuty's own documented
 * SLA is "the vast majority of scans complete within minutes," and this
 * repo currently has no in-app worker that resolves a pending scan on its
 * own — only the cron sweep
 * (`app/api/financial-data-hub/documents/cron/malware-scan-sweep/route.ts`)
 * does, and only once something external actually invokes it (see
 * DEPLOYMENT.md/OPERATIONS_RUNBOOK.md's EventBridge Scheduler instructions
 * added alongside this fix).
 *
 * `waitForDocumentToLeaveValidating()` polls the existing, generic
 * `GET /api/financial-data-hub/documents/{id}` status endpoint
 * (`getDocumentStatus()`) — no new backend route needed for this half of
 * the fix — until the document's `processing_status` is no longer
 * `validating`, or a bounded timeout elapses. It never throws; every
 * outcome (including a fetch failure) is reported through the return value
 * so a panel can always show an honest, calm UI state instead of an
 * uncaught rejection.
 */

/** How often to re-check the document's status while it sits in
 * `validating`. Deliberately much slower than the malware gate's own
 * internal inline-poll cadence (`INLINE_POLL_DELAY_MS`, ~400ms) — this runs
 * for potentially minutes in a browser tab, not milliseconds inside one HTTP
 * request. */
export const SCAN_POLL_INTERVAL_MS = 3000;

/** Total time a panel waits before giving up and showing the honest
 * "taking longer than expected" state. GuardDuty's own documented SLA is
 * "the vast majority of scans complete within minutes"; two minutes is
 * generous headroom without leaving a user staring at a spinner
 * indefinitely. The cron sweep keeps working on the document after this
 * panel gives up — see this module's header. */
export const SCAN_POLL_TIMEOUT_MS = 120_000;

export type ScanWaitOutcome =
  | { outcome: 'left_validating'; processingStatus: string; errorCode: string | null }
  | { outcome: 'timeout' };

export interface WaitForDocumentOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Checked before every poll and every wait — set `cancelled: true` (e.g.
   * from a component's unmount cleanup) to stop polling early without
   * needing an AbortController plumbed through every panel. */
  signal?: { cancelled: boolean };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls the document's status until it leaves `validating` (the real
 * malware-scan gate's documented resting state for a scan still in
 * progress) or the timeout elapses. A transient fetch/network failure is
 * treated as "not resolved yet" and simply retried on the next tick, rather
 * than failing the whole wait — the same generous, fail-toward-waiting
 * posture the gate's own inline poll already uses.
 */
export async function waitForDocumentToLeaveValidating(
  documentId: string,
  opts: WaitForDocumentOptions = {},
): Promise<ScanWaitOutcome> {
  const intervalMs = opts.intervalMs ?? SCAN_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? SCAN_POLL_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (opts.signal?.cancelled) return { outcome: 'timeout' };

    try {
      const res = await fetch(`/api/financial-data-hub/documents/${documentId}`);
      if (res.ok) {
        const json = await res.json().catch(() => null);
        const status = json?.data?.document?.processing_status as string | undefined;
        const errorCode = (json?.data?.document?.error_code as string | null | undefined) ?? null;
        if (status && status !== 'validating') {
          return { outcome: 'left_validating', processingStatus: status, errorCode };
        }
      }
    } catch {
      // Treated as "not resolved yet" — retried on the next tick below.
    }

    if (Date.now() >= deadline) return { outcome: 'timeout' };
    if (opts.signal?.cancelled) return { outcome: 'timeout' };
    await sleep(intervalMs);
  }
}

/** Shared, honest copy for the "scan still in progress" waiting state —
 * never technical, never implies anything is wrong. */
export const SCANNING_MESSAGE = 'Scanning your document for safety before we read it. This usually finishes within a minute or two…';

/** Shared, honest copy for the bounded-timeout outcome — never a dead end. */
export const SCAN_TIMEOUT_MESSAGE =
  "This is taking longer than expected to finish its safety check. It will keep going in the background and finish automatically — check back in a few minutes, or add this information manually for now.";
