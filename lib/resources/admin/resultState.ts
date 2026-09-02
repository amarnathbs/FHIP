// Admin A0.2 Wave 5 — shared current-state result-state taxonomy for the
// Admin UI layer.
//
// Wave 4 established the taxonomy on the SERVER side (see
// lib/services/adminAuth.ts `safeDbError` and the Wave 4 report §9): every
// admin API response is one of a fixed, named set of outcomes, and a raw
// Postgres/PostgREST string never reaches the client. This module is the
// matching CLIENT-side half — before this Wave, every Admin list screen
// collapsed *every* non-2xx outcome into one red "We couldn't load Resources
// content. Try again." panel with a Retry button, so:
//
//   - a 403 (you are not permitted) looked identical to a 500 (we broke),
//     and offered a Retry that could never succeed;
//   - a 404 (this record is gone) looked like a transport failure;
//   - a 503 (dependency down) looked like a permanent error;
//   - and a non-JSON response (an HTML 502 page from the edge, or a dropped
//     connection) surfaced a raw `SyntaxError: Unexpected token '<' ...` or
//     `Failed to fetch` to the administrator.
//
// Wave 5's §9 requires each of those to be distinguishable on screen. This
// module classifies a fetch outcome once, centrally, so every Admin screen
// tells the same story for the same HTTP status.
//
// It deliberately does NOT change any server contract, any status code, or
// any authorization decision — it only interprets what the server already
// returns.

/**
 * The full result-state taxonomy an Admin surface may be in.
 * `loading`/`ready`/`empty`/`saving`/`success` are held by each screen's own
 * component state; the remainder are the failure states this module names.
 */
export type AdminResultState =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'unavailable'
  | 'forbidden'
  | 'not_found'
  | 'validation_error'
  | 'conflict'
  | 'saving'
  | 'success'
  | 'suppressed'
  | 'error';

export type AdminFailureState = Extract<
  AdminResultState,
  'unavailable' | 'forbidden' | 'not_found' | 'validation_error' | 'conflict' | 'error'
>;

export interface AdminFailure {
  /** Which named result state this outcome is. */
  state: AdminFailureState;
  /** Short, specific headline naming what could not be done. */
  title: string;
  /**
   * The administrator-facing explanation. Always safe to render: it is
   * either a curated server message or one of this module's own strings —
   * never a raw database/transport error (see `isSafeServerMessage`).
   */
  message: string;
  /**
   * Whether retrying the identical request could plausibly succeed. A
   * permission denial and a not-found are NOT retryable; offering a Retry
   * button for them is itself a misleading affordance.
   */
  retryable: boolean;
}

/**
 * Verbatim database/transport strings that must never be shown to an
 * administrator (Wave 5 §19: no raw SQL errors, internal schemas, table
 * names or RPC names). A server message is only forwarded to the screen if
 * it looks like curated prose rather than a leaked engine message.
 */
const UNSAFE_MESSAGE_MARKERS = [
  'violates row-level security',
  'violates unique constraint',
  'violates foreign key constraint',
  'violates check constraint',
  'null value in column',
  'duplicate key value',
  'permission denied for',
  'relation "',
  'column "',
  'function public.',
  'schema "',
  'pgrst',
  'sqlstate',
  'syntaxerror',
  'unexpected token',
  'failed to fetch',
  'networkerror',
  'load failed',
  '<!doctype',
];

export function isSafeServerMessage(message: unknown): message is string {
  if (typeof message !== 'string') return false;
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 400) return false;
  const lower = trimmed.toLowerCase();
  return !UNSAFE_MESSAGE_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Parses a response body without ever letting a JSON parse failure become
 * the message an administrator sees. An HTML error page from an edge proxy
 * is a real, common production outcome; `await res.json()` on it throws a
 * `SyntaxError` whose message is meaningless to an operator.
 */
