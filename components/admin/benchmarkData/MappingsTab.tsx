'use client';

// Mappings: scheme-to-benchmark proposals with their evidence. A proposal never
// changes what customers see by itself; a reviewer with the catalogue permission
// approves or rejects it. AMFI category guidance is not evidence that a given
// scheme uses a benchmark: the evidence must be the scheme's own document.
import { useState } from 'react';
import type { MappingProposalView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import type { HeldSchemesResponse } from '@/lib/services/investment-intelligence/benchmarkData/heldSchemes';
import type { UnmappedSummary } from '@/lib/services/investment-intelligence/benchmarkData/schemeMappingProposals';
import { matchBenchmarkName, type CatalogueEntryLite } from '@/lib/services/investment-intelligence/benchmarkData/benchmarkNameMatcher';
import { usePost, useLoad, type Say } from './api';
import { FormFeedback, useFormFeedback, type FormSpec } from './formFeedback';
import { MAPPING_DATE_KEYS, MAPPING_FIELD_LABELS, MAPPING_FIELD_MAP, MAPPING_FIELD_ORDER, NOTE_FIELD_LABELS, NOTE_FIELD_MAP, NOTE_FIELD_ORDER } from './benchmarkDataFormErrors';
import {
  CONFIDENCE_OPTIONS,
  EVIDENCE_SOURCE_OPTIONS,
  RELATIONSHIP_OPTIONS,
  RESOLUTION_METHOD_OPTIONS,
  apiPaths,
  asArray,
  buildMappingBody,
  canReviewMapping,
  capabilityDecisions,
  emptyMappingForm,
  mappingFormForHeldScheme,
  mappingFormForFactsheet,
  formatDate,
  mappingStatusChip,
  reviewProblem,
  safeExternalUrl,
  validateMappingForm,
  type MappingFormState,
} from './benchmarkDataUiLogic';
import HeldSchemesTable from './HeldSchemesTable';
import { Btn, CheckField, Chip, EmptyState, ErrorPanel, LoadingPanel, Notice, Panel, ScrollTable, SelectField, Td, DateField, TextAreaField, TextField, Th } from './ui';

const MAPPING_SPEC: FormSpec = { order: MAPPING_FIELD_ORDER, labels: MAPPING_FIELD_LABELS, map: MAPPING_FIELD_MAP, dateKeys: MAPPING_DATE_KEYS };
const NOTE_SPEC: FormSpec = { order: NOTE_FIELD_ORDER, labels: NOTE_FIELD_LABELS, map: NOTE_FIELD_MAP };

export default function MappingsTab({ ov, refreshKey, onChanged, say }: { ov: OverviewResponse; refreshKey: number; onChanged: () => void; say: Say }) {
  const caps = ov.capabilities;
  const dec = capabilityDecisions(caps);
  const { state, reload } = useLoad<MappingProposalView[]>(`${apiPaths.mappings()}?r=${refreshKey}`, 'load the mapping proposals');
  const held = useLoad<HeldSchemesResponse>(`${apiPaths.heldSchemes()}?r=${refreshKey}`, 'load the held schemes');
  const unmapped = useLoad<UnmappedSummary>(`${apiPaths.unmappedSchemes()}?r=${refreshKey}`, 'load the schemes with no mapping');
  const { busy, post } = usePost(say);
  const [form, setForm] = useState<MappingFormState | null>(null);
  const fb = useFormFeedback(MAPPING_SPEC);
  const fbReview = useFormFeedback(NOTE_SPEC);
  const errors = fb.errors;
  const [review, setReview] = useState<{ p: MappingProposalView; decision: 'approve' | 'reject' } | null>(null);
  const [note, setNote] = useState('');
  const [closePrev, setClosePrev] = useState(false);
  const set = (p: Partial<MappingFormState>) => setForm((f) => (f ? { ...f, ...p } : f));

  if (state.status === 'loading') return <LoadingPanel what="the mapping proposals" />;
  if (state.status === 'error') return <ErrorPanel failure={state.failure} what="the mapping proposals" onRetry={reload} />;
  const proposals = asArray<MappingProposalView>(state.data);

  async function propose() {
    if (!form) return;
    const e = validateMappingForm(form);
    fb.showClientErrors(e);
    if (Object.keys(e).length > 0) return;
    const bm = ov.rows.find((r) => r.catalogue.benchmarkKey === form.benchmarkKey);
    const r = await post(apiPaths.mappings(), buildMappingBody(form, bm ? bm.catalogue.id : null), 'Proposed. It changes nothing until it is reviewed.', 'propose this mapping');
    if (r.ok) {
      fb.clear();
      setForm(null);
      reload();
      onChanged();
    } else {
      fb.showServerFailure(r.body, r.message);
    }
  }

  async function doReview() {
    if (!review) return;
    const r = await post(apiPaths.mappingReview(review.p.id), { decision: review.decision, note: note.trim(), closePrevious: review.decision === 'approve' ? closePrev : undefined }, review.decision === 'approve' ? 'The mapping is approved and now in force.' : 'The proposal is rejected.', 'review this mapping');
    if (r.ok) {
      fbReview.clear();
      setReview(null);
      setNote('');
      setClosePrev(false);
      reload();
      onChanged();
    } else {
      fbReview.showServerFailure(r.body, r.message);
    }
  }

  const rp = reviewProblem(note);

  // The pure matcher, run in the browser on what the reviewer typed: it only SUGGESTS a catalogue entry.
  // A price index is never suggested for a total-return benchmark; nothing is chosen for the reviewer.
  const catalogueForMatch: CatalogueEntryLite[] = ov.rows.map((r) => ({
    benchmarkId: r.catalogue.id,
    benchmarkKey: r.catalogue.benchmarkKey,
    officialName: r.catalogue.officialName ?? r.catalogue.label,
    returnVariant: r.catalogue.returnVariant,
    verified: r.catalogue.catalogueStatus === 'verified',
    active: r.catalogue.lifecycleStatus === 'active',
  }));
  const nameHint = form && form.proposedBenchmarkName.trim().length >= 3 ? matchBenchmarkName(form.proposedBenchmarkName, catalogueForMatch) : null;

  return (
    <div className="space-y-4">
      <Panel title="Held schemes and the benchmark that applies" description="The schemes users actually hold, first. Holder numbers are counts only (shown only where at least 10 people hold the scheme); no user, account or amount is shown. A fund with no declared benchmark is compared, automatically, with the usual benchmark for its category and is always labelled as such. Entering the fund's declared benchmark from its factsheet is optional; once approved it replaces the category benchmark. The category table is unverified (AMFI's own list could not be read), and a return figure appears only where the benchmark is verified, total return and entitled.">
        {held.state.status === 'loading' ? <LoadingPanel what="the held schemes" /> : held.state.status === 'error' ? (/database update/i.test(held.state.failure.message) ? <Notice tone="info">This list needs a database update that has not been applied yet. Everything else on this tab works; the list will appear once the update is applied.</Notice> : <ErrorPanel failure={held.state.failure} what="the held schemes" onRetry={held.reload} />) : held.state.data.rows.length === 0 ? (
          <EmptyState title="No held schemes found">No scheme has a counted transaction yet.</EmptyState>
        ) : (
          <>
            <p className="mb-2 text-sm text-muted">{held.state.data.counts.held} held: {held.state.data.counts.declared} with a declared benchmark, {held.state.data.counts.categoryReference} using the category benchmark, {held.state.data.counts.noBenchmark} with no benchmark for their category; {held.state.data.counts.proposalWaiting} declared proposals waiting for review.</p>
            <HeldSchemesTable rows={held.state.data.rows} canPropose={dec.canReviewMappings} onEnterDeclared={(h) => { setForm(h.sourcePrefilled ? mappingFormForHeldScheme(h) : mappingFormForFactsheet(h.instrumentId)); fb.clear(); }} />
          </>
        )}
      </Panel>

      <Panel title="Schemes with no benchmark mapping yet" description="Counts by AMFI category. Funds with no declared benchmark use the usual benchmark for their category at read time; it is never stored as a mapping.">
        {unmapped.state.status === 'loading' ? <LoadingPanel what="the schemes with no mapping" /> : unmapped.state.status === 'error' ? <ErrorPanel failure={unmapped.state.failure} what="the schemes with no mapping" onRetry={unmapped.reload} /> : (
          <ScrollTable label="Schemes with no mapping, by category" minWidth="min-w-[760px]">
            <thead><tr><Th>Category</Th><Th>Schemes (plans and options)</Th><Th>No mapping yet</Th><Th>Waiting for review</Th><Th>Category benchmark (read time)</Th></tr></thead>
            <tbody>
              {unmapped.state.data.byCategory.map((c) => (
                <tr key={c.category}>
                  <Td>{c.category}</Td>
                  <Td>{c.schemeRows}</Td>
                  <Td>{c.unmappedRows}</Td>
                  <Td>{c.openProposalRows}</Td>
                  <Td>{c.categoryReferenceBenchmark ? <>{c.categoryReferenceBenchmark}<br /><span className="text-xs text-muted">Unverified table; not this fund&apos;s own declared benchmark.</span></> : <span className="text-xs text-muted">None for this category</span>}</Td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Panel>

      <Panel title="Scheme to benchmark mapping proposals" description="Each proposal carries the evidence it rests on. Only deterministic, high-confidence matches to a verified benchmark are ever published automatically; everything else waits here for a reviewer." actions={dec.canReviewMappings ? <Btn onClick={() => { setForm(emptyMappingForm()); fb.clear(); }}>Propose a mapping</Btn> : undefined}>
        {!dec.canReviewMappings ? <Notice tone="info">{dec.why.catalogue} You can read the proposals but not propose or review them.</Notice> : null}
        {proposals.length === 0 ? (
          <EmptyState title="No mapping has been proposed">Nothing is waiting for review.</EmptyState>
        ) : (
          <ScrollTable label="Mapping proposals" minWidth="min-w-[1000px]">
            <thead><tr><Th>Scheme</Th><Th>Benchmark</Th><Th>Relationship</Th><Th>Effective</Th><Th>Evidence</Th><Th>Method</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
            <tbody>
              {proposals.map((p) => {
                const chip = mappingStatusChip(p.status);
                const link = safeExternalUrl(p.evidenceUrl);
                return (
                  <tr key={p.id}>
                    <Td>{p.instrumentName ?? 'Unnamed scheme'}<br /><span className="font-mono text-xs text-muted">{p.instrumentId.slice(0, 8)}</span></Td>
                    <Td>{p.proposedBenchmarkName}<br /><span className="text-xs text-muted">{p.benchmarkKey ? `Catalogue: ${p.benchmarkKey}` : 'Not matched to a catalogue entry'}</span></Td>
                    <Td>{RELATIONSHIP_OPTIONS.find((o) => o.value === p.relationshipType)?.label ?? p.relationshipType}</Td>
                    <Td>{formatDate(p.effectiveFrom)} to {p.effectiveTo ? formatDate(p.effectiveTo) : 'open'}</Td>
                    <Td>
                      {EVIDENCE_SOURCE_OPTIONS.find((o) => o.value === p.evidenceSource)?.label ?? p.evidenceSource}
                      {p.evidenceTitle ? `: ${p.evidenceTitle}` : ''}<br />
                      Document {formatDate(p.evidenceDocumentDate)}, retrieved {formatDate(p.evidenceRetrievedAt)}<br />
                      {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Open the document (new tab)</a> : <span className="text-muted">No valid link</span>}
                      {p.evidenceExcerpt ? <><br /><span className="text-xs text-muted">&quot;{p.evidenceExcerpt}&quot;</span></> : null}
                    </Td>
                    <Td>{RESOLUTION_METHOD_OPTIONS.find((o) => o.value === p.resolutionMethod)?.label ?? p.resolutionMethod}, {p.confidence} confidence{p.ambiguityReason ? <><br /><span className="text-xs text-attention">Ambiguity: {p.ambiguityReason}</span></> : null}</Td>
                    <Td><Chip label={chip.label} tone={chip.tone} />{p.autoPublished ? <><br /><Chip label="Published automatically" tone="info" /></> : null}{p.reviewNote ? <><br /><span className="text-xs text-muted">{p.reviewNote}</span></> : null}</Td>
                    <Td>
                      {canReviewMapping(p, caps) ? (
                        <div className="flex flex-wrap gap-1">
                          <Btn kind="secondary" onClick={() => { setReview({ p, decision: 'approve' }); fbReview.clear(); setNote(''); setClosePrev(false); }}>{`Approve ${p.instrumentId.slice(0, 6)}`}</Btn>
                          <Btn kind="danger" onClick={() => { setReview({ p, decision: 'reject' }); fbReview.clear(); setNote(''); }}>{`Reject ${p.instrumentId.slice(0, 6)}`}</Btn>
                        </div>
                      ) : null}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </ScrollTable>
        )}
      </Panel>

      {review && dec.canReviewMappings ? (
        <Panel title={`${review.decision === 'approve' ? 'Approve' : 'Reject'} the proposal for ${review.p.instrumentName ?? 'this scheme'}`}>
          <div data-form={fbReview.formId}>
          <FormFeedback fb={fbReview} />
          <TextAreaField label="Review note" required value={note} onChange={setNote} hint="At least 10 characters; recorded permanently." error={note.length > 0 ? rp : fbReview.errors.note} fieldKey="note" />
          {review.decision === 'approve' ? <CheckField label="Close the previous primary mapping on the day before this one starts" hint="Needed when this replaces the scheme's current primary benchmark. Two primary mappings cannot overlap." checked={closePrev} onChange={setClosePrev} /> : null}
          <div className="mt-2 flex gap-2"><Btn kind={review.decision === 'reject' ? 'danger' : 'primary'} busy={busy} disabled={rp !== null} onClick={() => void doReview()}>{review.decision === 'approve' ? 'Approve' : 'Reject'}</Btn><Btn kind="secondary" onClick={() => { fbReview.clear(); setReview(null); }}>Cancel</Btn></div>
          </div>
        </Panel>
      ) : null}

      {form && dec.canReviewMappings ? (
        <Panel title="Propose a mapping" description="Use the scheme's own document (information document, factsheet or addendum). Category guidance is not evidence for one scheme.">
          <div data-form={fb.formId}>
          <FormFeedback fb={fb} />
          <div className="grid gap-3 sm:grid-cols-2">
            {held.state.status === 'ready' ? (
              <SelectField label="Held scheme (fills the instrument id)" value={held.state.data.rows.some((h) => h.instrumentId === form.instrumentId) ? form.instrumentId : ''} onChange={(v) => set({ instrumentId: v })} options={held.state.data.rows.map((h) => ({ value: h.instrumentId, label: `${h.displayName} (${h.planType})` }))} placeholder="Another scheme: type its instrument id below" />
            ) : null}
            <TextField label="Instrument id" required value={form.instrumentId} onChange={(v) => set({ instrumentId: v })} error={errors.instrumentId} fieldKey="instrumentId" hint="The scheme's instrument id (UUID)." />
            <SelectField label="Catalogue benchmark (if it exists)" value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v })} options={ov.rows.map((r) => ({ value: r.catalogue.benchmarkKey, label: `${r.catalogue.label} (${r.catalogue.catalogueStatus})` }))} placeholder="Not in the catalogue yet" error={errors.benchmarkKey} fieldKey="benchmarkKey" />
            <TextField label="Benchmark name as the document states it" required value={form.proposedBenchmarkName} onChange={(v) => set({ proposedBenchmarkName: v })} error={errors.proposedBenchmarkName} fieldKey="proposedBenchmarkName" hint={nameHint ? (nameHint.unsupported ? 'This looks like a composite or a commodity price: one catalogue series cannot represent it.' : nameHint.best ? `Closest catalogue entry: ${nameHint.best.entry.benchmarkKey} (${nameHint.best.confidence} confidence${nameHint.best.entryVerified ? '' : ', not yet verified'}). A price index is never suggested for a total-return benchmark.` : 'No catalogue entry matches this name safely.') : undefined} />
            <SelectField label="Relationship" value={form.relationshipType} onChange={(v) => set({ relationshipType: v as MappingFormState['relationshipType'] })} options={RELATIONSHIP_OPTIONS} placeholder="Primary benchmark" error={errors.relationshipType} fieldKey="relationshipType" />
            <DateField label="Effective from" required value={form.effectiveFrom} onChange={(v) => set({ effectiveFrom: v })} error={errors.effectiveFrom} fieldKey="effectiveFrom" />
            <DateField label="Effective to (empty if still in force)" value={form.effectiveTo} onChange={(v) => set({ effectiveTo: v })} error={errors.effectiveTo} fieldKey="effectiveTo" />
            <SelectField label="Document type" required value={form.evidenceSource} onChange={(v) => set({ evidenceSource: v })} options={EVIDENCE_SOURCE_OPTIONS} error={errors.evidenceSource} fieldKey="evidenceSource" />
            <TextField label="Document web address" type="url" required value={form.evidenceUrl} onChange={(v) => set({ evidenceUrl: v })} error={errors.evidenceUrl} fieldKey="evidenceUrl" />
            <TextField label="Document title (optional)" value={form.evidenceTitle} onChange={(v) => set({ evidenceTitle: v })} error={errors.evidenceTitle} fieldKey="evidenceTitle" />
            <DateField label="Document date" required value={form.evidenceDocumentDate} onChange={(v) => set({ evidenceDocumentDate: v })} error={errors.evidenceDocumentDate} fieldKey="evidenceDocumentDate" />
            <DateField label="Retrieved on" required value={form.evidenceRetrievedAt} onChange={(v) => set({ evidenceRetrievedAt: v })} error={errors.evidenceRetrievedAt} fieldKey="evidenceRetrievedAt" />
            <SelectField label="How the benchmark was identified" required value={form.resolutionMethod} onChange={(v) => set({ resolutionMethod: v })} options={RESOLUTION_METHOD_OPTIONS} error={errors.resolutionMethod} fieldKey="resolutionMethod" />
            <SelectField label="Confidence" required value={form.confidence} onChange={(v) => set({ confidence: v })} options={CONFIDENCE_OPTIONS} error={errors.confidence} fieldKey="confidence" />
          </div>
          <div className="mt-3 grid gap-3">
            <TextAreaField label="Excerpt from the document (optional, up to 400 characters)" value={form.evidenceExcerpt} onChange={(v) => set({ evidenceExcerpt: v })} maxLength={400} error={errors.evidenceExcerpt} fieldKey="evidenceExcerpt" />
            <TextAreaField label="Anything ambiguous? (optional)" value={form.ambiguityReason} onChange={(v) => set({ ambiguityReason: v })} hint="Name variants, tiers or dates that need a human decision." error={errors.ambiguityReason} fieldKey="ambiguityReason" />
          </div>
          <div className="mt-3 flex gap-2"><Btn busy={busy} onClick={() => void propose()}>Propose</Btn><Btn kind="secondary" onClick={() => { fb.clear(); setForm(null); }}>Cancel</Btn></div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
