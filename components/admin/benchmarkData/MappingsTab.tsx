'use client';

// Mappings: scheme-to-benchmark proposals with their evidence. A proposal never
// changes what customers see by itself; a reviewer with the catalogue permission
// approves or rejects it. AMFI category guidance is not evidence that a given
// scheme uses a benchmark: the evidence must be the scheme's own document.
import { useState } from 'react';
import type { MappingProposalView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { usePost, useLoad, type Say } from './api';
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
  mappingStatusChip,
  reviewProblem,
  safeExternalUrl,
  validateMappingForm,
  type MappingFormState,
} from './benchmarkDataUiLogic';
import { Btn, CheckField, Chip, EmptyState, ErrorPanel, LoadingPanel, Notice, Panel, ScrollTable, SelectField, Td, TextAreaField, TextField, Th } from './ui';

export default function MappingsTab({ ov, refreshKey, onChanged, say }: { ov: OverviewResponse; refreshKey: number; onChanged: () => void; say: Say }) {
  const caps = ov.capabilities;
  const dec = capabilityDecisions(caps);
  const { state, reload } = useLoad<MappingProposalView[]>(`${apiPaths.mappings()}?r=${refreshKey}`, 'load the mapping proposals');
  const { busy, post } = usePost(say);
  const [form, setForm] = useState<MappingFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
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
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const bm = ov.rows.find((r) => r.catalogue.benchmarkKey === form.benchmarkKey);
    const r = await post(apiPaths.mappings(), buildMappingBody(form, bm ? bm.catalogue.id : null), 'Proposed. It changes nothing until it is reviewed.', 'propose this mapping');
    if (r.ok) {
      setForm(null);
      reload();
      onChanged();
    }
  }

  async function doReview() {
    if (!review) return;
    const r = await post(apiPaths.mappingReview(review.p.id), { decision: review.decision, note: note.trim(), closePrevious: review.decision === 'approve' ? closePrev : undefined }, review.decision === 'approve' ? 'The mapping is approved and now in force.' : 'The proposal is rejected.', 'review this mapping');
    if (r.ok) {
      setReview(null);
      setNote('');
      setClosePrev(false);
      reload();
      onChanged();
    }
  }

  const rp = reviewProblem(note);

  return (
    <div className="space-y-4">
      <Panel title="Scheme to benchmark mapping proposals" description="Each proposal carries the evidence it rests on. Only deterministic, high-confidence matches to a verified benchmark are ever published automatically; everything else waits here for a reviewer." actions={dec.canReviewMappings ? <Btn onClick={() => { setForm(emptyMappingForm()); setErrors({}); }}>Propose a mapping</Btn> : undefined}>
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
                    <Td>{p.effectiveFrom} to {p.effectiveTo ?? 'open'}</Td>
                    <Td>
                      {EVIDENCE_SOURCE_OPTIONS.find((o) => o.value === p.evidenceSource)?.label ?? p.evidenceSource}
                      {p.evidenceTitle ? `: ${p.evidenceTitle}` : ''}<br />
                      Document {p.evidenceDocumentDate}, retrieved {p.evidenceRetrievedAt}<br />
                      {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Open the document (new tab)</a> : <span className="text-muted">No valid link</span>}
                      {p.evidenceExcerpt ? <><br /><span className="text-xs text-muted">&quot;{p.evidenceExcerpt}&quot;</span></> : null}
                    </Td>
                    <Td>{RESOLUTION_METHOD_OPTIONS.find((o) => o.value === p.resolutionMethod)?.label ?? p.resolutionMethod}, {p.confidence} confidence{p.ambiguityReason ? <><br /><span className="text-xs text-attention">Ambiguity: {p.ambiguityReason}</span></> : null}</Td>
                    <Td><Chip label={chip.label} tone={chip.tone} />{p.autoPublished ? <><br /><Chip label="Published automatically" tone="info" /></> : null}{p.reviewNote ? <><br /><span className="text-xs text-muted">{p.reviewNote}</span></> : null}</Td>
                    <Td>
                      {canReviewMapping(p, caps) ? (
                        <div className="flex flex-wrap gap-1">
                          <Btn kind="secondary" onClick={() => { setReview({ p, decision: 'approve' }); setNote(''); setClosePrev(false); }}>{`Approve ${p.instrumentId.slice(0, 6)}`}</Btn>
                          <Btn kind="danger" onClick={() => { setReview({ p, decision: 'reject' }); setNote(''); }}>{`Reject ${p.instrumentId.slice(0, 6)}`}</Btn>
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
          <TextAreaField label="Review note" required value={note} onChange={setNote} hint="At least 10 characters; recorded permanently." error={note.length > 0 ? rp : null} />
          {review.decision === 'approve' ? <CheckField label="Close the previous primary mapping on the day before this one starts" hint="Needed when this replaces the scheme's current primary benchmark. Two primary mappings cannot overlap." checked={closePrev} onChange={setClosePrev} /> : null}
          <div className="mt-2 flex gap-2"><Btn kind={review.decision === 'reject' ? 'danger' : 'primary'} busy={busy} disabled={rp !== null} onClick={() => void doReview()}>{review.decision === 'approve' ? 'Approve' : 'Reject'}</Btn><Btn kind="secondary" onClick={() => setReview(null)}>Cancel</Btn></div>
        </Panel>
      ) : null}

      {form && dec.canReviewMappings ? (
        <Panel title="Propose a mapping" description="Use the scheme's own document (information document, factsheet or addendum). Category guidance is not evidence for one scheme.">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Instrument id" required value={form.instrumentId} onChange={(v) => set({ instrumentId: v })} error={errors.instrumentId} hint="The scheme's instrument id (UUID)." />
            <SelectField label="Catalogue benchmark (if it exists)" value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v })} options={ov.rows.map((r) => ({ value: r.catalogue.benchmarkKey, label: `${r.catalogue.label} (${r.catalogue.catalogueStatus})` }))} placeholder="Not in the catalogue yet" />
            <TextField label="Benchmark name as the document states it" required value={form.proposedBenchmarkName} onChange={(v) => set({ proposedBenchmarkName: v })} error={errors.proposedBenchmarkName} />
            <SelectField label="Relationship" value={form.relationshipType} onChange={(v) => set({ relationshipType: v as MappingFormState['relationshipType'] })} options={RELATIONSHIP_OPTIONS} placeholder="Primary benchmark" />
            <TextField label="Effective from" type="date" required value={form.effectiveFrom} onChange={(v) => set({ effectiveFrom: v })} error={errors.effectiveFrom} />
            <TextField label="Effective to (empty if still in force)" type="date" value={form.effectiveTo} onChange={(v) => set({ effectiveTo: v })} error={errors.effectiveTo} />
            <SelectField label="Document type" required value={form.evidenceSource} onChange={(v) => set({ evidenceSource: v })} options={EVIDENCE_SOURCE_OPTIONS} error={errors.evidenceSource} />
            <TextField label="Document web address" type="url" required value={form.evidenceUrl} onChange={(v) => set({ evidenceUrl: v })} error={errors.evidenceUrl} />
            <TextField label="Document title (optional)" value={form.evidenceTitle} onChange={(v) => set({ evidenceTitle: v })} />
            <TextField label="Document date" type="date" required value={form.evidenceDocumentDate} onChange={(v) => set({ evidenceDocumentDate: v })} error={errors.evidenceDocumentDate} />
            <TextField label="Retrieved on" type="date" required value={form.evidenceRetrievedAt} onChange={(v) => set({ evidenceRetrievedAt: v })} error={errors.evidenceRetrievedAt} />
            <SelectField label="How the benchmark was identified" required value={form.resolutionMethod} onChange={(v) => set({ resolutionMethod: v })} options={RESOLUTION_METHOD_OPTIONS} error={errors.resolutionMethod} />
            <SelectField label="Confidence" required value={form.confidence} onChange={(v) => set({ confidence: v })} options={CONFIDENCE_OPTIONS} error={errors.confidence} />
          </div>
          <div className="mt-3 grid gap-3">
            <TextAreaField label="Excerpt from the document (optional, up to 400 characters)" value={form.evidenceExcerpt} onChange={(v) => set({ evidenceExcerpt: v })} maxLength={400} error={errors.evidenceExcerpt} />
            <TextAreaField label="Anything ambiguous? (optional)" value={form.ambiguityReason} onChange={(v) => set({ ambiguityReason: v })} hint="Name variants, tiers or dates that need a human decision." />
          </div>
          <div className="mt-3 flex gap-2"><Btn busy={busy} onClick={() => void propose()}>Propose</Btn><Btn kind="secondary" onClick={() => setForm(null)}>Cancel</Btn></div>
        </Panel>
      ) : null}
    </div>
  );
}
