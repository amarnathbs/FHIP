'use client';

// "Factsheet changes to review": what the monthly factsheet benchmark reader found that a person must decide.
// The reader only RECORDS what a fund house declares (a dated, append-only history); it never publishes a change, a
// composite, a commodity price, a low-confidence reading or a disagreement. Approving a change creates the
// effective-dated mapping through the existing review path; the earlier benchmark stays on record.
import { useState } from 'react';
import type { FactsheetChangeView, FactsheetChangesResponse } from '@/lib/services/investment-intelligence/factsheetReader/adminView';
import { usePost, useLoad, type Say } from './api';
import { FormFeedback, useFormFeedback, type FormSpec } from './formFeedback';
import { NOTE_FIELD_LABELS, NOTE_FIELD_MAP, NOTE_FIELD_ORDER } from './benchmarkDataFormErrors';
import { EVIDENCE_SOURCE_OPTIONS, FACTSHEET_TERMS_WORDS, apiPaths, factsheetChangeHeading, formatDate, reviewProblem, safeExternalUrl } from './benchmarkDataUiLogic';
import { Btn, CheckField, Chip, EmptyState, ErrorPanel, LoadingPanel, Notice, Panel, ScrollTable, Td, TextAreaField, Th } from './ui';

const NOTE_SPEC: FormSpec = { order: NOTE_FIELD_ORDER, labels: NOTE_FIELD_LABELS, map: NOTE_FIELD_MAP };

type Decision = 'approve' | 'reject' | 'acknowledge';

