'use client';

// Upload: choose benchmark and file shape -> source and entitlement metadata ->
// file and options -> preview -> publish. Nothing is guessed: the date format,
// number format, sheet and column mapping are always chosen by the operator.
// The server stages and validates (the browser's preview is never the publish
// authority) and re-checks every capability.
import { useMemo, useState } from 'react';
import type { OverviewResponse, StageUploadResponse, JobPreview } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { apiCall, failureOf, useLoad, useUnmountSignal } from './api';
import { FormFeedback, useFormFeedback, type FormSpec } from './formFeedback';
import { UPLOAD_DATE_KEYS, UPLOAD_FIELD_LABELS, UPLOAD_FIELD_MAP, UPLOAD_FIELD_ORDER, UPLOAD_FIELD_STEP } from './benchmarkDataFormErrors';
import {
  DATE_FORMAT_OPTIONS,
  HISTORY_CLASS_OPTIONS,
  NUMBER_LOCALE_OPTIONS,
  PROVIDER_LAYOUT_OPTIONS,
  SHAPE_OPTIONS,
  TEMPLATE_LINKS,
  UPLOAD_MODE_OPTIONS,
  VARIANT_OPTIONS,
  apiPaths,
  buildStageParams,
  canEnterStep,
  canStage,
  capabilityDecisions,
  describeStageRejection,
  eligibleEntitlements,
  emptyUploadForm,
  entitlementGate,
  fileKindFromName,
  formatDate,
  identityMismatch,
  involvedBenchmarkKeys,
  layoutSuppliedDateFormat,
  limitsText,
  providerLayoutOptionLabel,
  recognisedLayoutNotice,
  sheetDisclosure,
  sheetStateLabel,
  stepIssues,
  toInspectState,
  variantLabel,
  type InspectState,
  type StepNumber,
  type UploadContext,
  type UploadFormState,
  type TabId,
} from './benchmarkDataUiLogic';
import { PreviewPanel, PublishSection } from './PublishParts';
import { Btn, CheckField, Chip, IssueList, LinkBtn, Notice, Panel, RadioGroup, SelectField, DateField, TextAreaField, TextField } from './ui';

interface HelpPayload {
  sections: Array<{ title: string; body: string }>;
}

const FALLBACK_HELP: Array<{ title: string; body: string }> = [
  { title: 'Upload an index level, not a percentage return', body: 'Each value must be the index level on that date.' },
  { title: 'Price, total return and net total return are different series', body: 'The return type you confirm must match the catalogue.' },
  { title: 'Currency and dates must be correct', body: 'Choose the date format yourself; it is never guessed.' },
  { title: 'Uploading a file does not give you permission to use the data', body: 'An approved entitlement record is required before anything is published.' },
];

