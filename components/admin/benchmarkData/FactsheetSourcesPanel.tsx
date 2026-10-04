'use client';

// "Factsheet sources": the fund-house documents the monthly reader may read, and whether each fund house's terms of use
// have been approved for automated reading. The reader REFUSES to fetch from any source whose terms are not approved
// ("Terms not reviewed" is the default for every source), so this is where a person turns a source on. Changing a status
// needs the entitlement-approval permission (the database checks it again) and a note that is recorded permanently.
import { useState } from 'react';
import type { FactsheetSourceAdminView, FactsheetSourcesResponse, TermsDecision } from '@/lib/services/investment-intelligence/factsheetReader/sourcesView';
import { usePost, useLoad, type Say } from './api';
import { FormFeedback, useFormFeedback, type FormSpec } from './formFeedback';
import { NOTE_FIELD_LABELS, NOTE_FIELD_MAP, NOTE_FIELD_ORDER } from './benchmarkDataFormErrors';
import { EVIDENCE_SOURCE_OPTIONS, FACTSHEET_TERMS_WORDS, apiPaths, formatDate, reviewProblem, safeExternalUrl } from './benchmarkDataUiLogic';
import { Btn, Chip, EmptyState, ErrorPanel, LoadingPanel, Notice, Panel, ScrollTable, Td, TextAreaField, Th } from './ui';

const NOTE_SPEC: FormSpec = { order: NOTE_FIELD_ORDER, labels: NOTE_FIELD_LABELS, map: NOTE_FIELD_MAP };

const ACTION_WORDS: Record<TermsDecision, { button: string; title: string; ok: string; kind: 'primary' | 'secondary' | 'danger'; hint: string }> = {
  approved: { button: 'Approve terms', title: 'Approve the terms', ok: 'The terms are approved. The monthly reader may now read this document when it is switched on.', kind: 'primary', hint: 'Record who reviewed which terms, and when. Approving lets the reader fetch this document.' },
  not_reviewed: { button: 'Mark not reviewed', title: 'Mark the terms as not reviewed', ok: 'Marked as not reviewed. The reader will not fetch this document.', kind: 'secondary', hint: 'Say why the earlier decision no longer stands. The reader stops fetching this document.' },
  declined: { button: 'Reject terms', title: 'Reject the terms', ok: 'The terms are rejected. The reader will not fetch this document.', kind: 'danger', hint: 'A reason is required: say what in the terms does not allow automated reading.' },
};

