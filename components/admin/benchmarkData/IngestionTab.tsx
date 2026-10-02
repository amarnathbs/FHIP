'use client';

// Ingestion: the per-benchmark mode (disabled, manual import, automated).
// Setting a mode grants nothing: automation additionally needs an approved
// automation entitlement, the environment flag and both kill switches. If the
// server refuses, its refusal message is shown as given.
import { useState } from 'react';
import type { BenchmarkOverviewRow, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { usePost, type Say } from './api';
import {
  AUTOMATION_CONDITIONS,
  INGESTION_MODE_OPTIONS,
  apiPaths,
  buildIngestionBody,
  capabilityDecisions,
  formatDateTime,
  ingestionFormFromRow,
  ingestionModeLabel,
  validateIngestionForm,
  type IngestionFormState,
} from './benchmarkDataUiLogic';
import { Btn, CheckField, Chip, EmptyState, Notice, Panel, RadioGroup, TextAreaField, TextField } from './ui';

function Editor({ row, ov, onChanged, say }: { row: BenchmarkOverviewRow; ov: OverviewResponse; onChanged: () => void; say: Say }) {
  const [form, setForm] = useState<IngestionFormState>(() => ingestionFormFromRow(row));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const { busy, post } = usePost(say);
  const set = (p: Partial<IngestionFormState>) => setForm((f) => ({ ...f, ...p }));
  const label = ingestionModeLabel(row.ingestion, ov.switches.effectivelyEnabled);

  async function save() {
    const e = validateIngestionForm(form);
    setErrors(e);
    setRefusal(null);
    if (Object.keys(e).length > 0) return;
    const r = await post(apiPaths.ingestionMode(row.catalogue.id), buildIngestionBody(form), `Ingestion mode for ${row.catalogue.label} saved.`, 'change the ingestion mode');
    if (r.ok) onChanged();
    else setRefusal(r.message);
  }

  return (
    <Panel title={row.catalogue.label} actions={<Chip label={label.label} tone={label.tone} />} description={row.ingestion ? `Last manual import: ${formatDateTime(row.ingestion.lastManualImportAt)}. Last successful automated run: ${formatDateTime(row.ingestion.lastSuccessfulRunAt)}.` : 'No ingestion state has been recorded yet.'}>
      <div className="space-y-3">
        <RadioGroup legend="Mode" name={`mode-${row.catalogue.id}`} value={form.mode} onChange={(v) => set({ mode: v as IngestionFormState['mode'], automationEnabled: v === 'automated' ? form.automationEnabled : false })} options={INGESTION_MODE_OPTIONS.map((o) => ({ value: o.value, label: o.label, description: o.description }))} />
        {form.mode === 'automated' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Adapter id" required value={form.adapterId} onChange={(v) => set({ adapterId: v })} error={errors.adapterId} />
            <TextField label="Source key (optional)" value={form.sourceKey} onChange={(v) => set({ sourceKey: v })} />
          </div>
        ) : null}
        <TextField label="Publication lag in days" type="number" value={form.publicationLagDays} onChange={(v) => set({ publicationLagDays: v })} error={errors.publicationLagDays} hint="How many days after a session the provider normally publishes its level." />
        <CheckField label="Switch automation on for this benchmark" checked={form.automationEnabled} disabled={form.mode !== 'automated'} onChange={(v) => set({ automationEnabled: v })} hint={AUTOMATION_CONDITIONS} />
        {errors.automationEnabled ? <p role="alert" className="text-xs font-medium text-risk">{errors.automationEnabled}</p> : null}
        <TextAreaField label="Reason for this change" required value={form.reason} onChange={(v) => set({ reason: v })} hint="At least 10 characters; recorded permanently." error={errors.reason} />
        {refusal ? <Notice tone="bad" title="The server refused this change" live="alert">{refusal}</Notice> : null}
        <Btn busy={busy} onClick={() => void save()}>Save ingestion mode</Btn>
      </div>
    </Panel>
  );
}

export default function IngestionTab({ ov, onChanged, say }: { ov: OverviewResponse; onChanged: () => void; say: Say }) {
  const dec = capabilityDecisions(ov.capabilities);
  const [selected, setSelected] = useState<string | null>(null);
  const row = ov.rows.find((r) => r.catalogue.benchmarkKey === selected);
  return (
    <div className="space-y-4">
      <Notice tone="info" title="Manual import is not automatic">A benchmark on Manual import only updates when an administrator uploads a file. The Overview lists when an upload is due.</Notice>
      {ov.rows.length === 0 ? (
        <EmptyState title="No benchmark in the catalogue">Add a benchmark on the Catalogue tab first.</EmptyState>
      ) : (
        <Panel title="Benchmarks and their ingestion mode">
          <ul className="space-y-2">
            {ov.rows.map((r) => {
              const l = ingestionModeLabel(r.ingestion, ov.switches.effectivelyEnabled);
              return (
                <li key={r.catalogue.benchmarkKey} className="flex flex-wrap items-center gap-2 rounded-compact border border-line px-3 py-2">
                  <span className="text-sm font-medium text-ink">{r.catalogue.label}</span>
                  <Chip label={l.label} tone={l.tone} />
                  {dec.canEditIngestion ? <Btn kind="secondary" onClick={() => setSelected(r.catalogue.benchmarkKey)}>{`Change mode for ${r.catalogue.benchmarkKey}`}</Btn> : null}
                </li>
              );
            })}
          </ul>
          {!dec.canEditIngestion ? <p className="mt-2 text-sm text-muted">{dec.why.catalogue}</p> : null}
        </Panel>
      )}
      {row && dec.canEditIngestion ? <Editor key={row.catalogue.benchmarkKey} row={row} ov={ov} onChanged={onChanged} say={say} /> : null}
    </div>
  );
}
