import { after } from 'next/server';
import { requireCountryConfirmedUser as requireUser, ok, bad } from '@/lib/api';
import { generateReport, type ReportTypeCode } from '@/lib/services/reportsData';
import { waitingResponseFor } from '@/lib/services/investment-intelligence/pc6/reportNavHistoryGate';
import { configuredReportDeadlineMs, raceWithDeadline } from '@/lib/services/reportDeadline';
import { newCorrelationId, preparingResponse, responseForGenerationError, unexpectedErrorResponse } from '@/lib/services/reportApiResponses';

// 16-10-2026: this route ALWAYS answers with JSON a browser can parse.
//   200  { data: { report, sectionCount, alreadyExisted } }            the report is complete and saved
//   202  { data: { waiting: ... } }                                     held until price history is loaded (PO 2026-10-03)
//   202  { data: { preparing: true, runId, retryAfterMs, message } }    still being prepared: ask again (idempotent)
//   4xx/5xx { error, code, correlationId, retryable }                   plain message, never a database message
// The platform cuts a request at about 28 s and returns an empty or HTML body, which is what made the browser report
// "Unexpected end of JSON input". An internal deadline (22 s by default, including sign-in and the response) returns
// the typed 202 instead; the preparation itself continues, and asking again never starts a second one.
// The response no longer carries every section (the scenario projections alone are over a megabyte): the page that
// opens the report reads them from the database, and `sectionCount` says how many were saved.
export async function POST(req: Request) {
  const startedMs = Date.now();
  const correlationId = newCorrelationId();
  let runId: string | null = null;
  try {
    const { user, unauthenticated } = await requireUser();
    if (!user) return unauthenticated!;
    const body = await req.json().catch(() => ({}));

    const today = new Date();
    const requestedMonth = typeof body.reportMonth === 'string' ? body.reportMonth : undefined;
    if (requestedMonth && new Date(requestedMonth) > today) {
      return bad('Cannot generate a report for a future month', 422);
    }

    const work = generateReport({
      userId: user.id,
      reportType: (body.reportType as ReportTypeCode) ?? 'monthly_financial_health',
      reportMonth: requestedMonth,
      triggerType: 'manual',
      onRunStarted: (id) => {
        runId = id;
      },
    });

    const remainingMs = configuredReportDeadlineMs() - (Date.now() - startedMs);
    const outcome = await raceWithDeadline(work, remainingMs);
    if (outcome.kind === 'late') {
      console.warn('[reports] generate passed its internal deadline; answering 202 preparing', { correlationId, runId, elapsedMs: Date.now() - startedMs });
      try {
        // Ask the platform to keep the invocation alive until the preparation finishes (best effort).
        after(() => work.then(() => undefined, () => undefined));
      } catch {
        /* not in a request scope (tests): the work still runs to completion */
      }
      return preparingResponse(correlationId, runId);
    }

    const result = outcome.value;
    return ok({ report: result.report, sectionCount: result.sections.length, alreadyExisted: result.alreadyExisted });
  } catch (e) {
    // PO 2026-10-03: held until the price history of the user's funds is loaded (HTTP 202, nothing stored).
    const waiting = waitingResponseFor(e);
    if (waiting) return waiting;
    const typed = responseForGenerationError(e, correlationId);
    if (typed) return typed;
    console.error('[reports] generate failed', { correlationId, runId, elapsedMs: Date.now() - startedMs, message: e instanceof Error ? e.message : String(e), stack: e instanceof Error ? e.stack?.split('\n').slice(0, 6).join(' | ') : undefined });
    return unexpectedErrorResponse(correlationId);
  }
}
