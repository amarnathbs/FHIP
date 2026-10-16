/**
 * Single-flight: concurrent callers that ask for the SAME key share ONE execution and its result.
 *
 * WHY (found on DEV, 14-10-2026). Five identical `/process` requests for one fresh document, sent at the same
 * moment, each read the document as `queued`, each passed the entitlement gate, each reserved budget and each called
 * the provider: 4 metered calls, 2 draft rows, and three of the five responses reported the document unreadable
 * while a draft existed. A Premium account is entitled to ONE reading of a document, so a double click, a
 * retrying client or a stuck network must not be able to buy several, or to fight over the document's state.
 *
 * WHAT IT DOES. The chargeable section (gate, provider call, durable draft write) of each AI document fallback is
 * wrapped so that concurrent callers for the same user + document + class await the same promise. They all receive
 * the same outcome, so none of them takes a different, conflicting path afterwards (no "loser" writes a terminal
 * state over the winner's draft).
 *
 * WHAT IT DOES NOT DO (stated plainly). It is per server instance. Two requests that land on two different
 * serverless instances at the same instant are not collapsed by this alone; the durable defences still hold for
 * them (the cost ledger admits each metered call atomically, the unique pending-draft index allows one pending draft
 * per document, a confirm is claimed exactly once). A cross-instance claim needs a database object (a migration),
 * which this change deliberately does not add; it is listed as a follow-up.
 *
 * The map holds an entry only while a call is in flight and removes it on settlement (success or failure), so it
 * never grows and never returns a stale result to a later, sequential request.
 */

const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const started = (async () => run())();
  inFlight.set(key, started);
  const clear = () => {
    if (inFlight.get(key) === started) inFlight.delete(key);
  };
  started.then(clear, clear);
  return started;
}

/** Test helper: how many keys are currently in flight. */
export function singleFlightSize(): number {
  return inFlight.size;
}
