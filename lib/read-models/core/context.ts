/**
 * Per-request read-model context: the FX rate, the window and the normalised
 * ledger are each resolved ONCE and shared by every selector (DC-15), whether
 * a caller asks for one selector or the whole snapshot.
 */
import { loadFxContext, type FxContext } from './currency';
import { loadApprovedLedger, normaliseLedger, type NormaliseOptions, type NormalisedLedger } from './ledger';
import type { ReadModelClient } from './paginate';
import { defaultWindowFor, type ReadWindow } from './window';

export interface ReadModelOptions {
  client: ReadModelClient;
  /** Default: trailing 3 complete months in the user's timezone. */
  window?: ReadWindow;
  /** The instant "today" is taken from (tests pin it). */
  now?: Date;
  /** Pre-resolved context (the snapshot passes these so nothing is loaded twice). */
  fx?: FxContext;
  ledger?: NormalisedLedger;
  normalise?: NormaliseOptions;
}

export interface ResolvedContext {
  client: ReadModelClient;
  fx: FxContext;
  window: ReadWindow;
  ledger(): Promise<NormalisedLedger>;
}

export async function resolveContext(userId: string, opts: ReadModelOptions): Promise<ResolvedContext> {
  const fx = opts.fx ?? (await loadFxContext(userId, opts.client));
  const window = opts.window ?? opts.ledger?.window ?? defaultWindowFor(fx.countryCode, opts.now ?? new Date());
  let ledger: Promise<NormalisedLedger> | null = opts.ledger ? Promise.resolve(opts.ledger) : null;
  return {
    client: opts.client,
    fx,
    window,
    ledger: () => {
      if (!ledger) ledger = loadApprovedLedger(userId, opts.client, window).then((raw) => normaliseLedger(raw, fx, window, opts.normalise));
      return ledger;
    },
  };
}