export default function FactsheetChangesPanel({ refreshKey, canReview, onChanged, onEnterManually, say }: { refreshKey: number; canReview: boolean; onChanged: () => void; onEnterManually: (c: FactsheetChangeView) => void; say: Say }) {
  const { state, reload } = useLoad<FactsheetChangesResponse>(`${apiPaths.factsheetChanges()}?r=${refreshKey}`, 'load the factsheet changes');
  const { busy, post } = usePost(say);
  const fb = useFormFeedback(NOTE_SPEC);
  const [review, setReview] = useState<{ c: FactsheetChangeView; decision: Decision } | null>(null);
  const [note, setNote] = useState('');
  const [closePrev, setClosePrev] = useState(false);

  if (state.status === 'loading') return <LoadingPanel what="the factsheet changes" />;
  if (state.status === 'error') {
    if (/not available|migration/i.test(state.failure.message)) {
      return (
        <Panel title="Factsheet changes to review">
          <Notice tone="info">The factsheet reader needs a database update that has not been applied yet. Everything else on this tab works; this queue will appear once the update is applied.</Notice>
        </Panel>
      );
    }
    return <ErrorPanel failure={state.failure} what="the factsheet changes" onRetry={reload} />;
  }
  const data = state.data;
  const rp = reviewProblem(note);

  async function decide() {
    if (!review) return;
    const { c, decision } = review;
    const ok = decision === 'approve' ? 'The mapping is approved and now in force. The earlier benchmark stays on record.' : decision === 'acknowledge' ? 'Recorded. The scheme is shown as having a declared benchmark that cannot be compared.' : 'The item is rejected. Nothing was published.';
    const r = await post(apiPaths.factsheetChangeReview(c.versionId), { decision, note: note.trim(), closePrevious: decision === 'reject' ? undefined : closePrev }, ok, 'decide this factsheet change');
    if (r.ok) {
      fb.clear();
      setReview(null);
      setNote('');
      setClosePrev(false);
      reload();
      onChanged();
    } else {
      fb.showServerFailure(r.body, r.message);
    }
  }

  const start = (c: FactsheetChangeView, decision: Decision) => {
    setReview({ c, decision });
    fb.clear();
    setNote('');
    setClosePrev(c.kind === 'changed' && decision !== 'reject');
  };

  return (
    <div className="space-y-3">
      <Panel
        title="Factsheet changes to review"
        description="The monthly reader records the benchmark each fund house declares for the schemes users hold, as a dated history that is never overwritten. Anything that is not a clean, repeated, single-index match (a change, a composite, a commodity price, an index we do not hold, low confidence) waits here for a person. Nothing here is published automatically."
      >
        {data.readerSwitchedOn === false ? <Notice tone="info">The monthly reader is switched off, so nothing is fetched. It stays off until a person switches it on and a fund house&apos;s terms are approved for each source.</Notice> : null}
        {data.readerSwitchedOn === null ? <Notice tone="info">Whether the monthly reader is switched on is not visible to your role.</Notice> : null}
        {data.readerSwitchedOn === true ? <Notice tone="warn">The monthly reader is switched on.</Notice> : null}
        {data.sources.length > 0 ? (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer font-semibold text-trust">Registered documents ({data.sources.length}) and whether their terms are approved</summary>
            <ScrollTable label="Registered fund-house documents" minWidth="min-w-[640px]">
              <thead>
                <tr><Th>Document</Th><Th>Fund house</Th><Th>Type</Th><Th>Site</Th><Th>Terms</Th></tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.sourceKey}>
                    <Td>{s.sourceKey}</Td>
                    <Td>{s.amcName}</Td>
                    <Td>{EVIDENCE_SOURCE_OPTIONS.find((o) => o.value === s.documentType)?.label ?? s.documentType}</Td>
                    <Td>{s.host}</Td>
                    <Td><Chip label={FACTSHEET_TERMS_WORDS[s.termsReviewStatus] ?? s.termsReviewStatus} tone={s.termsReviewStatus === 'approved' ? 'ok' : 'neutral'} /></Td>
                  </tr>
                ))}
              </tbody>
            </ScrollTable>
          </details>
        ) : null}
        <div className="mt-3">
          {data.items.length === 0 ? (
            <EmptyState title="No factsheet change is waiting">Nothing to review. A change appears here after the reader has read a fund house document whose declared benchmark differs from the one on record.</EmptyState>
          ) : (
            <ScrollTable label="Factsheet changes waiting for review" minWidth="min-w-[1000px]">
              <thead>
                <tr><Th>Scheme</Th><Th>Previous benchmark</Th><Th>New benchmark</Th><Th>Document</Th><Th>Confidence</Th><Th>Actions</Th></tr>
              </thead>
              <tbody>
                {data.items.map((c) => {
                  const link = safeExternalUrl(c.documentUrl);
                  const tag = c.instrumentId.slice(0, 6);
                  return (
                    <tr key={c.versionId}>
                      <Td>{c.instrumentName ?? 'Unnamed scheme'}<br /><span className="text-xs text-muted">{factsheetChangeHeading(c)}</span></Td>
                      <Td>{c.previousBenchmark ?? <span className="text-xs text-muted">None on record</span>}</Td>
                      <Td>
                        {c.newBenchmark}
                        {c.benchmarkKind === 'composite' && c.composition.length > 0 ? <><br /><span className="text-xs text-muted">Composition: {c.composition.map((l) => `${l.weightPct !== null ? `${l.weightPct}% ` : ''}${l.name}`).join(' + ')}</span></> : null}
                        {c.additionalBenchmarks.length > 0 ? <><br /><span className="text-xs text-muted">Additional: {c.additionalBenchmarks.join('; ')}</span></> : null}
                        <br /><span className="text-xs text-muted">Effective from {formatDate(c.effectiveFrom)}{c.effectiveFromBasis === 'estimated_document_month' ? ' (estimated from the document month)' : ' (as the document states)'}</span>
                        {c.reviewReason ? <><br /><span className="text-xs text-attention">{c.reviewReason}</span></> : null}
                      </Td>
                      <Td>
                        {EVIDENCE_SOURCE_OPTIONS.find((o) => o.value === c.documentType)?.label ?? c.documentType}{c.documentTitle ? `: ${c.documentTitle}` : ''}<br />
                        Document {c.documentDate ? formatDate(c.documentDate) : `from ${formatDate(c.documentMonth)} (day not found)`}, read {formatDate(c.retrievedAt)}<br />
                        {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Open the document (new tab)</a> : <span className="text-muted">No valid link</span>}
                      </Td>
                      <Td>
                        <Chip label={`${c.extractionConfidence} confidence`} tone={c.extractionConfidence === 'high' ? 'ok' : 'warn'} /><br />
                        <span className="text-xs text-muted">{c.extractionMethod === 'text_pattern' ? 'Read by text pattern' : c.extractionMethod === 'ai' ? 'Read by AI only' : c.extractionMethod === 'text_pattern_and_ai' ? 'Text pattern and AI' : 'Entered manually'}</span>
                        {c.matchedBenchmarkKey ? <><br /><span className="text-xs text-muted">Catalogue: {c.matchedBenchmarkKey}{c.matchConfidence ? ` (${c.matchConfidence})` : ''}</span></> : null}
                      </Td>
                      <Td>
                        {canReview ? (
                          <div className="flex flex-wrap gap-1">
                            {c.canApprove ? <Btn kind="secondary" onClick={() => start(c, 'approve')}>{`Approve ${tag}`}</Btn> : null}
                            {!c.canApprove && c.canAcknowledge ? <Btn kind="secondary" onClick={() => start(c, 'acknowledge')}>{`Acknowledge ${tag}`}</Btn> : null}
                            <Btn kind="danger" onClick={() => start(c, 'reject')}>{`Reject ${tag}`}</Btn>
                            <Btn kind="secondary" onClick={() => onEnterManually(c)}>{`Enter manually ${tag}`}</Btn>
                          </div>
                        ) : (
                          <span className="text-xs text-muted">Needs the catalogue permission</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </ScrollTable>
          )}
        </div>
      </Panel>

      {review && canReview ? (
        <Panel title={`${review.decision === 'approve' ? 'Approve' : review.decision === 'acknowledge' ? 'Acknowledge' : 'Reject'} the factsheet change for ${review.c.instrumentName ?? 'this scheme'}`}>
          <div data-form={fb.formId}>
            <FormFeedback fb={fb} />
            {review.decision === 'acknowledge' ? <Notice tone="info">Nothing is published. The scheme is shown as &quot;Declared benchmark: {review.c.newBenchmark} (cannot be compared with the data we hold)&quot; and no comparison number is shown for it. The record stays on file.</Notice> : null}
            <TextAreaField label="Review note" required value={note} onChange={setNote} hint="At least 10 characters; recorded permanently." error={note.length > 0 ? rp : fb.errors.note} fieldKey="note" />
            {review.decision !== 'reject' ? <CheckField label="Close the previous primary mapping on the day before this benchmark took effect" hint="Needed when this replaces the scheme's current benchmark. The earlier benchmark stays on record for the earlier period." checked={closePrev} onChange={setClosePrev} /> : null}
            <div className="mt-2 flex gap-2">
              <Btn kind={review.decision === 'reject' ? 'danger' : 'primary'} busy={busy} disabled={rp !== null} onClick={() => void decide()}>{review.decision === 'approve' ? 'Approve' : review.decision === 'acknowledge' ? 'Acknowledge' : 'Reject'}</Btn>
              <Btn kind="secondary" onClick={() => { fb.clear(); setReview(null); }}>Cancel</Btn>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
