// A failed profile read is NOT a missing profile (25-11-2026).
//
// proxy.ts reads the signed-in user's user_profiles row to decide where they belong. Until now ANY error on that read left `profile` empty, and an empty profile means
// "not onboarded", so a user with a complete profile was sent to /onboarding and shown a blank wizard that asked for everything again. It happened twice on production
// (13-11 and 25-11-2026). The second time the Supabase edge log showed the cause: the user's access token was valid for Auth (GET /auth/v1/user -> 200) but the data API
// refused it for 4 seconds after it was issued (GET /rest/v1/user_profiles -> 401, `PostgREST; error=PGRST303`, a response of 79 bytes: the size of "JWT issued at future"), i.e. a
// clock difference between Supabase Auth and PostgREST. The user's row was intact and complete; only a just-issued token was refused, so a second try a few seconds later works.
//
// This module is the pure part of the fix, used by proxy.ts and by the /session-check page:
//   * classifyProfileRead   - 'read' (a row), 'missing' (the database answered: no row), 'failed' (the read itself failed: say so, never guess "no profile");
//   * safeInternalPath      - the only destinations /session-check may send a visitor back to (same-origin paths; never an open redirect);
//   * nextCheckStep         - the bounded, spaced retries of the page (a client-side counter, so the proxy stays stateless), then a clear "your data is safe" message.

export type ProfileReadOutcome = 'read' | 'missing' | 'failed';

export interface ProfileReadError {
  code?: string | null;
  message?: string | null;
}

/** PostgREST's "no row" / "not exactly one row" answer for `.single()`. The database DID answer: this is the one error that means "no profile". */
export const PROFILE_NOT_FOUND_CODE = 'PGRST116';

/** An empty row with no error is "missing" (the earlier behaviour); an error other than PGRST116 is a failed read (a 401 on a fresh token, a timeout, a schema-cache reload, a network failure). */
export function classifyProfileRead(profile: unknown, error: ProfileReadError | null | undefined): ProfileReadOutcome {
  if (error) return error.code === PROFILE_NOT_FOUND_CODE ? 'missing' : 'failed';
  return profile ? 'read' : 'missing';
}

export const SESSION_CHECK_PATH = '/session-check';

/**
 * The destination a visitor is sent back to after a check. Only a same-origin absolute PATH is accepted: it must start with one "/" (not "//", not "/\"), carry no control characters or backslashes,
 * be short, and never be the check page itself (a loop). Anything else becomes the fallback.
 */
export function safeInternalPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (typeof next !== 'string' || next.length === 0 || next.length > 512) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  const pathOnly = next.split(/[?#]/, 1)[0];
  if (pathOnly === SESSION_CHECK_PATH || pathOnly.startsWith(`${SESSION_CHECK_PATH}/`)) return fallback;
  return next;
}

/** The URL of the check page for a destination, carrying the destination as a query parameter. */
export function sessionCheckUrl(destination: string): string {
  return `${SESSION_CHECK_PATH}?next=${encodeURIComponent(safeInternalPath(destination))}`;
}

/** Waits before try 1, 2, 3 and 4 (6 s covers the 4 s seen on production with margin; the whole sequence is about 51 s). */
export const SESSION_CHECK_DELAYS_MS: readonly number[] = [6_000, 10_000, 15_000, 20_000];
export const SESSION_CHECK_MAX_ATTEMPTS = SESSION_CHECK_DELAYS_MS.length;
/** The counter starts again after two quiet minutes, so an old failure never shortens a new visit's tries. */
export const SESSION_CHECK_RESET_MS = 120_000;
export const SESSION_CHECK_STORAGE_KEY = 'fhip_session_check';

export interface SessionCheckState {
  n: number;
  t: number;
}

export type SessionCheckStep =
  | { action: 'retry'; attempt: number; delayMs: number; state: SessionCheckState }
  | { action: 'give_up'; attempt: number; state: SessionCheckState };

/** The step for the visit that is happening now, given the stored state (null when none, unreadable or too old) and the current time. Pure. */
export function nextCheckStep(prev: SessionCheckState | null | undefined, now: number): SessionCheckStep {
  const fresh = prev && Number.isFinite(prev.n) && Number.isFinite(prev.t) && prev.n >= 0 && now - prev.t >= 0 && now - prev.t <= SESSION_CHECK_RESET_MS;
  const attempt = fresh ? Math.floor(prev!.n) + 1 : 1;
  const state = { n: attempt, t: now };
  if (attempt > SESSION_CHECK_MAX_ATTEMPTS) return { action: 'give_up', attempt, state };
  return { action: 'retry', attempt, delayMs: SESSION_CHECK_DELAYS_MS[attempt - 1], state };
}

/** Parses the stored value defensively (storage can hold anything, or be blocked). */
export function parseSessionCheckState(raw: string | null | undefined): SessionCheckState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<SessionCheckState>;
    return typeof v?.n === 'number' && typeof v?.t === 'number' ? { n: v.n, t: v.t } : null;
  } catch {
    return null;
  }
}
