/**
 * Internal deadline for a request that must answer before the platform cuts the connection (Amplify / CloudFront stop
 * a request at about 28 s and return an empty or HTML body). 16-10-2026.
 */

/** Default internal deadline for POST /api/reports/generate: authentication, the build, the save and the response. */
export const REPORT_GENERATE_DEADLINE_MS = 22_000;

export function configuredReportDeadlineMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.REPORT_GENERATE_DEADLINE_MS);
  // Never configured above the platform limit minus a safety margin, never below one second.
  if (Number.isFinite(raw) && raw >= 1000 && raw <= 26_000) return Math.floor(raw);
  return REPORT_GENERATE_DEADLINE_MS;
}

export type DeadlineOutcome<T> = { kind: 'done'; value: T } | { kind: 'late' };

/**
 * Waits for `work` up to `ms`. If it finishes first its value (or its rejection) is passed through. If the deadline
 * wins, the work is left running (its eventual rejection is swallowed here; it records its own outcome) and
 * `{ kind: 'late' }` is returned.
 */
export async function raceWithDeadline<T>(work: Promise<T>, ms: number): Promise<DeadlineOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<DeadlineOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'late' }), Math.max(0, ms));
  });
  try {
    return await Promise.race([work.then((value): DeadlineOutcome<T> => ({ kind: 'done', value })), late]);
  } finally {
    if (timer) clearTimeout(timer);
    work.catch(() => undefined);
  }
}