export function HelpPanel() {
  const { state } = useLoad<HelpPayload>(apiPaths.help(), 'load the upload help');
  const sections = state.status === 'ready' ? state.data.sections : FALLBACK_HELP;
  return (
    <details className="rounded-card border border-line bg-white" open>
      <summary className="min-h-11 cursor-pointer px-4 py-2.5 text-sm font-semibold text-trust">Help: what to upload and what to know first</summary>
      <div className="space-y-2 border-t border-line px-4 py-3 text-sm">
        {state.status === 'error' ? <p className="text-muted">The full help text could not be loaded; the key points are shown.</p> : null}
        {sections.map((s) => (
          <div key={s.title}>
            <p className="font-medium text-ink">{s.title}</p>
            <p className="text-muted">{s.body}</p>
          </div>
        ))}
        <p className="font-medium text-ink">Download a template</p>
        <ul className="list-disc pl-5">
          {TEMPLATE_LINKS.map((t) => (
            <li key={t.name}>
              <a className="font-semibold text-trust underline" href={apiPaths.template(t.name)}>{t.label}</a>
              <span className="text-muted"> - {t.description}</span>
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}

const STEP_LABELS = ['Benchmark and file shape', 'Source and entitlement', 'File and options', 'Preview', 'Publish'];

function guessDelimiterHeader(text: string): string[] {
  const first = text.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  const delim = [',', ';', '\t', '|'].map((d) => ({ d, n: first.split(d).length })).sort((a, b) => b.n - a.n)[0].d;
  return first.split(delim).map((h) => h.replace(/^"|"$/g, '').trim()).filter(Boolean);
}

const UPLOAD_SPEC: FormSpec = { order: UPLOAD_FIELD_ORDER, labels: UPLOAD_FIELD_LABELS, map: UPLOAD_FIELD_MAP, dateKeys: UPLOAD_DATE_KEYS };

export default function UploadTab({ ov, preselect, goTab, onChanged }: { ov: OverviewResponse; preselect: string; goTab: (t: TabId) => void; onChanged: () => void }) {
  const caps = ov.capabilities;
  const decisions = capabilityDecisions(caps);
  const signal = useUnmountSignal();
  const [form, setForm] = useState<UploadFormState>(() => emptyUploadForm(preselect));
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [csvHeader, setCsvHeader] = useState<string[] | null>(null);
  const [step, setStep] = useState<number>(1);
  const [staging, setStaging] = useState(false);
  const [staged, setStaged] = useState<{ jobId: string; preview: JobPreview } | null>(null);
  const [rejection, setRejection] = useState<string | null>(null);
  const [stageError, setStageError] = useState<string | null>(null);
  const fb = useFormFeedback(UPLOAD_SPEC);

  const set = (patch: Partial<UploadFormState>) => setForm((f) => ({ ...f, ...patch }));
  const ctx: UploadContext = { form, rows: ov.rows, caps, asOfDate: ov.asOfDate, file: file ? { name: file.name, size: file.size } : null, inspect, maxBytes: ov.limits.maxBytes, header: csvHeader ?? inspect?.header ?? null };
  const suppliedDate = layoutSuppliedDateFormat(ctx);
  const row = ov.rows.find((r) => r.catalogue.benchmarkKey === form.benchmarkKey);
  const keys = involvedBenchmarkKeys(form);
  const kind = file ? fileKindFromName(file.name) : null;
  const hasPreview = staged !== null;
  const issuesFor = (s: StepNumber) => stepIssues(s, ctx);
  const mismatch = identityMismatch(form, row?.catalogue);
  const gate = entitlementGate(row, ov.asOfDate);
  const eligible = eligibleEntitlements(row, ov.asOfDate);
  const stage = canStage(ctx);

  const benchmarkOptions = useMemo(() => ov.rows.map((r) => ({ value: r.catalogue.benchmarkKey, label: `${r.catalogue.label} (${variantLabel(r.catalogue.returnVariant)}, ${r.catalogue.currencyCode ?? 'no currency'})${r.catalogue.catalogueStatus === 'verified' ? '' : ' - draft'}` })), [ov.rows]);

  async function onFile(f: File | null) {
    setFile(f);
    setInspect(null);
    setInspectError(null);
    setCsvHeader(null);
    setStaged(null);
    setRejection(null);
    set({ sheetName: '', includeHiddenRows: false, dateColumn: '', valueColumn: '' });
    if (!f) return;
    const k = fileKindFromName(f.name);
    if (k === null) return;
    if (k === 'csv') {
      try {
        setCsvHeader(guessDelimiterHeader(await f.slice(0, 65536).text()));
      } catch {
        setCsvHeader(null);
      }
    }
    if (f.size > ov.limits.maxBytes) return;
    setInspectBusy(true);
    const fd = new FormData();
    fd.append('file', f);
    const r = await apiCall(apiPaths.uploadInspect(), { method: 'POST', form: fd, signal: signal() });
    if (r.aborted) return;
    setInspectBusy(false);
    if (!r.ok) {
      setInspectError(failureOf(r, 'inspect this file').message);
      return;
    }
    const st = toInspectState(r.body);
    setInspect(st);
    if (!st) setInspectError('The server answered in an unexpected shape.');
  }

  async function doStage() {
    const built = buildStageParams(ctx);
    if (!built.ok || !file) return;
    setStaging(true);
    setStageError(null);
    setRejection(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('params', JSON.stringify(built.params));
    const r = await apiCall(apiPaths.upload(), { method: 'POST', form: fd, signal: signal() });
    if (r.aborted) return;
    setStaging(false);
    if (!r.ok) {
      // Field-level when the server named fields (shown on the step that holds the field), otherwise a banner inside this panel.
      const key = fb.showServerFailure(r.body, failureOf(r, 'stage this file').message);
      if (key) setStep(UPLOAD_FIELD_STEP[key] ?? 3);
      return;
    }
    fb.clear();
    const data = (r.body?.data ?? null) as StageUploadResponse | null;
    if (!data) {
      setStageError('The server answered in an unexpected shape. Nothing was staged.');
      return;
    }
    if (data.status === 'rejected') {
      setRejection(describeStageRejection(data.stage, data.problems));
      if (data.sheets) setInspect((cur) => ({ kind: 'xlsx', sheets: data.sheets ?? [], problems: data.problems, fileSha256: data.fileSha256, bytes: file.size, header: cur?.header }));
      return;
    }
    setStaged({ jobId: data.jobId, preview: data.preview });
    setStep(4);
    onChanged();
  }

  /** A summary link: switch to the step that holds the field, then focus it (after that step has rendered). */
  function goToField(key: string) {
    setStep(UPLOAD_FIELD_STEP[key] ?? 3);
    requestAnimationFrame(() => fb.focusField(key));
  }

  function restart() {
    setStaged(null);
    setRejection(null);
    setStageError(null);
    setStep(3);
  }

  const headerChoices = (csvHeader ?? inspect?.header ?? []).map((h) => ({ value: h, label: h }));
  const recognised = recognisedLayoutNotice(csvHeader ?? inspect?.header ?? null, form.shape);
  const disclosure = sheetDisclosure(inspect, form.sheetName, form.includeHiddenRows);

  return (
    <div data-form={fb.formId} className="space-y-4">
      <HelpPanel />
      {!decisions.canStage ? <Notice tone="info" title="You can read this page but not upload">{decisions.why.stage}</Notice> : null}

      <nav aria-label="Upload steps">
        <ol className="flex flex-wrap gap-2">
          {STEP_LABELS.map((label, i) => {
            const n = (i + 1) as 1 | 2 | 3 | 4 | 5;
            const can = canEnterStep(n, ctx, hasPreview);
            return (
              <li key={label}>
                <button type="button" disabled={!can} aria-current={step === n ? 'step' : undefined} onClick={() => setStep(n)} className={`min-h-11 rounded-compact border px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust disabled:opacity-50 ${step === n ? 'border-trust bg-trust/10 text-trust' : 'border-line bg-white text-ink'}`}>
                  {`${n}. ${label}`}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {step === 1 ? (
        <Panel title="1. Choose the benchmark and the file shape">
          <FormFeedback fb={fb} onNavigate={goToField} />
          <div className="space-y-4">
            <RadioGroup legend="File shape" name="shape" value={form.shape} onChange={(v) => set({ shape: v as UploadFormState['shape'] })} options={SHAPE_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} (${o.columns})`, description: o.description }))} />
            {form.shape === 'multi' ? (
              <Notice tone="info">Each row of the file names its own benchmark. Every key is checked against the catalogue; the return type and currency below apply to all of them.</Notice>
            ) : (
              <div>
                <SelectField label="Benchmark" required value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v, entitlementId: '' })} options={benchmarkOptions} hint="Only benchmarks that already exist in the catalogue." error={fb.errors.benchmarkKey} fieldKey="benchmarkKey" />
                <p className="mt-1 text-sm text-muted">Benchmark not listed? New benchmarks are created on the Catalogue tab, not here. <LinkBtn onClick={() => goTab('catalogue')}>Go to the Catalogue tab</LinkBtn></p>
              </div>
            )}
            {row ? <p className="text-sm text-ink">The catalogue records this benchmark as <strong>{variantLabel(row.catalogue.returnVariant)}</strong>, currency <strong>{row.catalogue.currencyCode ?? 'not declared'}</strong>.</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField label="Return type of the levels in the file" required value={form.returnVariant} onChange={(v) => set({ returnVariant: v as UploadFormState['returnVariant'] })} options={VARIANT_OPTIONS} hint="Confirm what the file really contains. It must match the catalogue." error={mismatch && form.returnVariant ? mismatch : fb.errors.returnVariant} fieldKey="returnVariant" />
              <TextField label="Currency of the levels in the file" required value={form.currencyCode} onChange={(v) => set({ currencyCode: v.toUpperCase() })} maxLength={3} placeholder="INR" hint="Three letters, for example INR." error={mismatch && !form.returnVariant ? mismatch : fb.errors.currencyCode} fieldKey="currencyCode" />
            </div>
            {form.shape === 'provider_export' ? (
              <div className="rounded-compact border border-line p-3">
                <p className="text-sm font-medium text-ink">Files with several indexes (optional)</p>
                <p className="text-xs text-muted">If the export holds more than one index, map each index name, exactly as it appears in the file, to a catalogue benchmark. Unmapped names are listed as excluded in the preview, never guessed.</p>
                {form.indexNameMap.map((m, i) => (
                  <div key={i} className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <TextField label={`Index name ${i + 1}`} value={m.indexName} onChange={(v) => set({ indexNameMap: form.indexNameMap.map((x, j) => (j === i ? { ...x, indexName: v } : x)) })} />
                    <SelectField label={`Benchmark for index ${i + 1}`} value={m.benchmarkKey} onChange={(v) => set({ indexNameMap: form.indexNameMap.map((x, j) => (j === i ? { ...x, benchmarkKey: v } : x)) })} options={benchmarkOptions} />
                    <div className="self-end"><Btn kind="secondary" onClick={() => set({ indexNameMap: form.indexNameMap.filter((_, j) => j !== i) })}>{`Remove index ${i + 1}`}</Btn></div>
                  </div>
                ))}
                <div className="mt-2"><Btn kind="secondary" onClick={() => set({ indexNameMap: [...form.indexNameMap, { indexName: '', benchmarkKey: '' }] })}>Add an index name</Btn></div>
              </div>
            ) : null}
            <IssueList issues={issuesFor(1)} tone="warn" />
            <Btn disabled={!canEnterStep(2, ctx, hasPreview)} onClick={() => setStep(2)}>Continue to source and entitlement</Btn>
          </div>
        </Panel>
      ) : null}

      {step === 2 ? (
        <Panel title="2. Source and entitlement">
          <FormFeedback fb={fb} onNavigate={goToField} />
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Source owner or provider" required value={form.sourceOwner} onChange={(v) => set({ sourceOwner: v })} error={fb.errors.sourceOwner} fieldKey="sourceOwner" />
              <TextField label="Original source URL or delivery reference" required value={form.sourceReference} onChange={(v) => set({ sourceReference: v })} hint="Where the file came from, so it can be traced." error={fb.errors.sourceReference} fieldKey="sourceReference" />
              <DateField label="Data as of (optional)" value={form.dataAsOf} onChange={(v) => set({ dataAsOf: v })} hint="The date the provider says the data runs to." error={fb.errors.dataAsOf} fieldKey="dataAsOf" />
              <SelectField label="History type" required value={form.historyClass} onChange={(v) => set({ historyClass: v as UploadFormState['historyClass'] })} options={HISTORY_CLASS_OPTIONS} error={fb.errors.historyClass} fieldKey="historyClass" />
            </div>
            <RadioGroup error={fb.errors.mode} fieldKey="mode" legend="Upload mode" name="mode" value={form.mode} onChange={(v) => set({ mode: v as UploadFormState['mode'] })} options={UPLOAD_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description, }))} disabled={false} />
            {form.mode === 'correction' ? (
              <>
                {!caps.correct ? <Notice tone="warn" title="Corrections are not available to you">{decisions.why.correct} Choose New history, or ask for the correction permission.</Notice> : null}
                <TextAreaField label="Reason for the correction" required value={form.reason} onChange={(v) => set({ reason: v })} hint="At least 20 characters. It is recorded permanently." error={form.reason.trim().length > 0 && form.reason.trim().length < 20 ? 'At least 20 characters are needed.' : fb.errors.reason} fieldKey="reason" />
              </>
            ) : null}
            {keys.length === 1 ? (
              gate.ok ? (
                <SelectField label="Approved entitlement covering this upload" required value={form.entitlementId} onChange={(v) => set({ entitlementId: v })} options={eligible.map((e) => ({ value: e.entitlementId, label: `${e.kind === 'public_use_permission' ? 'Public-use permission' : 'Commercial licence'}: ${e.evidenceReference} (valid ${formatDate(e.validFrom)} to ${e.validTo ? formatDate(e.validTo) : 'open'}; data ${e.dataFrom ? formatDate(e.dataFrom) : 'any start'} to ${e.dataTo ? formatDate(e.dataTo) : 'any end'})` }))} hint="Only approved records that allow manual ingestion and storage are listed." error={fb.errors.entitlementId} fieldKey="entitlementId" />
              ) : (
                <Notice tone="bad" title="No approved entitlement" live="alert">
                  <p>{gate.message}</p>
                  <div className="mt-1"><LinkBtn onClick={() => goTab('entitlements')}>Go to the Entitlements tab</LinkBtn></div>
                </Notice>
              )
            ) : (
              <Notice tone="info">With several benchmarks, an approved entitlement is looked up for each one when the file is checked. Any benchmark without one blocks publication.</Notice>
            )}
            <IssueList issues={issuesFor(2).filter((m) => m !== gate.message)} tone="warn" />
            <div className="flex flex-wrap gap-2">
              <Btn kind="secondary" onClick={() => setStep(1)}>Back</Btn>
              <Btn disabled={!canEnterStep(3, ctx, hasPreview)} onClick={() => setStep(3)}>Continue to the file</Btn>
            </div>
          </div>
        </Panel>
      ) : null}

      {step === 3 ? (
        <Panel title="3. File and options" description={limitsText(ov.limits)}>
          <FormFeedback fb={fb} onNavigate={goToField} />
          <div className="space-y-4">
            <div>
              <label htmlFor="bm-upload-file" className="block text-sm font-medium text-ink">File (.csv or .xlsx) <span className="text-risk">(required)</span></label>
              <input id="bm-upload-file" data-field-key="file" type="file" accept=".csv,.xlsx" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} className="mt-1 block min-h-11 w-full text-sm" />
              {inspectBusy ? <p role="status" className="mt-1 text-sm text-muted">Reading the file...</p> : null}
              {inspectError ? <p role="alert" className="mt-1 text-sm text-risk">{inspectError}</p> : null}
              {inspect && inspect.problems.length > 0 ? <IssueList issues={inspect.problems.map((p) => p.message)} /> : null}
              {recognised ? (
                recognised.problem ? (
                  <Notice tone="warn" title={`This file is the registered layout "${recognised.label}"`}>{recognised.problem}</Notice>
                ) : (
                  <Notice tone="info" title="Recognised file layout">
                    <p>The header of this file exactly matches the registered layout &quot;{recognised.label}&quot;, so it is read as that layout whichever file shape is selected.{recognised.unverified ? ' This header set has not been checked against a real download.' : ''}</p>
                    {recognised.ignoredColumns.length > 0 ? <p>Not loaded (ignored): {recognised.ignoredColumns.join(', ')}.</p> : null}
                  </Notice>
                )
              ) : null}
            </div>

            {kind === 'xlsx' && inspect && inspect.sheets.length > 0 ? (
              <div className="space-y-2">
                <RadioGroup error={fb.errors.sheetName} fieldKey="sheetName" legend="Sheet to process (you must choose one)" name="sheet" value={form.sheetName} onChange={(v) => set({ sheetName: v })} options={inspect.sheets.map((s) => ({ value: s.name, label: `${s.name} (${sheetStateLabel(s.state)}${s.rowCount !== null ? `, ${s.rowCount} rows` : ''})` }))} />
                <CheckField label="Include rows that are hidden in the spreadsheet" checked={form.includeHiddenRows} onChange={(v) => set({ includeHiddenRows: v })} hint="Off by default. Hidden rows are always listed in the preview, never silently ignored." />
                {disclosure ? (
                  <Notice tone="info" title="Exactly what will be processed">
                    <p>Sheet: <strong>{disclosure.processed}</strong>{disclosure.chosenIsHidden ? ' (this sheet is hidden in the workbook)' : ''}.</p>
                    <p>{disclosure.hiddenRowsText}</p>
                    <p>{disclosure.otherNotProcessed.length > 0 ? `Not processed: ${disclosure.otherNotProcessed.join(', ')}.` : 'There are no other sheets.'}</p>
                  </Notice>
                ) : null}
              </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2">
              {suppliedDate ? (
                <div data-testid="date-format-from-layout" className="text-sm text-ink">
                  <p className="font-medium">Date format</p>
                  <p>Detected from the file layout: {suppliedDate.label}.</p>
                </div>
              ) : (
                <SelectField label="Date format used in the file" required value={form.dateFormat} onChange={(v) => set({ dateFormat: v as UploadFormState['dateFormat'] })} options={DATE_FORMAT_OPTIONS.map((o) => ({ value: o.value, label: o.example ? `${o.label} - ${o.example}` : o.label }))} placeholder="Choose the date format" error={fb.errors.dateFormat} fieldKey="dateFormat" hint="Never guessed: a date such as 03-04-2024 could be 3 April or 4 March, depending on the order the file uses." />
              )}
              <SelectField label="How numbers are written" required value={form.numberLocale} onChange={(v) => set({ numberLocale: v as UploadFormState['numberLocale'] })} options={NUMBER_LOCALE_OPTIONS.map((o) => ({ value: o.value, label: `${o.label} - ${o.example}` }))} placeholder="Choose the number format" error={fb.errors.numberLocale} fieldKey="numberLocale" />
              <TextField label="Header row" type="number" value={form.headerRow} onChange={(v) => set({ headerRow: v })} hint="The row holding the column names (usually 1)." error={fb.errors.headerRow} fieldKey="headerRow" />
            </div>

            {form.shape === 'provider_export' ? (
              <div className="space-y-3 rounded-compact border border-line p-3">
                <RadioGroup legend="How are the columns identified?" name="colchoice" value={form.columnChoice} onChange={(v) => set({ columnChoice: v as UploadFormState['columnChoice'] })} options={[{ value: 'layout', label: 'A known provider layout' }, { value: 'explicit', label: 'I will name the date and value columns myself' }]} />
                {form.columnChoice === 'layout' ? (
                  <SelectField label="Provider layout" required value={form.providerLayoutId} onChange={(v) => set({ providerLayoutId: v })} options={PROVIDER_LAYOUT_OPTIONS.map((l) => ({ value: l.id, label: providerLayoutOptionLabel(l) }))} error={fb.errors.providerLayoutId} fieldKey="providerLayoutId" hint="A layout marked as matching a real download was compared with that download. The others come from public export conventions and have not been checked against a live download; a mismatch is reported, never guessed around." />
                ) : null}
                {form.columnChoice === 'explicit' ? (
                  headerChoices.length > 0 ? (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <SelectField label="Date column" required value={form.dateColumn} onChange={(v) => set({ dateColumn: v })} options={headerChoices} error={fb.errors.dateColumn} fieldKey="dateColumn" />
                      <SelectField label="Value (index level) column" required value={form.valueColumn} onChange={(v) => set({ valueColumn: v })} options={headerChoices} error={fb.errors.valueColumn} fieldKey="valueColumn" />
                      <SelectField label="Index name column (optional)" value={form.indexNameColumn} onChange={(v) => set({ indexNameColumn: v })} options={headerChoices} />
                    </div>
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-3">
                      <TextField label="Date column name" required value={form.dateColumn} onChange={(v) => set({ dateColumn: v })} hint="Exactly as written in the header. The column names could not be read from this file here." />
                      <TextField label="Value column name" required value={form.valueColumn} onChange={(v) => set({ valueColumn: v })} />
                      <TextField label="Index name column (optional)" value={form.indexNameColumn} onChange={(v) => set({ indexNameColumn: v })} />
                    </div>
                  )
                ) : null}
              </div>
            ) : null}

            <IssueList issues={issuesFor(3)} tone="warn" />
            {stageError ? <Notice tone="bad" live="alert">{stageError}</Notice> : null}
            {rejection ? <Notice tone="bad" title="The file was not staged" live="alert">{rejection}</Notice> : null}
            <div className="flex flex-wrap gap-2">
              <Btn kind="secondary" onClick={() => setStep(2)}>Back</Btn>
              <Btn disabled={!stage.ok || inspectBusy} busy={staging} onClick={() => void doStage()}>Check the file and show the preview</Btn>
            </div>
            <p className="text-xs text-muted">Checking the file stages it for review. Nothing is published at this step.</p>
          </div>
        </Panel>
      ) : null}

      {step >= 4 && staged ? (
        <>
          {step === 4 ? (
            <div className="space-y-3">
              <Chip label={`Staged job ${staged.jobId.slice(0, 8)}`} tone="info" />
              <PreviewPanel preview={staged.preview} jobId={staged.jobId} />
              <Btn onClick={() => setStep(5)}>Continue to publish</Btn>
            </div>
          ) : (
            <Panel title="5. Publish">
              <PublishSection
                jobId={staged.jobId}
                mode={staged.preview.params.mode}
                caps={caps}
                fileSha256={staged.preview.fileSha256}
                stagingDigest={staged.preview.stagingDigest}
                mutation={staged.preview.mutation}
                benchmarks={staged.preview.selectedBenchmarks}
                hardErrorCount={staged.preview.hardErrorCount}
                blockers={staged.preview.blockers}
                eligible={staged.preview.eligible}
                requiredAcks={staged.preview.requiredAcknowledgements}
                stagedByMe
                onPublished={() => onChanged()}
                onRestart={restart}
              />
              <div className="mt-3"><Btn kind="secondary" onClick={() => setStep(4)}>Back to the preview</Btn></div>
            </Panel>
          )}
        </>
      ) : null}
    </div>
  );
}
