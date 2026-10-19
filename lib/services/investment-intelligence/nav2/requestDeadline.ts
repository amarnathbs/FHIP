// NAV2 release candidate (B3): the application's own hard deadline for one report generation request.
//
// The hosting platform ends every request at 28 s and shows its own page. The application must never reach that: it answers its own typed
// "timed out, ask again" state at REQUEST_DEADLINE_MS (22 s) measured from the moment the route started (sign-in, the Premium check and every
// database read are inside that time). The work that was running is not cancelled (it cannot be, it is a database call): it keeps its
// results, because the finished fund bundles are saved to the shared cache as soon as they exist and a report that finishes late is stored
// under the person's idempotency key, so asking again with the same key returns it instead of making a second one.

export type DeadlineResult<T> = { timedOut: false; value: T } | { timedOut: true };

/** Resolves with the work's value, or `{ timedOut: true }` when `msLeft` passes first. The work's later failure is swallowed (it has no one to tell). */
export async function raceDeadline<T>(work: Promise<T>, msLeft: number): Promise<DeadlineResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), Math.max(0, msLeft));
  });
  // a rejection that arrives after the deadline must not become an unhandled rejection
  const guarded = work.then(
    (value) => ({ timedOut: false as const, value }),
    (e: unknown) => {
      throw e;
    }
  );
  guarded.catch(() => undefined);
  try {
    return await Promise.race([guarded, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
