'use client';

// Planning Benchmarks upload - the collapsible "Allowed values" panel on the Upload tab. It shows the SAME live
// lists the downloaded template's Read me sheet prints (allowedValues.ts), so a person does not need to open
// the file to see which datasets, metrics (with their units) and cohorts a file may name.
//
// RESULT STATES (Admin Standard sections 8 and 13): loading, a failed request and "the lists are unavailable"
// are three different things on screen, and none of them is shown as an empty list.
//
// The view is a pure function of its data (the container only fetches), so the screen test renders it directly.
// Dates a person reads are day-first; there are none other than the "read on" line.
import { useCallback, useEffect, useId, useState } from 'react';
import { failureFromResponse, failureFromThrown, readJsonSafely } from '@/lib/resources/admin/resultState';
import { cohortsHeading, datasetMetricsSection, datasetsHeading, metricsHeading, MAPPING_NOT_INSTALLED_LINE, UNAVAILABLE_LINE, type AllowedDataset, type AllowedValues, type AllowedValuesOk } from '@/lib/planning-benchmarks/allowedValues';
import { formatDayFirst } from '@/lib/planning-benchmarks/dayFirst';
import { KIND_LABEL, UPLOAD_KINDS, columnGuide, type UploadKind } from '@/lib/planning-benchmarks/uploadSchema';

export const ALLOWED_VALUES_JSON_URL = '/api/admin/benchmarks/upload/allowed-values';
export const ALLOWED_VALUES_CSV_URL = '/api/admin/benchmarks/upload/allowed-values?format=csv';

function acceptsText(d: AllowedDataset): string {
  const ok = UPLOAD_KINDS.filter((k) => d.accepts[k].accepted);
  if (ok.length === 0) return `none (${d.closedReason ?? 'closed'})`;
  if (ok.length === UPLOAD_KINDS.length) return 'all three kinds';
  return ok.map((k) => KIND_LABEL[k]).join(', ');
}

export function summaryText(data: AllowedValues | null): string {
  if (!data) return 'Allowed values and column guide (columns, datasets, metrics with units, cohorts)';
  if (data.state !== 'ok') return 'Allowed values (unavailable right now)';
  return `Allowed values: ${data.counts.datasetsOpen} ${data.counts.datasetsOpen === 1 ? 'dataset is' : 'datasets are'} open for upload, ${data.counts.metricsTotal} metrics, ${data.counts.cohortsTotal} cohorts`;
}

function ScrollRegion({ label, children }: { label: string; children: React.ReactNode }) {
  // A scrollable region must be reachable and named for keyboard and screen reader users.
  return (
    <div role="region" aria-label={label} tabIndex={0} className="mt-2 max-h-72 overflow-auto rounded border border-line">
      {children}
    </div>
  );
}

/**
 * Part 1: the Column | Required | Type | Description table of the template, from the same schema the XLSX Read
 * me sheet prints (columnGuide). Static, so it shows even when the live lists are unavailable.
 */
