/**
 * Browser-side helpers for the report endpoints (16-10-2026). No server imports: this file is bundled into client
 * components and unit-tested in node.
 *
 * Why it exists: the Generate report button used to call `await res.json()` directly. When the platform cut the
 * request (an empty body) or a gateway answered with an HTML page, that call threw
 * "Failed to execute 'json' on 'Response': Unexpected end of JSON input", which the user saw verbatim.
 * Nothing here ever calls `res.json()`: the body is read as text and parsed defensively.
 */

export interface ReadResponse {
  status: number;
  ok: boolean;
  /** The parsed JSON object, or null when the body was empty, not JSON, or JSON that is not an object. */
  json: Record<string, unknown> | null;
  bodyKind: 'json' | 'empty' | 'html' | 'text';
}

export async function readApiResponse(res: Response): Promise<ReadResponse> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  const trimmed = text.trim();
  if (trimmed === '') return { status: res.status, ok: res.ok, json: null, bodyKind: 'empty' };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: res.status, ok: res.ok, json: parsed as Record<string, unknown>, bodyKind: 'json' };
    }
    return { status: res.status, ok: res.ok, json: null, bodyKind: 'text' };
  } catch {
    return { status: res.status, ok: res.ok, json: null, bodyKind: /^<(!doctype|html|head|body)/i.test(trimmed) ? 'html' : 'text' };
  }
}

export interface ApiFailure {
  message: string;
  code: string | null;
  correlationId: string | null;
  /** Worth trying again (a platform timeout, a gateway error, a typed retryable failure, a lost connection). */
  retryable: boolean;
  status: number;
}

/** A plain-language failure for any non-success answer, parseable or not. Never shows a parser or database message. */
export function describeFailure(r: ReadResponse): ApiFailure {
  const j = r.json;
  if (r.status === 401) return { message: 'Your session has ended. Please sign in again.', code: null, correlationId: null, retryable: false, status: r.status };
  const message = j && typeof j.message === 'string' && j.message ? j.message : j && typeof j.error === 'string' && j.error ? j.error : null;
  const code = j && typeof j.code === 'string' ? j.code : j && typeof j.error === 'string' && /^[A-Z0-9_]+$/.test(j.error) ? j.error : null;
  const correlationId = j && typeof j.correlationId === 'string' ? j.correlationId : null;
  if (message && r.bodyKind === 'json' && !(code === message)) {
    const retryable = j && typeof j.retryable === 'boolean' ? j.retryable : r.status >= 500;
    return { message, code, correlationId, retryable, status: r.status };
  }
  if (r.status === 502 || r.status === 503 || r.status === 504 || r.status === 408 || r.bodyKind === 'empty') {
    return {
      message: 'The server took too long to answer, so we could not confirm your report. Nothing is lost; we will check again.',
      code: 'NO_ANSWER',
      correlationId,
      retryable: true,
      status: r.status,
    };
  }
  return {
    message: 'The service gave an answer we could not read. Please try again in a moment.',
    code: 'UNREADABLE_ANSWER',
    correlationId,
    retryable: true,
    status: r.status,
  };
}

/** The message shown when the request never reached the server or the connection dropped. */
export const NETWORK_FAILURE: ApiFailure = {
  message: 'We could not reach the server. Check your connection; we will try again.',
  code: 'NETWORK',
  correlationId: null,
  retryable: true,
  status: 0,
};

// ---------------------------------------------------------------------------
// Generate report
// ---------------------------------------------------------------------------

export interface WaitingState {
  headline: string | null;
  loaded: number;
  total: number;
  waitingFunds: string[];
  unavailableFunds: string[];
  retryWindowMinutes: number;
}

export type GenerateAttempt =
  | { kind: 'done'; reportId: string | null }
  | { kind: 'waiting'; state: WaitingState }
  | { kind: 'preparing'; retryAfterMs: number; runId: string | null }
  | { kind: 'failed'; failure: ApiFailure };