export async function readJsonSafely(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = await res.text();
    if (!text) return null;
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function serverMessage(body: Record<string, unknown> | null): string | null {
  const raw = body?.error;
  return isSafeServerMessage(raw) ? raw : null;
}

/**
 * Classifies a non-2xx admin API response into exactly one named failure
 * state, with a safe headline and explanation.
 *
 * @param subject  What the administrator was trying to load or do, in
 *                 sentence case and singular-or-plural as it reads best —
 *                 e.g. "Resources content", "the Resources dashboard",
 *                 "Videos". Used to build a specific headline instead of
 *                 the one hardcoded string every screen shared before.
 */
export function failureFromResponse(
  status: number,
  body: Record<string, unknown> | null,
  subject: string
): AdminFailure {
  const fromServer = serverMessage(body);

  if (status === 401) {
    return {
      state: 'forbidden',
      title: 'Your session has ended',
      message: 'Sign in again to continue. Your work is not lost — reopen this page after signing in.',
      retryable: false,
    };
  }
  if (status === 403) {
    return {
      state: 'forbidden',
      title: 'You do not have access to this',
      message:
        fromServer ??
        `Your current roles do not include permission to view ${subject}. Ask a Resource Administrator or Super Admin if you need it.`,
      retryable: false,
    };
  }
  if (status === 404) {
    return {
      state: 'not_found',
      title: 'Not found',
      message: fromServer ?? 'This item no longer exists, or the link is out of date. It may have been removed by someone else.',
      retryable: false,
    };
  }
  if (status === 409) {
    return {
      state: 'conflict',
      title: 'This changed somewhere else',
      message: fromServer ?? 'Someone else changed this since you loaded the page. Reload to see the current version before trying again.',
      retryable: true,
    };
  }
  if (status === 422 || status === 400) {
    return {
      state: 'validation_error',
      title: 'That could not be accepted',
      message: fromServer ?? 'Some of the submitted details are not valid. Correct them and try again.',
      retryable: false,
    };
  }
  if (status === 503 || status === 502 || status === 504) {
    return {
      state: 'unavailable',
      title: 'Temporarily unavailable',
      message: fromServer ?? `${capitalise(subject)} cannot be loaded right now. This is usually brief — try again shortly.`,
      retryable: true,
    };
  }

  return {
    state: 'error',
    title: `We could not load ${subject}`,
    message: fromServer ?? 'Something went wrong at our end. Try again; if it keeps happening, report it with the time you saw it.',
    retryable: true,
  };
}

/**
 * Classifies a thrown fetch failure (offline, DNS, aborted connection).
 * Never surfaces the thrown error's own text — `Failed to fetch` and
 * `NetworkError when attempting to fetch resource` are browser-internal
 * strings, not operator guidance.
 */
export function failureFromThrown(_err: unknown, subject: string): AdminFailure {
  return {
    state: 'unavailable',
    title: 'Could not reach the server',
    message: `${capitalise(subject)} could not be loaded because the server could not be reached. Check your connection and try again.`,
    retryable: true,
  };
}

/**
 * Convenience wrapper: classify any non-ok response, reading its body
 * safely. Returns `null` when the response is ok.
 */
export async function failureFor(res: Response, subject: string): Promise<AdminFailure | null> {
  if (res.ok) return null;
  const body = await readJsonSafely(res);
  return failureFromResponse(res.status, body, subject);
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Safe message for a MUTATION failure (assign, remove, save, transition).
 * Same rules as the load path, but phrased as "this action failed" rather
 * than "this page failed to load".
 */
export function actionFailureMessage(
  status: number,
  body: Record<string, unknown> | null,
  actionDescription: string
): string {
  const fromServer = serverMessage(body);
  if (fromServer) return fromServer;
  if (status === 401) return 'Your session has ended. Sign in again and retry this action.';
  if (status === 403) return `You do not have permission to ${actionDescription}.`;
  if (status === 404) return 'That item no longer exists. Reload the page to see the current list.';
  if (status === 409) return 'Someone else changed this first. Reload the page and check the current state before retrying.';
  if (status === 422 || status === 400) return 'Some of the submitted details are not valid. Correct them and try again.';
  if (status === 503 || status === 502 || status === 504) {
    return 'This service is temporarily unavailable. Try again shortly.';
  }
  return `Could not ${actionDescription}. Try again; if it keeps happening, report it with the time you saw it.`;
}
