'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';
import { OpenPrintTabLink } from '@/components/reports/OpenPrintTabLink';
import { FundPickPanel } from '@/components/reports/FundPickPanel';
import { ActionMessage, Btn, Notice, SelectField } from '@/components/admin/benchmarkData/ui';
import type { PickState } from '@/lib/reports/fundPicker';
import { batchProgressLine, fitsCombinedPdf, initialBatches, planBatches, reportCountFor, runBatches, summarizeRun, type BatchCandidate, type BatchState } from '@/lib/reports/fundAnalyticsGenerateAll';
import { combinedPrintHref } from '@/lib/reports/fundAnalyticsCombinedPrint';
import { REPORT_PERIOD_CHOICES, REPORT_PERIOD_LABELS, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { formatDateShort, formatDateTimeShort, viewerTimeZone } from '@/lib/engines/date';
import { FUND_ANALYTICS_SAVED_REPORT_SENTENCE, versionMadeLine } from '@/lib/engines/nav2/reportWording';

// Interactive shell of the Fund analytics report: choose a period, generate the next version, switch between earlier
// versions, print it or save it as a PDF (the browser print flow, free: no server PDF). Everything shown comes from the Premium-gated API; a 403 / 404 / 5xx is shown as such, never as
// an empty report. While price history is still being prepared the API answers 202 and this screen says so and offers to
// check again (it also checks by itself every 15 seconds for up to 10 minutes).

interface Summary {
  id: string;
  versionNumber: number;
  asOfDate: string;
  schemeCount: number;
  createdAt: string;
  periodChoice: ReportPeriodChoice | null;
}
interface Waiting {
  headline: string | null;
  loaded: number;
  total: number;
  waitingFunds: string[];
  unavailableFunds: string[];
}

/** The funds a person can choose from when they hold more than one report covers (the API's 409 answer). */
type FundPick = PickState;

/** An opaque key for one intended report: a UUID (the server accepts 16 to 64 letters, digits, underscores or hyphens). */
function newAttemptKey(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

export default function FundAnalyticsReportClient() {
  const [versions, setVersions] = useState<Summary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<FundAnalyticsReport | null>(null);
  const [period, setPeriod] = useState<ReportPeriodChoice>('since_first_held');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [pick, setPick] = useState<FundPick | null>(null);
  // the funds chosen for the report being made: kept so the screen's own re-checks (while it is prepared in steps) ask for the same funds
  const fundIds = useRef<string[] | null>(null);
  // when a second report is wanted for the funds the last one left out, these are ticked first
  const preselect = useRef<string[] | null>(null);
  // ONE KEY PER INTENDED REPORT (release candidate B3). A click that starts a report makes a key; the screen's own re-checks while the report is
  // prepared in steps, a second click while one is running and a retry after a timeout all send the SAME key, so the server issues ONE report.
  // The key is dropped once the report is issued or the request ends in an answer that is not "ask again".
  const attemptKey = useRef<string | null>(null);
  const inFlight = useRef(false);
  const polls = useRef(0);
  // "Generate all my funds": the batches of the current run (one report each), the funds' names for the plain messages, and ONE KEY PER BATCH that is kept
  // for the life of this screen once a batch is saved, so pressing the button again replays the saved reports instead of making copies.
  const [run, setRun] = useState<BatchState[] | null>(null);
  const [runNames, setRunNames] = useState<Record<string, string>>({}); // instrument id -> fund name, for the plain "not covered yet" message
  const askForAll = useRef(false);
  const mounted = useRef(true);
  const runPlan = useRef<{ period: ReportPeriodChoice; batches: BatchState[] } | null>(null);
  const batchKeys = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const loadReport = useCallback(async (id: string) => {
    setError(null);
    const r = await fetch(`/api/reports/fund-analytics/${id}`);
    const j = await r.json().catch(() => null);
    if (!r.ok) {
      setReport(null);
      setError(j?.error ?? `Could not load the report (${r.status}).`);
      return;
    }
    setReport(j.data.report as FundAnalyticsReport);
    setSelectedId(id);
  }, []);

  const loadList = useCallback(
    async (selectLatest: boolean) => {
      const r = await fetch('/api/reports/fund-analytics');
      const j = await r.json().catch(() => null);
      if (!r.ok) {
        setError(j?.error ?? `Could not load your reports (${r.status}).`);
        setVersions([]);
        return;
      }
      const list = (j.data as Summary[]) ?? [];
      setVersions(list);
      if (selectLatest && list.length > 0) await loadReport(list[0].id);
    },
    [loadReport]
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await loadList(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadList]);

  // GENERATE ALL (PO decision 20-10-2026, option B): the person's reports one after the other, at most FUND_ANALYTICS_MAX_FUNDS funds each (lib/reports/fundAnalyticsGenerateAll.ts).
  // `request` starts a run from the 409 answer's funds; no argument continues the current run ("Try the remaining funds again": the saved batches are skipped, the others
  // are asked for with the SAME keys). Never two requests at once: the single-report path and this one share inFlight.
  const generateAll = useCallback(
    async (request?: { candidates: BatchCandidate[]; max: number }) => {
      if (inFlight.current) return;
      if (request) {
        setRunNames(Object.fromEntries(request.candidates.map((c) => [c.instrumentId, c.schemeName])));
        runPlan.current = { period, batches: initialBatches(planBatches(request.candidates, request.max)) };
      }
      const rp = runPlan.current;
      if (!rp) return;
      inFlight.current = true;
      setBusy(true);
      setError(null);
      setNotice(null);
      setWaiting(null);
      setPick(null);
      setRun(rp.batches);
      const keyId = (b: BatchState) => `${rp.period}|${b.fundIds.join(',')}`;
      try {
        const final = await runBatches(rp.batches, {
          post: async (funds, key) => {
            const r = await fetch('/api/reports/fund-analytics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ period: rp.period, funds }) });
            const j = await r.json().catch(() => null);
            return { status: r.status, body: j };
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          keyFor: (b) => {
            let k = batchKeys.current.get(keyId(b));
            if (!k) {
              k = newAttemptKey();
              batchKeys.current.set(keyId(b), k);
            }
            return k;
          },
          dropKey: (b) => void batchKeys.current.delete(keyId(b)),
          cancelled: () => !mounted.current,
          onChange: (bs) => {
            rp.batches = bs;
            if (mounted.current) setRun(bs);
          },
        });
        if (!mounted.current) return;
        rp.batches = final;
        await loadList(false);
        const first = final.find((b) => b.reportId);
        if (first?.reportId) await loadReport(first.reportId);
      } catch {
        setError('The reports could not be generated.');
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [period, loadList, loadReport]
  );

  const generate = useCallback(async (funds?: string[] | null) => {
    // a second click while a request is running does nothing (and could not make a second report anyway: it would carry the same key)
    if (inFlight.current) return;
    inFlight.current = true;
    let startAll: { candidates: BatchCandidate[]; max: number } | null = null;
    // a click (funds given) starts a new intended report; the screen's own re-check (no argument) continues the current one
    if (funds !== undefined) {
      fundIds.current = funds;
      attemptKey.current = null;
    }
    if (!attemptKey.current) attemptKey.current = newAttemptKey();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch('/api/reports/fund-analytics', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attemptKey.current }, body: JSON.stringify({ period, ...(fundIds.current ? { funds: fundIds.current } : {}) }) });
      const j = await r.json().catch(() => null);
      if (r.status === 503 && j?.data?.status === 'timed_out') {
        // the request ran out of its own time: nothing was lost, so say so and ask again by itself with the same key
        setWaiting({ headline: j.error as string, loaded: 0, total: 0, waitingFunds: [], unavailableFunds: [] });
        return;
      }
      if (r.status === 409 && j?.data?.status === 'select_funds') {
        // more funds held than one report covers: show the plain message and let the person choose (the largest holdings are ticked first)
        const d = j.data as { message: string; max: number; heldFundCount: number; candidates: FundPick['candidates']; suggestedIds: string[] };
        if (askForAll.current) {
          // "Generate all my funds" was pressed on a report that left funds out: the answer lists every held fund, so the batches can be planned from it
          askForAll.current = false;
          fundIds.current = null;
          setWaiting(null);
          startAll = { candidates: d.candidates, max: d.max };
          return;
        }
        const covered = preselect.current;
        const wanted = covered ? d.candidates.filter((c) => !covered.includes(c.instrumentId)).map((c) => c.instrumentId) : [];
        preselect.current = null;
        fundIds.current = null;
        setWaiting(null);
        setPick({ max: d.max, heldFundCount: d.heldFundCount, candidates: d.candidates, chosen: (wanted.length > 0 ? wanted : d.suggestedIds).slice(0, d.max), suggested: d.suggestedIds });
        setNotice(d.message);
        return;
      }
      if (r.status === 202) {
        setWaiting(j.data as Waiting);
        return;
      }
      setWaiting(null);
      if (!r.ok) {
        attemptKey.current = null; // an answer that is not "ask again": the next click is a new intended report
        setError(j?.error ?? `The report could not be generated (${r.status}).`);
        return;
      }
      if (j.data.status === 'no_funds') {
        attemptKey.current = null;
        setNotice(j.data.message as string);
        return;
      }
      attemptKey.current = null; // issued: the next click makes a NEW report
      setPick(null);
      await loadList(false);
      await loadReport(j.data.report.id as string);
    } catch {
      setError('The report could not be generated.');
    } finally {
      askForAll.current = false;
      inFlight.current = false;
      setBusy(false);
      // "Generate all" was asked on a report that left funds out: the 409 answer listed every fund held, so the batches start now (one request at a time: inFlight is free again)
      if (startAll) void generateAll(startAll);
    }
  }, [period, loadList, loadReport, generateAll]);

  // While history is being prepared, ask again by itself (bounded).
  useEffect(() => {
    if (!waiting) {
      polls.current = 0;
      return;
    }
    if (polls.current >= 40) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void generate();
    }, 15000);
    return () => clearTimeout(t);
  }, [waiting, generate]);

  // the viewer's time zone travels in the print address, so the printed "made" time is the one this screen shows (the print page renders on the server)
  const viewerTz = viewerTimeZone();
  const sel = versions?.find((v) => v.id === selectedId) ?? null;
  const runSummary = run ? summarizeRun(run, (id) => runNames[id] ?? 'a fund') : null;
  const periodOptions = REPORT_PERIOD_CHOICES.map((c) => ({ value: c, label: REPORT_PERIOD_LABELS[c] }));
  const versionOptions = (versions ?? []).map((v) => ({ value: v.id, label: `Version ${v.versionNumber} - as at ${formatDateShort(v.asOfDate, 'INR')} (made ${formatDateTimeShort(v.createdAt, 'INR')})` }));
  return (
    <div className="space-y-6">
      <div className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem]">
            <SelectField label="Period" value={period} hidePlaceholder options={periodOptions} onChange={(v) => setPeriod(v as ReportPeriodChoice)} />
          </div>
          <Btn kind="primary" busy={busy} onClick={() => void generate(null)}>
            {versions && versions.length > 0 ? 'Generate a new version' : 'Generate report'}
          </Btn>
          {versions && versions.length > 0 && (
            <div className="min-w-[14rem] max-w-full flex-1">
              <SelectField label="Version" value={selectedId ?? ''} hidePlaceholder options={versionOptions} onChange={(v) => void loadReport(v)} />
            </div>
          )}
          {report && (
            <>
              {/* PO decision 18-10-2026 (print flow): the same single button as the Monthly Report. It opens the print view in its own tab from the
                  click and prints, and the tab closes itself afterwards. NO server PDF call (Amplify has no Chromium at runtime). */}
              {selectedId && (
                <OpenPrintTabLink
                  href={`/reports/fund-analytics/print?id=${encodeURIComponent(selectedId)}&print=1${viewerTz ? `&tz=${encodeURIComponent(viewerTz)}` : ''}`}
                  windowName={`fund-analytics-${selectedId}`}
                  className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust"
                >
                  Print / Save as PDF
                </OpenPrintTabLink>
              )}
            </>
          )}
        </div>
        {/* The result of the button just pressed sits right under the buttons, scrolled into view and focused. */}
        <ActionMessage message={error ? { kind: 'error', text: error } : null} />
      </div>

      {notice && (
        <Notice tone="info" live="status">
          {notice}
        </Notice>
      )}
      {pick && (
        <FundPickPanel
          pick={pick}
          onChange={setPick}
          busy={busy}
          onGenerate={(ids) => void generate(ids)}
          reportCount={reportCountFor(pick.heldFundCount, pick.max)}
          onGenerateAll={() => void generateAll({ candidates: pick.candidates, max: pick.max })}
        />
      )}
      {report?.selection && report.selection.heldFundCount > report.selection.max && !pick && (
        <div className="no-print flex flex-wrap items-center gap-3 text-sm text-ink" data-testid="rest-of-funds">
          <span>
            This report covers {report.selection.chosenCount} of your {report.selection.heldFundCount} funds.
          </span>
          <Btn
            kind="secondary"
            busy={busy}
            onClick={() => {
              preselect.current = report.selection!.chosenInstrumentIds;
              // ask without a choice: the answer lists the funds, and the ones this report left out are ticked
              void generate(null);
            }}
          >
            Choose the other funds
          </Btn>
          <Btn
            kind="secondary"
            busy={busy}
            onClick={() => {
              // the answer to a request without a choice lists every fund held: the batches are planned from it
              askForAll.current = true;
              void generate(null);
            }}
          >
            Generate all my funds ({reportCountFor(report.selection.heldFundCount, report.selection.max)} reports)
          </Btn>
        </div>
      )}
      {run && runSummary && (
        <div role="status" aria-live="polite" className="no-print rounded-card border border-line p-4 text-sm text-ink" data-testid="generate-all-progress">
          <p className="font-medium">{runSummary.phase === 'running' ? 'Making all your reports, one after the other.' : runSummary.phase === 'done' ? 'All your funds are covered.' : 'Some funds are not covered yet.'}</p>
          <ul className="mt-2 space-y-1">
            {run.map((b) => (
              <li key={b.index} data-testid={`generate-all-batch-${b.index + 1}`}>
                {batchProgressLine(b, run.length)}
              </li>
            ))}
          </ul>
          {runSummary.message && <p className="mt-2" data-testid="generate-all-partial">{runSummary.message}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {runSummary.phase === 'partial' && (
              <Btn kind="primary" busy={busy} onClick={() => void generateAll()}>
                Try the remaining funds again
              </Btn>
            )}
            {runSummary.phase === 'done' && fitsCombinedPdf(run.length) && (
              <OpenPrintTabLink
                href={combinedPrintHref(runSummary.readyReportIds, viewerTz)}
                windowName={`fund-analytics-all-${runSummary.readyReportIds.join('-').slice(0, 60)}`}
                className="rounded border px-3 py-1.5 text-sm text-gray-700 hover:border-trust"
              >
                Save all as one PDF
              </OpenPrintTabLink>
            )}
          </div>
          {runSummary.phase === 'done' && fitsCombinedPdf(run.length) && (
            <p className="mt-2 text-muted">One PDF with all {run.length} reports, one after the other. Funds are compared only within the same report.</p>
          )}
          {runSummary.phase === 'done' && run.length > 1 && !fitsCombinedPdf(run.length) && <p className="mt-2 text-muted">These reports are too many for one PDF; print each one with Print / Save as PDF.</p>}
        </div>
      )}
      {waiting && (
        <div role="status" aria-live="polite" className="rounded-card border border-line p-4 text-sm text-ink">
          <p className="font-medium">{waiting.headline ?? 'Price history is being prepared.'}</p>
          {waiting.waitingFunds.length > 0 && <p className="mt-1 text-muted">Still loading: {waiting.waitingFunds.join('; ')}.</p>}
          <p className="mt-1 text-muted">This screen checks again by itself; you can also come back later.</p>
        </div>
      )}
      {sel && (
        <p className="no-print text-xs text-muted" data-testid="saved-report-line">
          {versionMadeLine(sel.versionNumber, sel.createdAt)}. {FUND_ANALYTICS_SAVED_REPORT_SENTENCE}
        </p>
      )}
      {versions && versions.length === 0 && !waiting && !notice && !error && <p className="text-sm text-muted">No report has been generated yet. Choose a period and generate your first one.</p>}
      {report && <FundAnalyticsReportView report={report} />}
    </div>
  );
}
