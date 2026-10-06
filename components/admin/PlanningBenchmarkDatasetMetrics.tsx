'use client';

// Planning Benchmarks upload - "Dataset metric mapping": which metrics each dataset may receive, maintained without SQL
// (migration 0277). A holder of the activate permission can add a metric to a dataset, change the kinds of file it
// applies to, or remove it; every change needs a reason and a confirmation and is recorded in an append-only audit
// trail. A pair that still has live figures needs a stronger warning, and the live figures are never deleted. Everyone
// who can see the Upload tab can read the mapping and its history.
//
// Nothing here decides authorisation (Admin Standard section 4, layer 4): the capability flag only decides what is
// shown. The route and the database functions enforce it again.
//
// RESULT STATES (sections 8 and 13): loading, a failed request, "the lists are unavailable" and "the mapping is not
// installed yet" are four different things on screen, and none of them is shown as an empty list.
// Dates are day-first.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely } from '@/lib/resources/admin/resultState';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { MAPPING_NOT_INSTALLED_LINE, UNAVAILABLE_LINE, type AllowedDataset, type AllowedValues, type AllowedValuesOk, type MappedMetric } from '@/lib/planning-benchmarks/allowedValues';
import type { MappingEvent, MappingEventsResult } from '@/lib/planning-benchmarks/datasetMetricService';
import { formatDayFirstDateTime } from '@/lib/planning-benchmarks/dayFirst';

export const DATASET_METRICS_URL = '/api/admin/benchmarks/upload/dataset-metrics';

export interface DatasetMetricsPayload {
  allowed: AllowedValues;
  events: MappingEventsResult;
  capabilities: { activate: boolean };
}

export function kindsText(m: { values: boolean; targetRanges: boolean }): string {
  return m.values && m.targetRanges ? 'observed values and planning target ranges' : m.values ? 'observed values' : 'planning target ranges';
}

export function liveText(m: MappedMetric): string {
  const parts: string[] = [];
  if (m.values) parts.push(`${m.liveValues === null ? 'unknown' : m.liveValues} values`);
  if (m.targetRanges) parts.push(`${m.liveBands === null ? 'unknown' : m.liveBands} bands`);
  return parts.join(', ');
}

function liveTotal(m: MappedMetric): number {
  return (m.values ? m.liveValues ?? 0 : 0) + (m.targetRanges ? m.liveBands ?? 0 : 0);
}

/** The wording of the confirmation dialog. Pure, so a test can read it. */
export function confirmWording(a: { action: 'set' | 'remove'; dataset: AllowedDataset; metricCode: string; values: boolean; targetRanges: boolean; existing: MappedMetric | undefined }): { title: string; message: string; confirmLabel: string; destructive: boolean; live: number } {
  const where = `"${a.dataset.name}" version ${a.dataset.version}`;
  if (a.action === 'remove') {
    const live = a.existing ? liveTotal(a.existing) : 0;
    return {
      title: live > 0 ? 'Remove a metric that has live figures?' : 'Remove this metric from the dataset?',
      message:
        `${a.metricCode} will no longer be allowed in ${where}: a file that uses it will be refused from now on.` +
        (live > 0 ? ` WARNING: ${live} live figure(s) exist for this metric in this dataset. They are NOT deleted and stay live, but a corrected upload of this metric will be refused until you map it again.` : ' No live figure is affected.') +
        ' The change is recorded with your reason.',
      confirmLabel: live > 0 ? 'Remove the mapping anyway' : 'Remove the mapping',
      destructive: true,
      live,
    };
  }
  const kinds = kindsText({ values: a.values, targetRanges: a.targetRanges });
  const turnedOff = a.existing ? (a.existing.values && !a.values ? a.existing.liveValues ?? 0 : 0) + (a.existing.targetRanges && !a.targetRanges ? a.existing.liveBands ?? 0 : 0) : 0;
  return {
    title: a.existing ? 'Change the kinds of file for this metric?' : 'Allow this metric in the dataset?',
    message:
      `${a.metricCode} will be allowed in ${where} for ${kinds} files.` +
      (turnedOff > 0 ? ` WARNING: ${turnedOff} live figure(s) exist for the kind you are turning off. They are NOT deleted, but a corrected upload of them will be refused.` : '') +
      ' The change is recorded with your reason.',
    confirmLabel: a.existing ? 'Change the mapping' : 'Add the metric',
    destructive: turnedOff > 0,
    live: turnedOff,
  };
}

function ScrollRegion({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-2 max-h-72 overflow-auto rounded border border-line">
      {children}
    </div>
  );
}