export async function attemptGenerate(
  fetchFn: typeof fetch,
  body: { reportType: string; reportMonth: string }
): Promise<GenerateAttempt> {
  let res: Response;
  try {
    res = await fetchFn('/api/reports/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'failed', failure: NETWORK_FAILURE };
  }
  const r = await readApiResponse(res);
  const data = r.json && r.json.data !== null && typeof r.json.data === 'object' ? (r.json.data as Record<string, unknown>) : null;
  if (r.status === 202 && data) {
    if (data.waiting) return { kind: 'waiting', state: data as unknown as WaitingState };
    if (data.preparing) {
      const retryAfterMs = typeof data.retryAfterMs === 'number' && data.retryAfterMs > 0 ? data.retryAfterMs : 4000;
      return { kind: 'preparing', retryAfterMs, runId: typeof data.runId === 'string' ? data.runId : null };
    }
  }
  if (r.ok && data) {
    const report = data.report as { id?: unknown } | undefined;
    return { kind: 'done', reportId: report && typeof report.id === 'string' ? report.id : null };
  }
  return { kind: 'failed', failure: describeFailure(r) };
}

export type GenerateOutcome =
  | { kind: 'done'; reportId: string | null }
  | { kind: 'error'; failure: ApiFailure }
  | { kind: 'stopped' };

export interface GenerateStatus {
  phase: 'requesting' | 'preparing' | 'waiting' | 'retrying';
  waiting: WaitingState | null;
  /** A plain sentence for the screen-reader status region. */
  announcement: string;
}

export interface GenerateOptions {
  fetchFn: typeof fetch;
  body: { reportType: string; reportMonth: string };
  sleep: (ms: number) => Promise<void>;
  onStatus: (s: GenerateStatus) => void;
  /** Drives the price-history fetch between waiting attempts (the existing behaviour). */
  driveHistory?: () => Promise<void>;
  isStopped?: () => boolean;
  /** Longest total time spent asking again while the report is being prepared. */
  maxPreparingMs?: number;
  /** How many times an unreadable / cut-off answer is re-asked (the request is idempotent) before it is shown as an error. */
  maxSilentRetries?: number;
  waitingPollMs?: number;
  maxWaitingPolls?: number;
}

const BACKOFF_MS = [2000, 3000, 4000, 6000, 8000];

export async function runGenerate(opts: GenerateOptions): Promise<GenerateOutcome> {
  const maxPreparingMs = opts.maxPreparingMs ?? 5 * 60_000;
  const maxSilentRetries = opts.maxSilentRetries ?? 3;
  const waitingPollMs = opts.waitingPollMs ?? 6000;
  const maxWaitingPolls = opts.maxWaitingPolls ?? 150;
  const stopped = () => opts.isStopped?.() === true;

  let waitedMs = 0;
  let preparingRounds = 0;
  let waitingRounds = 0;
  let silentRetries = 0;
  opts.onStatus({ phase: 'requesting', waiting: null, announcement: 'Generating your report.' });

  for (;;) {
    if (stopped()) return { kind: 'stopped' };
    const attempt = await attemptGenerate(opts.fetchFn, opts.body);
    if (stopped()) return { kind: 'stopped' };

    if (attempt.kind === 'done') return { kind: 'done', reportId: attempt.reportId };

    if (attempt.kind === 'waiting') {
      waitingRounds += 1;
      if (waitingRounds > maxWaitingPolls) {
        return { kind: 'error', failure: { message: 'Price history is taking longer than expected to load. Please try again later.', code: 'WAITING_TIMEOUT', correlationId: null, retryable: true, status: 202 } };
      }
      opts.onStatus({ phase: 'waiting', waiting: attempt.state, announcement: attempt.state.headline ?? 'Waiting for price history to load.' });
      await opts.driveHistory?.().catch(() => undefined);
      await opts.sleep(waitingPollMs);
      continue;
    }

    if (attempt.kind === 'preparing') {
      silentRetries = 0;
      const delay = Math.max(attempt.retryAfterMs, BACKOFF_MS[Math.min(preparingRounds, BACKOFF_MS.length - 1)]);
      preparingRounds += 1;
      waitedMs += delay;
      if (waitedMs > maxPreparingMs) {
        return {
          kind: 'error',
          failure: {
            message: 'Your report is taking longer than expected to prepare. You can leave this page and press Generate report again later; it will carry on where it left off.',
            code: 'PREPARING_TIMEOUT',
            correlationId: null,
            retryable: true,
            status: 202,
          },
        };
      }
      opts.onStatus({ phase: 'preparing', waiting: null, announcement: 'Your report is still being prepared. Checking again shortly.' });
      await opts.sleep(delay);
      continue;
    }

    // failed
    // A cut-off, unreadable or lost answer does not say the report failed (the preparation may well have carried on),
    // and asking again is safe because the endpoint is idempotent. A typed answer is shown as it is.
    if (attempt.failure.code === 'NO_ANSWER' || attempt.failure.code === 'UNREADABLE_ANSWER' || attempt.failure.code === 'NETWORK') {
      if (silentRetries < maxSilentRetries) {
        const delay = BACKOFF_MS[Math.min(silentRetries, BACKOFF_MS.length - 1)];
        silentRetries += 1;
        opts.onStatus({ phase: 'retrying', waiting: null, announcement: 'The server was slow to answer. Checking again.' });
        await opts.sleep(delay);
        continue;
      }
    }
    return { kind: 'error', failure: attempt.failure };
  }
}
