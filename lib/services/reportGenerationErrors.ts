/**
 * Typed outcomes of report generation that are NOT a plain failure (16-10-2026).
 *
 * The generate route turns each of these into a JSON body the browser can always parse, so the Generate report
 * button can never meet an empty or unparseable body.
 */

/** Another preparation for the same user is already running; the caller should ask again shortly (HTTP 202). */
export class ReportPreparingError extends Error {
  readonly code = 'REPORT_PREPARING';
  constructor(readonly runId: string, readonly startedAt: string) {
    super('Your report is still being prepared.');
    this.name = 'ReportPreparingError';
  }
}

/** The report could not be saved completely; nothing half-saved is left as a finished report (HTTP 503). */
export class ReportNotSavedError extends Error {
  readonly code = 'REPORT_NOT_SAVED';
  constructor(readonly stage: string, detail: string) {
    super(`The report could not be saved completely (${stage}): ${detail}`);
    this.name = 'ReportNotSavedError';
  }
}

/** Earlier preparations were each cut off before they finished; stop retrying blindly (HTTP 503). */
export class ReportPreparationStalledError extends Error {
  readonly code = 'REPORT_PREPARATION_STALLED';
  constructor(readonly abandonedRuns: number) {
    super('Your report could not be finished in time on the last attempts.');
    this.name = 'ReportPreparationStalledError';
  }
}

/** A preparation still marked as running after this long has been cut off (the platform stops a request at about 28 s). */
export const RUN_STALE_AFTER_MS = 120_000;
/** Attempts cut off within this window count towards the "stalled" decision. */
export const STALLED_WINDOW_MS = 20 * 60_000;
/** This many cut-off attempts in that window stop automatic retries. */
export const STALLED_AFTER_ATTEMPTS = 3;
