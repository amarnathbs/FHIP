/**
 * Typed failures for the Monthly Report "Export PDF" route (17-10-2026).
 *
 * Why this exists: on production the export POST answered a bare HTTP 500 whose body was the 21 characters
 * "Internal Server Error" -- the platform's answer to an exception that escaped the route (the route could not even be
 * loaded), not one of this route's own typed answers. The browser could only say "an answer we could not read".
 *
 * Every step of the export now has a short, safe reason code. The reason code is the only technical text a user sees;
 * the underlying message is written to the server log with the correlation id and never sent to the browser.
 *
 * Pure and dependency free so it is unit-testable without a browser, a database or the Next runtime.
 */

export type ReportExportStep =
  | 'renderer_unavailable' // the headless browser package or binary is not present on this server
  | 'token_failed' // the single-use render token could not be written
  | 'render_timeout' // the render did not finish inside the request deadline
  | 'render_failed' // the browser ran but the page could not be turned into a PDF
  | 'storage_failed' // the PDF was produced but could not be saved
  | 'record_failed'; // the export record could not be written

export interface ReportExportFailureSpec {
  status: number;
  /** Stable machine code returned in `code`. */
  code: 'EXPORT_RENDER_FAILED' | 'EXPORT_FAILED';
  message: string;
  retryable: boolean;
  /** Whether trying again can possibly help (a missing renderer will not fix itself). */
  transient: boolean;
}

const PRINT_HINT = 'You can still view this report and use Print, then choose Save as PDF.';

export const REPORT_EXPORT_FAILURES: Record<ReportExportStep, ReportExportFailureSpec> = {
  renderer_unavailable: {
    status: 503,
    code: 'EXPORT_RENDER_FAILED',
    message: `PDF export is temporarily unavailable. ${PRINT_HINT}`,
    retryable: false,
    transient: false,
  },
  token_failed: {
    status: 503,
    code: 'EXPORT_RENDER_FAILED',
    message: `The PDF could not be prepared just now. Please try again in a moment. ${PRINT_HINT}`,
    retryable: true,
    transient: true,
  },
  render_timeout: {
    status: 504,
    code: 'EXPORT_RENDER_FAILED',
    message: `The PDF took too long to produce. Please try again in a moment. ${PRINT_HINT}`,
    retryable: true,
    transient: true,
  },
  render_failed: {
    status: 502,
    code: 'EXPORT_RENDER_FAILED',
    message: `The PDF could not be produced just now. ${PRINT_HINT}`,
    retryable: true,
    transient: true,
  },
  storage_failed: {
    status: 502,
    code: 'EXPORT_RENDER_FAILED',
    message: `The PDF was produced but could not be saved. Please try again in a moment. ${PRINT_HINT}`,
    retryable: true,
    transient: true,
  },
  record_failed: {
    status: 503,
    code: 'EXPORT_FAILED',
    message: `The export could not be started just now. Please try again in a moment. ${PRINT_HINT}`,
    retryable: true,
    transient: true,
  },
};

/** Thrown by the renderer, the loader and the route's own steps; carries the step, never shown to the user. */
export class ReportExportError extends Error {
  readonly step: ReportExportStep;
  constructor(step: ReportExportStep, internalMessage: string) {
    super(internalMessage);
    this.name = 'ReportExportError';
    this.step = step;
  }
}

/**
 * Structural check rather than `instanceof`: the class can be loaded twice (separate bundles, a module reset in tests),
 * and an `instanceof` across two copies is false.
 */
export function isReportExportError(e: unknown): e is ReportExportError {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ReportExportError' && typeof (e as { step?: unknown }).step === 'string' && (e as { step: string }).step in REPORT_EXPORT_FAILURES;
}

/**
 * What an unclassified exception from the headless browser most likely means. A launch problem (missing executable,
 * missing shared library, the package not loadable, a sandbox refusal) is `renderer_unavailable`; a Playwright timeout
 * is `render_timeout`; anything else is `render_failed`. Order matters: the timeout check comes first because Playwright
 * timeout messages also mention the browser.
 */
export function classifyRenderFailure(err: unknown): ReportExportStep {
  if (isReportExportError(err)) return err.step;
  const name = err instanceof Error ? err.name : '';
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'TimeoutError' || /\btimeout\b.*\bexceeded\b|\btimed out\b/i.test(message)) return 'render_timeout';
  if (
    /executable doesn'?t exist|cannot find module|module not found|err_module_not_found|failed to launch|browsertype\.launch|error while loading shared libraries|no usable sandbox|spawn .*(enoent|eacces)|playwright install/i.test(
      message
    )
  ) {
    return 'renderer_unavailable';
  }
  return 'render_failed';
}

/** Total time the export may take. The platform cuts a request at about 28 seconds; this leaves room to answer. */
export const EXPORT_DEADLINE_MS = 22_000;

/** Rejects with a `render_timeout` ReportExportError if `work` does not settle in time. The work itself is not cancelled. */
export async function withExportDeadline<T>(work: Promise<T>, ms: number = EXPORT_DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ReportExportError('render_timeout', `export exceeded ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