function eventText(e: MappingEvent): string {
  const kinds = (v: boolean | null, r: boolean | null) => (v === null && r === null ? '' : kindsText({ values: v === true, targetRanges: r === true }));
  if (e.action === 'added') return `Added for ${kinds(e.valuesAfter, e.rangesAfter)}`;
  if (e.action === 'removed') return `Removed (was ${kinds(e.valuesBefore, e.rangesBefore)})${e.liveFigures > 0 ? `, ${e.liveFigures} live figure(s) were held and confirmed` : ''}`;
  return `Changed from ${kinds(e.valuesBefore, e.rangesBefore)} to ${kinds(e.valuesAfter, e.rangesAfter)}${e.liveFigures > 0 ? `, ${e.liveFigures} live figure(s) were held and confirmed` : ''}`;
}

export interface MappingViewProps {
  data: DatasetMetricsPayload;
  canManage: boolean;
  busy: boolean;
  datasetId: string;
  onDatasetChange: (id: string) => void;
  form: { metricCode: string; values: boolean; targetRanges: boolean; reason: string };
  onFormChange: (f: { metricCode: string; values: boolean; targetRanges: boolean; reason: string }) => void;
  onSubmitSet: () => void;
  onRemove: (m: MappedMetric) => void;
  onEdit: (m: MappedMetric) => void;
}

/** A pure view of the loaded data (the container only fetches and posts), so the screen test renders it directly. */
export function DatasetMetricsView(p: MappingViewProps) {
  const a = p.data.allowed;
  if (a.state !== 'ok') {
    return (
      <p role="status" className="rounded border border-attention/40 bg-attention/5 p-3 text-sm text-ink" data-testid="pb-mapping-unavailable">
        {UNAVAILABLE_LINE}
      </p>
    );
  }
  if (!a.mapping.installed) {
    return (
      <p role="status" className="rounded border border-attention/40 bg-attention/5 p-3 text-sm text-ink" data-testid="pb-mapping-not-installed">
        {MAPPING_NOT_INSTALLED_LINE} Until it is installed, an upload is not checked against it and nothing here can be changed.
      </p>
    );
  }
  return <MappingLists a={a} p={p} />;
}

