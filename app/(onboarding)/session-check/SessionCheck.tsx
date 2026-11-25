'use client';

import { useEffect, useState } from 'react';
import {
  SESSION_CHECK_MAX_ATTEMPTS,
  SESSION_CHECK_STORAGE_KEY,
  nextCheckStep,
  parseSessionCheckState,
  type SessionCheckState,
} from '@/lib/services/profileReadOutcome';

// The counter lives in sessionStorage so the proxy stays stateless; window.name is the fallback for a browser that blocks storage (it survives same-tab navigation), so a blocked storage can never
// turn the retries into a loop.
const NAME_PREFIX = `${SESSION_CHECK_STORAGE_KEY}:`;

function readState(): SessionCheckState | null {
  try {
    const fromStorage = parseSessionCheckState(window.sessionStorage.getItem(SESSION_CHECK_STORAGE_KEY));
    if (fromStorage) return fromStorage;
  } catch { /* storage blocked */ }
  return window.name.startsWith(NAME_PREFIX) ? parseSessionCheckState(window.name.slice(NAME_PREFIX.length)) : null;
}

function writeState(state: SessionCheckState | null): void {
  try {
    if (state) window.sessionStorage.setItem(SESSION_CHECK_STORAGE_KEY, JSON.stringify(state));
    else window.sessionStorage.removeItem(SESSION_CHECK_STORAGE_KEY);
  } catch { /* storage blocked */ }
  if (state) window.name = `${NAME_PREFIX}${JSON.stringify(state)}`;
  else if (window.name.startsWith(NAME_PREFIX)) window.name = '';
}

type Phase = { kind: 'waiting'; attempt: number; delayMs: number } | { kind: 'gave_up' };

export function SessionCheck({ next }: { next: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'waiting', attempt: 1, delayMs: 0 });

  useEffect(() => {
    const step = nextCheckStep(readState(), Date.now());
    writeState(step.state);
    // The screen state is set from a timer callback (not synchronously in the effect): the first paint is always the waiting state, so there is no hydration mismatch.
    const paint = window.setTimeout(() => setPhase(step.action === 'give_up' ? { kind: 'gave_up' } : { kind: 'waiting', attempt: step.attempt, delayMs: step.delayMs }), 0);
    const navigate = step.action === 'retry' ? window.setTimeout(() => window.location.assign(next), step.delayMs) : null;
    return () => {
      window.clearTimeout(paint);
      if (navigate !== null) window.clearTimeout(navigate);
    };
  }, [next]);

  const tryAgain = () => {
    writeState(null);
    window.location.assign(next);
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        {phase.kind === 'waiting' ? (
          <>
            <h1 className="text-xl font-semibold text-gray-900">Signing you in…</h1>
            <p className="mt-3 text-gray-700" role="status" aria-live="polite">
              We are confirming your sign-in. This usually takes a few seconds. Your profile and your financial data are safe and have not been changed.
            </p>
            <p className="mt-3 text-sm text-gray-500">
              Check {phase.attempt} of {SESSION_CHECK_MAX_ATTEMPTS}. We will try again automatically.
            </p>
            <button type="button" onClick={tryAgain} className="mt-6 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50">
              Try now
            </button>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold text-gray-900">We could not confirm your sign-in just now</h1>
            <p className="mt-3 text-gray-700" role="status" aria-live="polite">
              This is a temporary problem on our side, not something you did. Your profile and your financial data are safe and have not been changed. Please try again in a minute.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <button type="button" onClick={tryAgain} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
                Try again
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
