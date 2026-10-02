'use client';

// Catalogue: the list of benchmarks (read for everyone with view access) and
// the create / edit / verify controls (only with the catalogue capability).
// Editing a VERIFIED entry returns it to draft; the database also freezes its
// key, return type, variant, currency and country.
import { useState } from 'react';
import type { CatalogueRowView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { usePost, type Say } from './api';
import {
  ASSET_CLASS_OPTIONS,
  HISTORY_CLASS_OPTIONS,
  RETURN_TYPE_OPTIONS,
  VARIANT_OPTIONS,
  apiPaths,
  buildCatalogueBody,
  canVerifyCatalogue,
  capabilityDecisions,
  catalogueFormFromRow,
  catalogueStatusChip,
  emptyCatalogueForm,
  lockedWhenVerified,
  noteProblem,
  safeExternalUrl,
  validateCatalogueForm,
  variantLabel,
  type CatalogueFormState,
} from './benchmarkDataUiLogic';
import { Btn, Chip, EmptyState, Notice, Panel, ScrollTable, SelectField, Td, TextAreaField, TextField, Th } from './ui';

export default function CatalogueTab({ ov, onChanged, say }: { ov: OverviewResponse; onChanged: () => void; say: Say }) {
  const caps = ov.capabilities;
  const dec = capabilityDecisions(caps);
  const { busy, post } = usePost(say);
  const [form, setForm] = useState<CatalogueFormState | null>(null);
  const [editing, setEditing] = useState<CatalogueRowView | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState<CatalogueRowView | null>(null);
  const [note, setNote] = useState('');
  const rows = ov.rows.map((r) => r.catalogue);

  const locked = editing && editing.catalogueStatus === 'verified' ? lockedWhenVerified() : [];
  const isLocked = (k: keyof CatalogueFormState) => locked.includes(k);
  const set = (patch: Partial<CatalogueFormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  async function save() {
    if (!form) return;
    const e = validateCatalogueForm(form);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const r = await post(apiPaths.catalogue(), buildCatalogueBody(form), `Saved ${form.benchmarkKey} as a draft. It must be verified before it is treated as verified.`, 'save this catalogue entry');
    if (r.ok) {
      setForm(null);
      setEditing(null);
      onChanged();
    }
  }

  async function verify() {
    if (!verifying) return;
    const r = await post(apiPaths.catalogueVerify(verifying.id), { note: note.trim() }, `${verifying.label} is now verified.`, 'verify this catalogue entry');
    if (r.ok) {
      setVerifying(null);
      setNote('');
      onChanged();
    }
  }

  const noteErr = noteProblem(note, 10, 'The verification note');

  return (
    <div className="space-y-4">
      <Panel
        title="Benchmark catalogue"
        description="The benchmarks FHIP knows about, with their exact return type and currency. Catalogue information can exist before any data is loaded."
        actions={dec.canManageCatalogue ? <Btn onClick={() => { setEditing(null); setForm(emptyCatalogueForm()); setErrors({}); }}>Add a benchmark</Btn> : undefined}
      >
        {!dec.canManageCatalogue ? <Notice tone="info">{dec.why.catalogue}</Notice> : null}
        {rows.length === 0 ? (
          <EmptyState title="The catalogue is empty">No benchmark has been added yet.{dec.canManageCatalogue ? ' Use "Add a benchmark".' : ''}</EmptyState>
        ) : (
          <ScrollTable label="Benchmark catalogue" minWidth="min-w-[860px]">
            <thead>
              <tr><Th>Benchmark</Th><Th>Owner</Th><Th>Return type</Th><Th>Currency</Th><Th>Status</Th><Th>History</Th><Th>Evidence</Th><Th>Actions</Th></tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const chip = catalogueStatusChip(c.catalogueStatus);
                const link = safeExternalUrl(c.sourceUrl);
                return (
                  <tr key={c.id}>
                    <Td><span className="font-medium text-ink">{c.label}</span><br /><span className="font-mono text-xs text-muted">{c.benchmarkKey}</span></Td>
                    <Td>{c.ownerName ?? 'not recorded'}</Td>
                    <Td>{variantLabel(c.returnVariant)}{c.returnType ? ` (${c.returnType})` : ''}</Td>
                    <Td>{c.currencyCode ?? 'not declared'}</Td>
                    <Td><Chip label={chip.label} tone={chip.tone} /></Td>
                    <Td>{c.historyClass}{c.backtestedThrough ? `, backtested to ${c.backtestedThrough}` : ''}</Td>
                    <Td>{c.evidenceRef ?? 'none'}{c.evidenceRetrievedAt ? `, retrieved ${c.evidenceRetrievedAt}` : ''}{link ? <> <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Source (opens in a new tab)</a></> : null}</Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {dec.canManageCatalogue ? <Btn kind="secondary" onClick={() => { setEditing(c); setForm(catalogueFormFromRow(c)); setErrors({}); }}>{`Edit ${c.benchmarkKey}`}</Btn> : null}
                        {canVerifyCatalogue(c, caps) ? <Btn kind="secondary" onClick={() => { setVerifying(c); setNote(''); }}>{`Verify ${c.benchmarkKey}`}</Btn> : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </ScrollTable>
        )}
      </Panel>

      {verifying && dec.canManageCatalogue ? (
        <Panel title={`Verify ${verifying.label}`} description="Verifying says the facts in this entry were checked against the official source. Anything you change later returns it to draft.">
          <TextAreaField label="Verification note" required value={note} onChange={setNote} hint="At least 10 characters: what you checked and where." error={note.length > 0 ? noteErr : null} />
          <div className="mt-2 flex gap-2"><Btn disabled={noteErr !== null} busy={busy} onClick={() => void verify()}>Verify this benchmark</Btn><Btn kind="secondary" onClick={() => setVerifying(null)}>Cancel</Btn></div>
        </Panel>
      ) : null}

      {form && dec.canManageCatalogue ? (
        <Panel title={editing ? `Edit ${editing.label}` : 'Add a benchmark'}>
          {editing?.catalogueStatus === 'verified' ? <Notice tone="warn" title="This entry is verified">Saving changes returns it to draft until it is verified again. Its key, return type, variant, currency and country cannot be changed; create a new key for a different variant.</Notice> : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField label="Key" required value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v.toUpperCase() })} disabled={isLocked('benchmarkKey') || editing !== null} hint="Capital letters, digits and underscores, 3 to 64 characters." error={errors.benchmarkKey} />
            <TextField label="Display label (optional)" value={form.label} onChange={(v) => set({ label: v })} />
            <TextField label="Official name" required value={form.officialName} onChange={(v) => set({ officialName: v })} error={errors.officialName} />
            <TextField label="Owner" required value={form.ownerName} onChange={(v) => set({ ownerName: v })} error={errors.ownerName} />
            <TextField label="Official identifier" value={form.officialIdentifier} onChange={(v) => set({ officialIdentifier: v })} error={errors.officialIdentifier} />
            <SelectField label="Asset class" required value={form.assetClass} onChange={(v) => set({ assetClass: v })} options={ASSET_CLASS_OPTIONS} error={errors.assetClass} />
            <TextField label="Country (two letters)" value={form.countryCode} onChange={(v) => set({ countryCode: v })} maxLength={2} disabled={isLocked('countryCode')} error={errors.countryCode} />
            <TextField label="Currency (three letters)" required value={form.currencyCode} onChange={(v) => set({ currencyCode: v })} maxLength={3} disabled={isLocked('currencyCode')} error={errors.currencyCode} />
            <SelectField label="Return type" required value={form.returnType} onChange={(v) => set({ returnType: v })} options={RETURN_TYPE_OPTIONS} disabled={isLocked('returnType')} error={errors.returnType} />
            <SelectField label="Exact variant" required value={form.returnVariant} onChange={(v) => set({ returnVariant: v as CatalogueFormState['returnVariant'] })} options={VARIANT_OPTIONS} disabled={isLocked('returnVariant')} error={errors.returnVariant} />
            <TextField label="Base date" type="date" value={form.baseDate} onChange={(v) => set({ baseDate: v })} error={errors.baseDate} />
            <TextField label="Base value" value={form.baseValue} onChange={(v) => set({ baseValue: v })} error={errors.baseValue} />
            <TextField label="Launch date" type="date" value={form.launchDate} onChange={(v) => set({ launchDate: v })} error={errors.launchDate} />
            <TextField label="History start date" type="date" value={form.historyStartDate} onChange={(v) => set({ historyStartDate: v })} error={errors.historyStartDate} />
            <SelectField label="History type" value={form.historyClass} onChange={(v) => set({ historyClass: v as CatalogueFormState['historyClass'] })} options={HISTORY_CLASS_OPTIONS} />
            <TextField label="Backtested through" type="date" value={form.backtestedThrough} onChange={(v) => set({ backtestedThrough: v })} error={errors.backtestedThrough} hint="Needed for backtested or mixed history." />
            <TextField label="Trading calendar" value={form.calendarCode} onChange={(v) => set({ calendarCode: v })} />
            <TextField label="Methodology URL" type="url" value={form.methodologyUrl} onChange={(v) => set({ methodologyUrl: v })} error={errors.methodologyUrl} />
            <TextField label="Source URL" type="url" value={form.sourceUrl} onChange={(v) => set({ sourceUrl: v })} error={errors.sourceUrl} />
            <TextField label="Evidence reference" required value={form.evidenceRef} onChange={(v) => set({ evidenceRef: v })} error={errors.evidenceRef} hint="A document title or reference for the facts above." />
            <TextField label="Evidence retrieved on" type="date" required value={form.evidenceRetrievedAt} onChange={(v) => set({ evidenceRetrievedAt: v })} error={errors.evidenceRetrievedAt} />
          </div>
          <div className="mt-3 flex gap-2"><Btn busy={busy} onClick={() => void save()}>Save as draft</Btn><Btn kind="secondary" onClick={() => { setForm(null); setEditing(null); }}>Cancel</Btn></div>
        </Panel>
      ) : null}
    </div>
  );
}