function MappingLists({ a, p }: { a: AllowedValuesOk; p: MappingViewProps }) {
  const dataset = a.datasets.find((d) => d.id === p.datasetId) ?? a.datasets[0];
  const events = p.data.events.state === 'ok' ? p.data.events.events : null;
  if (!dataset) return <p role="status" className="text-sm text-muted">No dataset is registered yet.</p>;
  const mappedCodes = new Set(dataset.mappedMetrics.map((m) => m.code));
  const reasonOk = p.form.reason.trim().length >= 3;
  const canSubmit = p.canManage && !p.busy && p.form.metricCode !== '' && (p.form.values || p.form.targetRanges) && p.form.reason.trim().length >= 3;
  return (
    <div className="space-y-4 text-sm" data-testid="pb-mapping-lists">
      <label className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">Dataset</span>
        <select value={dataset.id} onChange={(e) => p.onDatasetChange(e.target.value)} className="min-h-11 min-w-72 rounded border border-line bg-white px-2 text-sm text-ink">
          {a.datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} (version {d.version}, {d.status})
            </option>
          ))}
        </select>
      </label>

      <div>
        <h3 className="font-semibold text-ink">
          {dataset.mappedMetrics.length === 0 ? 'No metric is mapped to this dataset yet' : `${dataset.mappedMetrics.length} ${dataset.mappedMetrics.length === 1 ? 'metric is' : 'metrics are'} mapped to this dataset`}
        </h3>
        {dataset.mappedMetrics.length === 0 && <p className="mt-1 max-w-3xl text-xs text-muted">Nothing can be uploaded to this dataset until at least one metric is added{p.canManage ? ' below' : ' by a holder of the activate permission'}.</p>}
        {dataset.mappedMetrics.length > 0 && (
          <ScrollRegion label={`Metrics mapped to ${dataset.name}`}>
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Metrics mapped to {dataset.name}</caption>
              <thead className="sticky top-0 bg-gray-50 text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">metric_code</th>
                  <th scope="col" className="px-3 py-2">Unit</th>
                  <th scope="col" className="px-3 py-2">Allowed in</th>
                  <th scope="col" className="px-3 py-2">Live figures</th>
                  <th scope="col" className="px-3 py-2">Evidence for the pairing</th>
                  {p.canManage && <th scope="col" className="px-3 py-2">Change</th>}
                </tr>
              </thead>
              <tbody>
                {dataset.mappedMetrics.map((m) => (
                  <tr key={m.code} className="border-t border-line align-top">
                    <td className="px-3 py-2 font-medium text-ink">{m.code}</td>
                    <td className="px-3 py-2">{m.unit}</td>
                    <td className="px-3 py-2">{kindsText(m)}</td>
                    <td className="px-3 py-2">{liveText(m)}</td>
                    <td className="px-3 py-2">{m.evidence ?? ''}</td>
                    {p.canManage && (
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-2">
                          <button type="button" disabled={p.busy} onClick={() => p.onEdit(m)} aria-label={`Change the kinds of file for ${m.code}`} className="min-h-11 rounded border border-line px-3 hover:bg-gray-50 disabled:opacity-50">
                            Change
                          </button>
                          <button type="button" disabled={p.busy || !reasonOk} onClick={() => p.onRemove(m)} aria-label={`Remove ${m.code} from ${dataset.name}`} className="min-h-11 rounded border border-risk/40 px-3 text-risk hover:bg-risk/5 disabled:opacity-50">
                            Remove
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
        {dataset.mappedMetrics.length > 0 && p.canManage && !reasonOk && <p className="mt-1 text-xs text-muted">To remove a metric, first type the reason in the box below. Remove stays unavailable until you do.</p>}
      </div>

      {p.canManage ? (
        <fieldset className="rounded border border-line p-3" data-testid="pb-mapping-form">
          <legend className="px-1 font-semibold text-ink">Add a metric, or change the kinds of file</legend>
          <div className="mt-1 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-ink">Metric</span>
              <select value={p.form.metricCode} onChange={(e) => p.onFormChange({ ...p.form, metricCode: e.target.value })} className="mt-1 block min-h-11 min-w-64 rounded border border-line bg-white px-2">
                <option value="">Choose a metric</option>
                {a.metrics.map((m) => (
                  <option key={m.code} value={m.code}>
                    {m.code} ({m.unit}){mappedCodes.has(m.code) ? ' - already mapped, saving changes the kinds' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={p.form.values} onChange={(e) => p.onFormChange({ ...p.form, values: e.target.checked })} />
              <span>Observed values files</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={p.form.targetRanges} onChange={(e) => p.onFormChange({ ...p.form, targetRanges: e.target.checked })} />
              <span>Planning target ranges files</span>
            </label>
            <label className="block">
              <span className="text-ink">Reason (recorded)</span>
              <input value={p.form.reason} onChange={(e) => p.onFormChange({ ...p.form, reason: e.target.value })} maxLength={500} className="mt-1 block min-h-11 min-w-64 rounded border border-line px-2" />
            </label>
            <button type="button" disabled={!canSubmit} onClick={p.onSubmitSet} className="min-h-11 rounded bg-trust px-4 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-50">
              Save the mapping
            </button>
          </div>
          <p className="mt-2 max-w-3xl text-xs text-muted">A metric that does not exist cannot be created here. You are asked to confirm before anything is saved, and the change is recorded. Live figures are never deleted.</p>
        </fieldset>
      ) : (
        <p role="status" className="text-xs text-muted">You can read the mapping but you do not hold the permission to change it. Ask a Super Admin who can grant the activate permission.</p>
      )}

      <div>
        <h3 className="font-semibold text-ink">Recent changes to the mapping</h3>
        {events === null ? (
          <p role="status" className="mt-1 text-xs text-muted">The history could not be read right now.</p>
        ) : events.length === 0 ? (
          <p className="mt-1 text-xs text-muted">No change has been made through this screen yet. The pairs listed above were seeded by migration 0277.</p>
        ) : (
          <ScrollRegion label="Recent changes to the dataset and metric mapping">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Recent changes to the dataset and metric mapping</caption>
              <thead className="sticky top-0 bg-gray-50 text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">When</th>
                  <th scope="col" className="px-3 py-2">Dataset</th>
                  <th scope="col" className="px-3 py-2">Metric</th>
                  <th scope="col" className="px-3 py-2">Change</th>
                  <th scope="col" className="px-3 py-2">Reason</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={`${e.at}|${i}`} className="border-t border-line align-top">
                    <td className="whitespace-nowrap px-3 py-2">{formatDayFirstDateTime(e.at)}</td>
                    <td className="px-3 py-2">
                      {e.datasetName} {e.datasetVersion}
                    </td>
                    <td className="px-3 py-2">{e.metricCode}</td>
                    <td className="px-3 py-2">{eventText(e)}</td>
                    <td className="px-3 py-2">{e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        )}
      </div>
    </div>
  );
}

type Pending = { action: 'set' | 'remove'; metricCode: string; values: boolean; targetRanges: boolean; reason: string } | null;

export function PlanningBenchmarkDatasetMetrics({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<DatasetMetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [datasetId, setDatasetId] = useState('');
  const [form, setForm] = useState({ metricCode: '', values: true, targetRanges: false, reason: '' });
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();

  const load = useCallback(async () => {
    try {
      const res = await fetch(DATASET_METRICS_URL);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        const f = failureFromResponse(res.status, json, 'the dataset metric mapping');
        setError(`${f.title} ${f.message}`);
        setData(null);
        return;
      }
      setError(null);
      setData((json?.data as DatasetMetricsPayload) ?? null);
    } catch (e) {
      const f = failureFromThrown(e, 'the dataset metric mapping');
      setError(`${f.title} ${f.message}`);
      setData(null);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const okData: AllowedValuesOk | null = data && data.allowed.state === 'ok' ? data.allowed : null;
  const dataset = okData?.datasets.find((d) => d.id === datasetId) ?? okData?.datasets[0];
  const existingFor = (code: string): MappedMetric | undefined => dataset?.mappedMetrics.find((m) => m.code === code);
  const wording = useMemo(() => {
    if (!pending || !dataset) return null;
    return confirmWording({ action: pending.action, dataset, metricCode: pending.metricCode, values: pending.values, targetRanges: pending.targetRanges, existing: existingFor(pending.metricCode) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, dataset]);

  async function send() {
    if (!pending || !dataset || !wording) return;
    setBusy(true);
    clearOutcome();
    try {
      const res = await fetch(DATASET_METRICS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: pending.action,
          datasetId: dataset.id,
          metricCode: pending.metricCode,
          ...(pending.action === 'set' ? { appliesToValues: pending.values, appliesToTargetRanges: pending.targetRanges } : {}),
          reason: pending.reason,
          confirmed: true,
          // The dialog the person just confirmed showed the live figure count and warned in words.
          confirmLiveFigures: wording.live > 0,
        }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'save this change to the mapping'));
        return;
      }
      reportSuccess(pending.action === 'remove' ? 'The metric is no longer mapped to the dataset. The change is recorded below. No live figure was changed.' : 'The mapping is saved and recorded below.');
      if (pending.action === 'set') setForm({ metricCode: '', values: true, targetRanges: false, reason: '' });
      await load();
    } catch {
      reportFailure('Could not reach the server, so nothing was changed.');
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <details className="mt-1 text-sm" data-testid="pb-mapping-panel">
      <summary className="min-h-11 cursor-pointer py-2 font-medium text-trust">Show and maintain the mapping</summary>
      <div className="mt-2 space-y-3">
        <AdminActionStatus outcome={outcome} />
        {wording && pending && (
          <ConfirmDialog
            open
            title={wording.title}
            message={wording.message}
            confirmLabel={wording.confirmLabel}
            cancelLabel="Cancel"
            destructive={wording.destructive}
            onConfirm={() => void send()}
            onCancel={() => setPending(null)}
          />
        )}
        {error && (
          <p role="alert" className="rounded border border-risk/40 bg-risk/5 p-3 text-sm text-ink">
            {error}{' '}
            <button type="button" onClick={() => void load()} className="min-h-11 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10">
              Retry
            </button>
          </p>
        )}
        {!error && !data && (
          <p role="status" aria-live="polite" className="text-sm text-muted">
            Loading the mapping…
          </p>
        )}
        {data && (
          <DatasetMetricsView
            data={data}
            canManage={canManage}
            busy={busy}
            datasetId={dataset?.id ?? ''}
            onDatasetChange={(id) => {
              setDatasetId(id);
              setForm({ metricCode: '', values: true, targetRanges: false, reason: '' });
            }}
            form={form}
            onFormChange={setForm}
            onSubmitSet={() => setPending({ action: 'set', metricCode: form.metricCode, values: form.values, targetRanges: form.targetRanges, reason: form.reason.trim() })}
            onRemove={(m) => setPending({ action: 'remove', metricCode: m.code, values: m.values, targetRanges: m.targetRanges, reason: form.reason.trim() })}
            onEdit={(m) => setForm({ metricCode: m.code, values: m.values, targetRanges: m.targetRanges, reason: '' })}
          />
        )}
      </div>
    </details>
  );
}