export default function FactsheetSourcesPanel({ refreshKey, canApproveTerms, whyNot, onChanged, say }: { refreshKey: number; canApproveTerms: boolean; whyNot: string; onChanged: () => void; say: Say }) {
  const { state, reload } = useLoad<FactsheetSourcesResponse>(`${apiPaths.factsheetSources()}?r=${refreshKey}`, 'load the factsheet sources');
  const { busy, post } = usePost(say);
  const fb = useFormFeedback(NOTE_SPEC);
  const [act, setAct] = useState<{ s: FactsheetSourceAdminView; to: TermsDecision } | null>(null);
  const [note, setNote] = useState('');

  if (state.status === 'loading') return <LoadingPanel what="the factsheet sources" />;
  if (state.status === 'error') {
    if (/not available|migration|database update/i.test(state.failure.message)) {
      return (
        <Panel title="Factsheet sources">
          <Notice tone="info">The factsheet reader needs a database update that has not been applied yet. The list of fund-house documents and their terms will appear once it is applied.</Notice>
        </Panel>
      );
    }
    return <ErrorPanel failure={state.failure} what="the factsheet sources" onRetry={reload} />;
  }
  const sources = state.data.sources;
  const rp = reviewProblem(note);

  async function submit() {
    if (!act) return;
    const w = ACTION_WORDS[act.to];
    const r = await post(apiPaths.factsheetSourceTerms(act.s.id), { status: act.to, note: note.trim() }, w.ok, 'record the terms decision');
    if (r.ok) {
      fb.clear();
      setAct(null);
      setNote('');
      reload();
      onChanged();
    } else {
      fb.showServerFailure(r.body, r.message);
    }
  }

  return (
    <div className="space-y-3">
      <Panel
        title="Factsheet sources"
        description="The fund-house documents the monthly factsheet reader may read. A source is read only when its terms are approved; every source starts as not reviewed, so nothing is fetched until a person approves it. Approving, rejecting or withdrawing approval needs the entitlement-approval permission and a note that is recorded permanently."
      >
        {!canApproveTerms ? <Notice tone="info">{whyNot} You can see the sources and their status but not change them.</Notice> : null}
        <div className="mt-2">
          {sources.length === 0 ? (
            <EmptyState title="No source is registered">The reader has nothing to read.</EmptyState>
          ) : (
            <ScrollTable label="Registered fund-house documents and their terms status" minWidth="min-w-[1100px]">
              <thead>
                <tr><Th>Fund house and document</Th><Th>AMFI code</Th><Th>Terms</Th><Th>Last result</Th><Th>Actions</Th></tr>
              </thead>
              <tbody>
                {sources.map((s) => {
                  const link = safeExternalUrl(s.url);
                  const tag = s.sourceKey.slice(0, 24);
                  return (
                    <tr key={s.id}>
                      <Td>
                        {s.amcName}: {EVIDENCE_SOURCE_OPTIONS.find((o) => o.value === s.documentType)?.label ?? s.documentType}<br />
                        <span className="text-xs text-muted">{s.sourceKey}; {s.host}</span><br />
                        {link ? <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-trust underline">Open the document (new tab)</a> : <span className="text-xs text-muted">No valid link</span>}
                        {!s.enabled ? <><br /><Chip label="Disabled" tone="neutral" /></> : null}
                      </Td>
                      <Td>{s.amfiSchemeCodes.length ? s.amfiSchemeCodes.join(', ') : <span className="text-xs text-muted">None</span>}</Td>
                      <Td>
                        <Chip label={FACTSHEET_TERMS_WORDS[s.termsReviewStatus] ?? s.termsReviewStatus} tone={s.termsReviewStatus === 'approved' ? 'ok' : s.termsReviewStatus === 'declined' ? 'bad' : 'neutral'} />
                        {s.termsReviewedAt ? <><br /><span className="text-xs text-muted">Set {formatDate(s.termsReviewedAt)}</span></> : null}
                        {s.termsReviewNote ? <><br /><span className="whitespace-normal text-xs text-muted">{s.termsReviewNote}</span></> : null}
                      </Td>
                      <Td>
                        {s.lastResult ? <>{formatDate(s.lastResult.checkedAt)}<br /><span className="whitespace-normal text-xs text-muted">{s.lastResult.result}</span></> : <span className="text-xs text-muted">Never read</span>}
                      </Td>
                      <Td>
                        {canApproveTerms ? (
                          <div className="flex flex-wrap gap-1">
                            {(['approved', 'not_reviewed', 'declined'] as const).filter((to) => to !== s.termsReviewStatus).map((to) => (
                              <Btn key={to} kind={ACTION_WORDS[to].kind === 'primary' ? 'secondary' : ACTION_WORDS[to].kind} onClick={() => { setAct({ s, to }); fb.clear(); setNote(''); }}>{`${ACTION_WORDS[to].button} ${tag}`}</Btn>
                            ))}
                          </div>
                        ) : null}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </ScrollTable>
          )}
        </div>
      </Panel>

      {act && canApproveTerms ? (
        <Panel title={`${ACTION_WORDS[act.to].title}: ${act.s.amcName}, ${act.s.sourceKey}`}>
          <div data-form={fb.formId}>
            <FormFeedback fb={fb} />
            {act.to === 'approved' ? <Notice tone="warn">Approving means the reader may fetch this document automatically once it is switched on. Approve only after the fund house&apos;s terms of use have been reviewed.</Notice> : null}
            <TextAreaField label={act.to === 'declined' ? 'Reason (required)' : 'Note'} required value={note} onChange={setNote} hint={`At least 10 characters; recorded permanently. ${ACTION_WORDS[act.to].hint}`} error={note.length > 0 ? rp : fb.errors.note} fieldKey="note" />
            <div className="mt-2 flex gap-2">
              <Btn kind={ACTION_WORDS[act.to].kind} busy={busy} disabled={rp !== null} onClick={() => void submit()}>{ACTION_WORDS[act.to].button}</Btn>
              <Btn kind="secondary" onClick={() => { fb.clear(); setAct(null); }}>Cancel</Btn>
            </div>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
