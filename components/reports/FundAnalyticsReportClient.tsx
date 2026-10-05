'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import FundAnalyticsReportView from '@/components/reports/FundAnalyticsReportView';
import { ActionMessage, Btn, Notice, SelectField } from '@/components/admin/benchmarkData/ui';
import { REPORT_PERIOD_CHOICES, REPORT_PERIOD_LABELS, type ReportPeriodChoice } from '@/lib/engines/nav2/analysisSpec';
import type { FundAnalyticsReport } from '@/lib/engines/nav2/fundAnalyticsReport';
import { formatDateShort, formatDateTimeShort } from '@/lib/engines/date';

// Interactive shell of the Fund analytics report: choose a period, generate the next version, switch between earlier
// versions, download the PDF. Everything shown comes from the Premium-gated API; a 403 / 404 / 5xx is shown as such, never as
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

export default function FundAnalyticsReportClient() {
  const [versions, setVersions] = useState<Summary[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [report, setReport] = useState<FundAnalyticsReport | null>(null);
  const [period, setPeriod] = useState<ReportPeriodChoice>('since_first_held');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [exporting, setExporting] = useState(false);
  const polls = useRef(0);

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

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch('/api/reports/fund-analytics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ period }) });
      const j = await r.json().catch(() => null);
      if (r.status === 202) {
        setWaiting(j.data as Waiting);
        return;
      }
      setWaiting(null);
      if (!r.ok) {
        setError(j?.error ?? `The report could not be generated (${r.status}).`);
        return;
      }
      if (j.data.status === 'no_funds') {
        setNotice(j.data.message as string);
        return;
      }
      await loadList(false);
      await loadReport(j.data.report.id as string);
    } catch {
      setError('The report could not be generated.');
    } finally {
      setBusy(false);
    }
  }, [period, loadList, loadReport]);

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

  async function exportPdf() {
    if (!selectedId) return;
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/reports/fund-analytics/${selectedId}/export`);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('Content-Disposition') ?? '';
      a.download = /filename="([^"]+)"/.exec(cd)?.[1] ?? 'fund-analytics-report.pdf';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The PDF could not be generated.');
    } finally {
      setExporting(false);
    }
  }

  const sel = versions?.find((v) => v.id === selectedId) ?? null;
  const periodOptions = REPORT_PERIOD_CHOICES.map((c) => ({ value: c, label: REPORT_PERIOD_LABELS[c] }));
  const versionOptions = (versions ?? []).map((v) => ({ value: v.id, label: `Version ${v.versionNumber} - as at ${formatDateShort(v.asOfDate, 'INR')} (made ${formatDateTimeShort(v.createdAt, 'INR')})` }));
  return (
    <div className="space-y-6">
      <div className="no-print">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[12rem]">
            <SelectField label="Period" value={period} hidePlaceholder options={periodOptions} onChange={(v) => setPeriod(v as ReportPeriodChoice)} />
          </div>
          <Btn kind="primary" busy={busy} onClick={() => void generate()}>
            {versions && versions.length > 0 ? 'Generate a new version' : 'Generate report'}
          </Btn>
          {versions && versions.length > 0 && (
            <div className="min-w-[14rem] max-w-full flex-1">
              <SelectField label="Version" value={selectedId ?? ''} hidePlaceholder options={versionOptions} onChange={(v) => void loadReport(v)} />
            </div>
          )}
          {report && (
            <>
              <Btn kind="secondary" busy={exporting} onClick={() => void exportPdf()}>
                Export PDF
              </Btn>
              <Btn kind="secondary" onClick={() => window.print()}>
                Print
              </Btn>
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
      {waiting && (
        <div role="status" aria-live="polite" className="rounded-card border border-line p-4 text-sm text-ink">
          <p className="font-medium">{waiting.headline ?? 'Price history is being prepared.'}</p>
          {waiting.waitingFunds.length > 0 && <p className="mt-1 text-muted">Still loading: {waiting.waitingFunds.join('; ')}.</p>}
          <p className="mt-1 text-muted">This screen checks again by itself; you can also come back later.</p>
        </div>
      )}
      {sel && <p className="no-print text-xs text-muted">This is a saved report: it does not change when prices are later corrected. Generate a new version to include them.</p>}
      {versions && versions.length === 0 && !waiting && !notice && !error && <p className="text-sm text-muted">No report has been generated yet. Choose a period and generate your first one.</p>}
      {report && <FundAnalyticsReportView report={report} />}
    </div>
  );
}
