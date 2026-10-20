/**
 * Print tabs: the shared behaviour of every report print route that a person reaches from the app (PO feedback 17-10-2026:
 * "after I print or save, that tab stays open and I end up with two tabs showing the same information").
 *
 * WHY THIS DESIGN (browser rules, not preference):
 *  - A script may close only a window that was OPENED BY SCRIPT (or a tab whose history has a single entry). A tab opened by a
 *    plain `<a target="_blank">` is not script-opened, so `window.close()` is silently ignored there.
 *  - So the app opens the print view with `window.open(url, 'fhip-print-<report>')` from a click handler (a user gesture, so it is
 *    not popup-blocked), and the print view recognises itself as script-opened from its WINDOW NAME (`fhip-print-...`) or from
 *    `window.opener`. The name survives even when an opener reference is severed; a directly typed or bookmarked URL has neither.
 *  - `noopener` is deliberately NOT used on that `window.open`: with it the call returns null (we could not tell "blocked" from
 *    "opened") and some browsers then refuse to close the window. The destination is the app's own same-origin route and no
 *    data is exchanged through `opener`, so there is no cross-origin tab-nabbing exposure. (The no-JavaScript fallback anchor keeps
 *    `rel="noopener"`.) No BroadcastChannel/postMessage handshake is needed: the print tab closes ITSELF.
 *  - `afterprint` fires when the print dialog is dismissed, whether the person printed, saved a PDF or cancelled; the tab is
 *    then closed (a short delay lets the browser finish writing the file). If the browser refuses, or the tab was not opened by
 *    the app, nothing is lost: a clear "Close this tab" button tries again and, when refused, says "You can close this tab now."
 *    and offers a link back to the parent page.
 *
 * Pure and injectable (no React, no global access) so it is tested with a fake window and a fake scheduler.
 */

/** The window-name prefix the app gives every print tab it opens. */
export const PRINT_WINDOW_NAME_PREFIX = 'fhip-print-';

export interface PrintWindowLike {
  name: string;
  opener: unknown;
  closed?: boolean;
  print(): void;
  close(): void;
  addEventListener(type: 'afterprint', listener: () => void): void;
  removeEventListener(type: 'afterprint', listener: () => void): void;
}

export interface OpenerWindowLike {
  open(url: string, name: string): unknown;
  location: { assign(url: string): void };
}

/** True when the app opened this tab (by name, or by an opener reference): the only tabs a script may close. */
export function isScriptOpenedPrintTab(w: Pick<PrintWindowLike, 'name' | 'opener'>): boolean {
  return (w.name ?? '').startsWith(PRINT_WINDOW_NAME_PREFIX) || (w.opener !== null && w.opener !== undefined);
}

/**
 * Opens a print view from a click handler. Returns 'opened' when a window came back, and falls back to this tab when the browser
 * blocked the popup (the print view then offers its Close / back controls instead of auto-closing).
 */
export function openPrintTab(w: OpenerWindowLike, url: string, name: string): 'opened' | 'same_tab' {
  const child = w.open(url, `${PRINT_WINDOW_NAME_PREFIX}${name}`);
  if (child) return 'opened';
  w.location.assign(url);
  return 'same_tab';
}

export type PrintTabState = 'idle' | 'closing' | 'close_refused';

export interface PrintTabController {
  readonly scriptOpened: boolean;
  getState(): PrintTabState;
  subscribe(listener: () => void): () => void;
  /** Starts listening for `afterprint` and, when asked, opens the print dialog once. Returns a stop function. */
  start(): () => void;
  print(): void;
  /** Tries to close the tab; if the browser refuses, the state becomes 'close_refused'. */
  requestClose(): void;
}

export interface PrintTabOptions {
  /** Open the print dialog once on start (the "?print=1" marker from the Print button). */
  autoPrint: boolean;
  /** Wait before the automatic print (lets the page paint). */
  printDelayMs?: number;
  /** Wait after `afterprint` before closing (lets the browser finish writing a saved PDF). */
  closeDelayMs?: number;
  /** How long to wait to find out whether `close()` was honoured. */
  verifyDelayMs?: number;
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Runs immediately before every window.print() (the automatic one and the button's), so the page title, which the print dialog reads
   * when it opens and Chrome proposes as the saved file name, is the report's name and period at that moment.
   */
  beforePrint?: () => void;
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createPrintTabController(w: PrintWindowLike, opts: PrintTabOptions): PrintTabController {
  const schedule = opts.schedule ?? defaultSchedule;
  const listeners = new Set<() => void>();
  let state: PrintTabState = 'idle';
  const scriptOpened = isScriptOpenedPrintTab(w);
  const set = (next: PrintTabState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  function requestClose() {
    set('closing');
    try {
      w.close();
    } catch {
      set('close_refused');
      return;
    }
    // A closed tab stops running; if this code is still running the browser refused (or the window is closing, `closed` is true).
    schedule(() => {
      if (!w.closed) set('close_refused');
    }, opts.verifyDelayMs ?? 400);
  }

  function printNow() {
    try {
      opts.beforePrint?.();
    } catch {
      // A title that cannot be set must never stop the print dialog from opening.
    }
    w.print();
  }

  const onAfterPrint = () => {
    if (!scriptOpened) return; // a tab the app did not open cannot be closed by script: the person uses the Close button
    schedule(requestClose, opts.closeDelayMs ?? 150);
  };

  return {
    scriptOpened,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      w.addEventListener('afterprint', onAfterPrint);
      const cancelPrint = opts.autoPrint ? schedule(printNow, opts.printDelayMs ?? 300) : () => undefined;
      return () => {
        cancelPrint();
        w.removeEventListener('afterprint', onAfterPrint);
      };
    },
    print: printNow,
    requestClose,
  };
}