export function ColumnGuide() {
  const [kind, setKind] = useState<UploadKind>('values');
  const selectId = useId();
  const rows = columnGuide(kind);
  return (
    <section aria-labelledby="pb-av-columns" data-testid="pb-column-guide">
      <h3 id="pb-av-columns" className="text-base font-semibold text-ink">
        Part 1. Columns: what each header means
      </h3>
      <label htmlFor={selectId} className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Kind of file</span>
        <select id={selectId} value={kind} onChange={(e) => setKind(e.target.value as UploadKind)} className="min-h-11 rounded border border-line bg-white px-2 text-sm text-ink">
          {UPLOAD_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      <ScrollRegion label={`Columns of the ${KIND_LABEL[kind]} template`}>
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Columns of the {KIND_LABEL[kind]} template</caption>
          <thead className="sticky top-0 bg-gray-50 text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Column</th>
              <th scope="col" className="px-3 py-2">Required</th>
              <th scope="col" className="px-3 py-2">Type</th>
              <th scope="col" className="px-3 py-2">Description</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-line align-top">
                <td className="px-3 py-2 font-medium text-ink">{r.name}</td>
                <td className="px-3 py-2">{r.required}</td>
                <td className="px-3 py-2">{r.type}</td>
                <td className="px-3 py-2">{r.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </section>
  );
}

export function AllowedValuesView({ data }: { data: AllowedValues }) {
  if (data.state !== 'ok') {
    return (
      <p role="status" className="rounded border border-attention/40 bg-attention/5 p-3 text-sm text-ink" data-testid="pb-allowed-unavailable">
        {UNAVAILABLE_LINE}
      </p>
    );
  }
  return <AllowedValuesLists data={data} />;
}

function AllowedValuesLists({ data }: { data: AllowedValuesOk }) {
  return (
    <div className="space-y-5 text-sm" data-testid="pb-allowed-lists">
      <p className="text-xs text-muted">Lists read from the database on {formatDayFirst(data.readOnIso)}. If a dataset, metric or cohort is not listed here, the upload will refuse it.</p>

      <section aria-labelledby="pb-av-datasets">
        <h3 id="pb-av-datasets" className="text-base font-semibold text-ink">
          Part 2. Allowed datasets and metrics
        </h3>
        <h4 className="mt-2 font-semibold text-ink">{datasetsHeading(data)}</h4>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          {data.counts.datasetsTotal} are registered; {data.counts.datasetsClosed} cannot receive an upload. Type dataset_name and dataset_version exactly as shown. An upload never creates a dataset.
        </p>
        <ScrollRegion label="Datasets that are registered, and whether each is open for upload">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Datasets</caption>
            <thead className="sticky top-0 bg-gray-50 text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">dataset_name</th>
                <th scope="col" className="px-3 py-2">dataset_version</th>
                <th scope="col" className="px-3 py-2">Class</th>
                <th scope="col" className="px-3 py-2">Status</th>
                <th scope="col" className="px-3 py-2">Source</th>
                <th scope="col" className="px-3 py-2">Accepts</th>
              </tr>
            </thead>
            <tbody>
              {data.datasets.map((d) => (
                <tr key={`${d.name}|${d.version}`} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium text-ink">{d.name}</td>
                  <td className="px-3 py-2">{d.version}</td>
                  <td className="px-3 py-2">{d.benchmarkClass}</td>
                  <td className="px-3 py-2">{d.status}</td>
                  <td className="px-3 py-2">{d.sourceName ?? 'none'}</td>
                  <td className="px-3 py-2">{acceptsText(d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <section aria-labelledby="pb-av-metrics">
        <h4 id="pb-av-metrics" className="font-semibold text-ink">
          {metricsHeading(data)}
        </h4>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          In an observed values file, unit must equal the unit shown. In a planning target ranges file the bounds are in that unit (there is no unit column). An upload cannot create a metric.
        </p>
        <ScrollRegion label="Registered metrics and the unit each must be uploaded in">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Metrics</caption>
            <thead className="sticky top-0 bg-gray-50 text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">metric_code</th>
                <th scope="col" className="px-3 py-2">Name</th>
                <th scope="col" className="px-3 py-2">Unit</th>
                <th scope="col" className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m) => (
                <tr key={m.code} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium text-ink">{m.code}</td>
                  <td className="px-3 py-2">{m.name}</td>
                  <td className="px-3 py-2">{m.unit}</td>
                  <td className="px-3 py-2">{m.active ? 'active' : 'inactive (retired)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>

      <MappingSection data={data} />

      <section aria-labelledby="pb-av-cohorts">
        <h3 id="pb-av-cohorts" className="text-base font-semibold text-ink">
          Part 3. Cohorts: {cohortsHeading(data)}
        </h3>
        <p className="mt-1 max-w-3xl text-xs text-muted">In an observed values file, cohort_code must be one of these, or blank for a country-wide figure.</p>
        <ScrollRegion label="Registered cohorts">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Cohorts</caption>
            <thead className="sticky top-0 bg-gray-50 text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">cohort_code</th>
                <th scope="col" className="px-3 py-2">Description</th>
                <th scope="col" className="px-3 py-2">Country</th>
                <th scope="col" className="px-3 py-2">Age band</th>
              </tr>
            </thead>
            <tbody>
              {data.cohorts.map((c) => (
                <tr key={c.code} className="border-t border-line align-top">
                  <td className="px-3 py-2 font-medium text-ink">{c.code}</td>
                  <td className="px-3 py-2">{c.description}</td>
                  <td className="px-3 py-2">{c.countryCode ?? 'any'}</td>
                  <td className="px-3 py-2">{c.ageBand ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollRegion>
      </section>
    </div>
  );
}

/**
 * The allowed metrics PER DATASET, printed from datasetMetricsSection: the very rows the validator enforces and the
 * Read me sheet prints. Not installed is a visible warning, never an empty table that looks complete.
 */
export function MappingSection({ data }: { data: AllowedValuesOk }) {
  const section = datasetMetricsSection(data, 'all');
  return (
    <section aria-labelledby="pb-av-mapping" data-testid="pb-allowed-mapping">
      <h4 id="pb-av-mapping" className="font-semibold text-ink">
        Allowed metrics per dataset: {section.heading}
      </h4>
      {!data.mapping.installed ? (
        <p role="status" className="mt-2 rounded border border-attention/40 bg-attention/5 p-3 text-xs text-ink" data-testid="pb-mapping-not-installed">
          {MAPPING_NOT_INSTALLED_LINE}
        </p>
      ) : (
        <>
          <p className="mt-1 max-w-3xl text-xs text-muted">{section.intro}</p>
          <ScrollRegion label="Metrics each dataset may receive, by kind of file">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Allowed metrics per dataset</caption>
              <thead className="sticky top-0 bg-gray-50 text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">dataset_name</th>
                  <th scope="col" className="px-3 py-2">dataset_version</th>
                  <th scope="col" className="px-3 py-2">metric_code</th>
                  <th scope="col" className="px-3 py-2">Unit</th>
                  <th scope="col" className="px-3 py-2">Observed values file</th>
                  <th scope="col" className="px-3 py-2">Planning target ranges file</th>
                  <th scope="col" className="px-3 py-2">Live figures</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((r) => (
                  <tr key={`${r[0]}|${r[1]}|${r[2]}`} className="border-t border-line align-top">
                    <td className="px-3 py-2 font-medium text-ink">{r[0]}</td>
                    <td className="px-3 py-2">{r[1]}</td>
                    <td className="px-3 py-2">{r[2]}</td>
                    <td className="px-3 py-2">{r[4]}</td>
                    <td className="px-3 py-2">{r[5]}</td>
                    <td className="px-3 py-2">{r[6]}</td>
                    <td className="px-3 py-2">{r[7]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollRegion>
        </>
      )}
    </section>
  );
}

export function AllowedValuesPanel() {
  const [data, setData] = useState<AllowedValues | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(ALLOWED_VALUES_JSON_URL);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        const f = failureFromResponse(res.status, json, 'the allowed values');
        setError(`${f.title} ${f.message}`);
        setData(null);
        return;
      }
      setError(null);
      setData((json?.data as AllowedValues) ?? null);
    } catch (e) {
      const f = failureFromThrown(e, 'the allowed values');
      setError(`${f.title} ${f.message}`);
      setData(null);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <details className="mt-3 text-sm" data-testid="pb-allowed-panel">
      <summary className="min-h-11 cursor-pointer py-2 font-medium text-trust">{error ? 'Allowed values (could not be loaded)' : summaryText(data)}</summary>
      <div className="mt-2">
        <p className="max-w-3xl text-xs text-muted">
          These are the datasets, metrics and cohorts a file may name, read from the database now. The Read me sheet of the Excel templates prints the same lists.{' '}
          <a className="text-trust underline" href={ALLOWED_VALUES_CSV_URL} download>
            Allowed values (CSV)
          </a>
        </p>
        {error && (
          <p role="alert" className="mt-2 rounded border border-risk/40 bg-risk/5 p-3 text-sm text-ink">
            {error}{' '}
            <button type="button" onClick={() => void load()} className="min-h-11 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10">
              Retry
            </button>
          </p>
        )}
        {!error && !data && (
          <p role="status" aria-live="polite" className="mt-2 text-sm text-muted">
            Loading the allowed values…
          </p>
        )}
        <div className="mt-3 space-y-5">
          <ColumnGuide />
          {data && <AllowedValuesView data={data} />}
        </div>
      </div>
    </details>
  );
}
