'use client';

// Entitlements: what FHIP may DO with each benchmark, right by right. A licence
// status label on a benchmark grants nothing; only an approved record does.
//
// Edit (migration 0280): a draft is edited in place by the person who proposed it; an approved record is never
// changed in place - "Edit (needs approval)" proposes ONE revision that waits for approval while the approved record
// keeps granting. The list shows current records; "Show history" adds replaced and revoked ones.
import { useEffect, useRef, useState } from 'react';
import type { EntitlementRightsView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { usePost, type Say } from './api';
import { FormFeedback, useFormFeedback, type FormSpec } from './formFeedback';
import { ENTITLEMENT_DATE_KEYS, ENTITLEMENT_FIELD_LABELS, ENTITLEMENT_FIELD_MAP, ENTITLEMENT_FIELD_ORDER, NOTE_FIELD_LABELS, NOTE_FIELD_MAP, NOTE_FIELD_ORDER } from './benchmarkDataFormErrors';
import {
  ENTITLEMENT_RIGHT_INFO,
  LICENCE_STATUS_EXPLAINER,
  MIN_NOTE,
  apiPaths,
  buildEntitlementBody,
  canApproveEntitlementNow,
  capabilityDecisions,
  emptyEntitlementForm,
  entitlementPanelKeys,
  entitlementActions,
  entitlementKindLabel,
  formatDate,
  noteProblem,
  postExpiryLabel,
  revealScrollBehavior,
  safeExternalUrl,
  shouldRevealPanel,
  validateEntitlementForm,
  type EntitlementFormState,
  type OpenPanelKey,
} from './benchmarkDataUiLogic';
import {
  buildEditBody,
  buildReviseBody,
  changedFormFields,
  editActionsFor,
  editPanelDescription,
  editPanelTitle,
  editSuccessMessage,
  entitlementFormFromRecord,
  REVISION_REASON_MIN,
  lifecycleChip,
  reasonProblem,
  revisionComparison,
  splitEntitlements,
  type EditMode,
} from './entitlementEditLogic';
import EntitlementHistoryPanel from './EntitlementHistoryPanel';
import { Btn, CheckField, Chip, EmptyState, Notice, Panel, ScrollTable, SelectField, Td, DateField, TextAreaField, TextField, Th } from './ui';

const PROPOSE_SPEC: FormSpec = { order: ENTITLEMENT_FIELD_ORDER, labels: ENTITLEMENT_FIELD_LABELS, map: ENTITLEMENT_FIELD_MAP, dateKeys: ENTITLEMENT_DATE_KEYS };
const NOTE_SPEC: FormSpec = { order: NOTE_FIELD_ORDER, labels: NOTE_FIELD_LABELS, map: NOTE_FIELD_MAP };

type ActionKind = 'approve' | 'revoke' | 'reject-revision' | 'cancel-revision';
/** `e` is the record the action acts on (for a revision action, the revision); `original` is the approved record a revision would replace. */
type Action = { kind: ActionKind; e: EntitlementRightsView; label: string; original?: EntitlementRightsView };
type EditState = { mode: EditMode; target: EntitlementRightsView; benchmarkLabel: string };

const ACTION_TEXT: Record<ActionKind, { title: (label: string, isRevision: boolean) => string; field: string; submit: string; min: number; ok: string; what: string; kind: 'primary' | 'danger' }> = {
  approve: {
    title: (label, isRevision) => (isRevision ? `Approve a revision of the entitlement for ${label}` : `Approve an entitlement for ${label}`),
    field: 'Approval note',
    submit: 'Approve',
    min: 5,
    ok: 'The entitlement is approved.',
    what: 'approve this entitlement',
    kind: 'primary',
  },
  revoke: {
    title: (label) => `Revoke an entitlement for ${label}`,
    field: 'Reason for revoking',
    submit: 'Revoke',
    min: MIN_NOTE,
    ok: 'The entitlement is revoked. Publications that depend on it will now be refused.',
    what: 'revoke this entitlement',
    kind: 'danger',
  },
  'reject-revision': {
    title: (label) => `Reject the revision for ${label}`,
    field: 'Reason for rejecting',
    submit: 'Reject revision',
    min: MIN_NOTE,
    ok: 'The revision was rejected. The approved record is unchanged.',
    what: 'reject this revision',
    kind: 'danger',
  },
  'cancel-revision': {
    title: (label) => `Cancel the revision for ${label}`,
    field: 'Reason for cancelling',
    submit: 'Cancel revision',
    min: MIN_NOTE,
    ok: 'The revision was cancelled. The approved record is unchanged.',
    what: 'cancel this revision',
    kind: 'danger',
  },
};

export default function EntitlementsTab({ ov, onChanged, say }: { ov: OverviewResponse; onChanged: () => void; say: Say }) {
  const caps = ov.capabilities;
  const dec = capabilityDecisions(caps);
  const editSupported = ov.entitlementEdit === true;
  const { busy, post } = usePost(say);
  const [form, setForm] = useState<EntitlementFormState | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [initialForm, setInitialForm] = useState<EntitlementFormState | null>(null);
  const [reason, setReason] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [timeline, setTimeline] = useState<{ id: string; title: string } | null>(null);
  const fb = useFormFeedback(PROPOSE_SPEC);
  const fbAction = useFormFeedback(NOTE_SPEC);
  const errors = fb.errors;
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [selfAck, setSelfAck] = useState(false);
  const set = (p: Partial<EntitlementFormState>) => setForm((f) => (f ? { ...f, ...p } : f));
  const groups = ov.rows.filter((r) => r.entitlements.length > 0);

  // An opened panel is scrolled into view and its heading focused (keyboard + screen-reader users), never silently
  // appended far below the control. Reduced-motion users get an instant jump.
  const proposeHeading = useRef<HTMLHeadingElement>(null);
  const actionHeading = useRef<HTMLHeadingElement>(null);
  const historyHeading = useRef<HTMLHeadingElement>(null);
  const [pressTick, setPressTick] = useState(0);
  const lastPress = useRef(0);
  const keys = entitlementPanelKeys(form, action, edit ? `${edit.mode}:${edit.target.entitlementId}` : null);
  const prevKeys = useRef<{ propose: OpenPanelKey; action: OpenPanelKey }>({ propose: null, action: null });
  const revealRef = useRef<((el: HTMLHeadingElement | null) => void) | null>(null);
  useEffect(() => {
    const reveal = (el: HTMLHeadingElement | null) => {
      if (!el) return;
      const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'start', behavior: revealScrollBehavior(reduced) });
      el.focus({ preventScroll: true });
    };
    revealRef.current = reveal;
    const pressed = pressTick !== lastPress.current;
    lastPress.current = pressTick;
    if (shouldRevealPanel(prevKeys.current.propose, keys.propose, pressed && keys.propose !== null)) reveal(proposeHeading.current);
    else if (shouldRevealPanel(prevKeys.current.action, keys.action, pressed && keys.action !== null)) reveal(actionHeading.current);
    prevKeys.current = keys;
  }, [keys.propose, keys.action, pressTick]); // eslint-disable-line react-hooks/exhaustive-deps -- keys is derived from these two strings

  // The history panel opens after a press on a History button and takes keyboard focus the same way.
  const [historyTick, setHistoryTick] = useState(0);
  useEffect(() => {
    if (timeline) revealRef.current?.(historyHeading.current);
  }, [timeline?.id, historyTick]); // eslint-disable-line react-hooks/exhaustive-deps -- reveal only when another record's history opens or the same button is pressed again

  function closeForm() {
    fb.clear();
    setForm(null);
    setEdit(null);
    setInitialForm(null);
    setReason('');
  }

  function startEdit(mode: EditMode, target: EntitlementRightsView, benchmarkKey: string, benchmarkLabel: string) {
    const f = entitlementFormFromRecord(target, benchmarkKey);
    setForm(f);
    setInitialForm(f);
    setEdit({ mode, target, benchmarkLabel });
    setReason(mode === 'revision' ? target.edit?.revisionReason ?? '' : '');
    setAction(null);
    fb.clear();
    setPressTick((t) => t + 1);
  }

  const changed = edit && form && initialForm ? changedFormFields(initialForm, form) : [];
  const reasonChanged = edit?.mode === 'revision' && reason.trim() !== (edit.target.edit?.revisionReason ?? '');
  const nothingChanged = edit !== null && changed.length === 0 && !reasonChanged;

  async function propose() {
    if (!form) return;
    const row = ov.rows.find((r) => r.catalogue.benchmarkKey === form.benchmarkKey);
    const e = validateEntitlementForm(form, row?.catalogue);
    const rp = edit && edit.mode !== 'draft' ? reasonProblem(reason) : null;
    const all = rp ? { ...e, revisionReason: rp } : e;
    fb.showClientErrors(all);
    if (Object.keys(all).length > 0) return;
    if (!row) return;
    let r: Awaited<ReturnType<typeof post>>;
    if (!edit) {
      r = await post(apiPaths.entitlements(), buildEntitlementBody(form, row.catalogue), 'Proposed. It grants nothing until a user who can approve entitlements approves it.', 'propose this entitlement');
    } else if (edit.mode === 'revise') {
      r = await post(apiPaths.entitlementRevise(edit.target.entitlementId), buildReviseBody(form, row.catalogue, reason), editSuccessMessage('revise'), 'propose this revision');
    } else {
      const count = edit.target.edit?.editCount ?? 0;
      r = await post(apiPaths.entitlementEdit(edit.target.entitlementId), buildEditBody(form, row.catalogue, count, edit.mode === 'revision' ? reason : undefined), editSuccessMessage(edit.mode), 'save this entitlement');
    }
    if (r.ok) {
      closeForm();
      onChanged();
    } else {
      fb.showServerFailure(r.body, r.message);
    }
  }

  async function submitAction() {
    if (!action) return;
    const t = ACTION_TEXT[action.kind];
    const id = action.e.entitlementId;
    const ok =
      action.kind === 'approve'
        ? await post(apiPaths.entitlementApprove(id), { note: note.trim(), selfApprovalAck: action.e.proposedByMe ? selfAck : undefined, expectedEditCount: action.e.edit?.editCount }, action.original ? 'The revision is approved. The earlier version is now replaced and stays visible in the history.' : t.ok, t.what)
        : action.kind === 'revoke'
          ? await post(apiPaths.entitlementRevoke(id), { reason: note.trim() }, t.ok, t.what)
          : action.kind === 'reject-revision'
            ? await post(apiPaths.entitlementRejectRevision(id), { reason: note.trim() }, t.ok, t.what)
            : await post(apiPaths.entitlementCancelRevision(id), { reason: note.trim() }, t.ok, t.what);
    if (ok.ok) {
      fbAction.clear();
      setAction(null);
      setNote('');
      setSelfAck(false);
      onChanged();
    } else {
      fbAction.showServerFailure(ok.body, ok.message);
    }
  }

  const actionText = action ? ACTION_TEXT[action.kind] : null;
  const approveCheck = action?.kind === 'approve' ? canApproveEntitlementNow({ note, proposedByMe: action.e.proposedByMe, selfApprovalAck: selfAck }) : null;
  const closeProblem = action && action.kind !== 'approve' && actionText ? noteProblem(note, actionText.min, `The ${actionText.field.toLowerCase()}`) : null;
  const comparison = action?.kind === 'approve' && action.original ? revisionComparison(action.original, action.e) : [];

  function openAction(kind: ActionKind, e: EntitlementRightsView, label: string, original?: EntitlementRightsView) {
    setAction({ kind, e, label, original });
    setNote('');
    setSelfAck(false);
    closeForm();
    fbAction.clear();
    setPressTick((t) => t + 1);
  }

  // With no records yet the form opens directly beneath the Propose button's panel header (not far below it).
  const proposeInline = groups.length === 0;
  const isEditing = edit !== null;
  const benchmarkLocked = edit !== null && edit.mode !== 'draft';
  const proposeForm = form && dec.canProposeEntitlement ? (
        <Panel headingRef={proposeHeading} title={edit ? editPanelTitle(edit.mode, edit.benchmarkLabel) : 'Propose an entitlement'} description={edit ? editPanelDescription(edit.mode) : 'A proposal grants nothing until a user with the approval permission approves it.'}>
          <div data-form={fb.formId}>
          <FormFeedback fb={fb} />
          {edit && edit.mode !== 'draft' ? (
            <div className="mb-3">
              <TextAreaField label="Reason for the change" required value={reason} onChange={setReason} error={errors.revisionReason} fieldKey="revisionReason" hint={`At least ${REVISION_REASON_MIN} characters. It is recorded with the revision and shown to the approver.`} />
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Benchmark" required value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v })} disabled={benchmarkLocked} hint={benchmarkLocked ? 'A revision keeps the benchmark of the record it replaces. To cover another benchmark, propose a new record.' : undefined} options={ov.rows.map((r) => ({ value: r.catalogue.benchmarkKey, label: `${r.catalogue.label} (${r.catalogue.currencyCode ?? 'no currency'})` }))} error={errors.benchmarkKey} fieldKey="benchmarkKey" />
            <SelectField label="Kind of permission" required value={form.kind} onChange={(v) => set({ kind: v as EntitlementFormState['kind'] })} options={[{ value: 'public_use_permission', label: 'Public-use permission (published terms)' }, { value: 'commercial_licence', label: 'Commercial licence' }]} error={errors.kind} fieldKey="kind" />
          </div>
          <fieldset data-field-key="rights" tabIndex={-1} aria-invalid={errors.rights ? true : undefined} className={`mt-3 rounded-compact border p-3 ${errors.rights ? 'border-risk ring-1 ring-risk' : 'border-line'}`}>
            <legend className="px-1 text-sm font-medium text-ink">Rights granted <span className="text-risk">(required: tick at least one)</span></legend>
            {ENTITLEMENT_RIGHT_INFO.map((r) => <CheckField key={r.key} label={r.label} hint={r.meaning} checked={form.rights[r.key]} onChange={(v) => set({ rights: { ...form.rights, [r.key]: v } })} />)}
            {errors.rights ? <p id="entitlement-rights-error" role="alert" className="text-xs font-medium text-risk">{errors.rights}</p> : null}
          </fieldset>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <DateField label="Valid from" required value={form.validFrom} onChange={(v) => set({ validFrom: v })} error={errors.validFrom} fieldKey="validFrom" />
            <DateField label="Valid to (empty if no end)" value={form.validTo} onChange={(v) => set({ validTo: v })} error={errors.validTo} fieldKey="validTo" />
            <DateField label="First data date covered (optional)" value={form.dataFrom} onChange={(v) => set({ dataFrom: v })} error={errors.dataFrom} fieldKey="dataFrom" />
            <DateField label="Last data date covered (optional)" value={form.dataTo} onChange={(v) => set({ dataTo: v })} error={errors.dataTo} fieldKey="dataTo" />
            <SelectField label="Stored data after expiry" value={form.postExpiryStorage} onChange={(v) => set({ postExpiryStorage: (v || 'unknown') as EntitlementFormState['postExpiryStorage'] })} options={[{ value: 'retain', label: 'May be kept' }, { value: 'delete', label: 'Must be deleted' }, { value: 'unknown', label: 'Not stated' }]} placeholder="Not stated" error={errors.postExpiryStorage} fieldKey="postExpiryStorage" />
            <TextField label="Evidence reference" required value={form.evidenceReference} onChange={(v) => set({ evidenceReference: v })} error={errors.evidenceReference} fieldKey="evidenceReference" hint="Document title or contract reference." />
            <TextField label="Evidence URL" type="url" required={form.kind === 'public_use_permission' ? true : 'optional; required for a public-use permission'} value={form.evidenceUrl} onChange={(v) => set({ evidenceUrl: v })} error={errors.evidenceUrl} fieldKey="evidenceUrl" />
            <DateField label="Evidence document date" required={form.kind === 'public_use_permission' ? true : 'optional; required for a public-use permission'} value={form.evidenceDocumentDate} onChange={(v) => set({ evidenceDocumentDate: v })} error={errors.evidenceDocumentDate} fieldKey="evidenceDocumentDate" />
            <DateField label="Evidence retrieved on" required={form.kind === 'public_use_permission' ? true : 'optional; required for a public-use permission'} value={form.evidenceRetrievedAt} onChange={(v) => set({ evidenceRetrievedAt: v })} error={errors.evidenceRetrievedAt} fieldKey="evidenceRetrievedAt" />
            <TextField label="Attribution wording (optional)" value={form.attributionText} onChange={(v) => set({ attributionText: v })} error={errors.attributionText} fieldKey="attributionText" />
          </div>
          {form.kind === 'public_use_permission' ? <p className="mt-2 text-xs text-muted">A public-use permission must be backed by a document: its web address, its date and the date you retrieved it. A box saying you have permission is not enough.</p> : null}
          <div className="mt-3"><TextAreaField label="Notes (optional)" value={form.notes} onChange={(v) => set({ notes: v })} error={errors.notes} fieldKey="notes" /></div>
          {isEditing ? (
            <p id="entitlement-changes-summary" className="mt-3 text-sm text-muted" aria-live="polite">
              {nothingChanged ? 'Nothing has been changed yet. Change at least one field to save.' : `Changed so far: ${[...changed, ...(reasonChanged ? ['Reason for the change'] : [])].join(', ')}.`}
            </p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Btn busy={busy} disabled={nothingChanged} describedBy={isEditing ? 'entitlement-changes-summary' : undefined} onClick={() => void propose()}>{!edit ? 'Propose' : edit.mode === 'revise' ? 'Propose revision' : 'Save changes'}</Btn>
            <Btn kind="secondary" onClick={() => closeForm()}>Cancel</Btn>
          </div>
          </div>
        </Panel>
  ) : null;

  return (
    <div className="space-y-4">
      <Panel title="What each right means">
        <Notice tone="warn">{LICENCE_STATUS_EXPLAINER}</Notice>
        <dl className="mt-3 grid gap-2 sm:grid-cols-2">
          {ENTITLEMENT_RIGHT_INFO.map((r) => (
            <div key={r.key} className="text-sm"><dt className="inline font-semibold text-ink">{r.label}: </dt><dd className="inline text-muted">{r.meaning}</dd></div>
          ))}
        </dl>
      </Panel>

      <Panel title="Entitlement records" description="Grouped by benchmark. Only an approved record inside its term grants a right." actions={dec.canProposeEntitlement ? <Btn onClick={() => { closeForm(); setForm(emptyEntitlementForm()); setAction(null); setPressTick((t) => t + 1); }}>Propose an entitlement</Btn> : undefined}>
        {!dec.canProposeEntitlement ? <Notice tone="info">{dec.why.catalogue} You can propose nothing here.</Notice> : null}
        {!dec.canApproveEntitlement ? <p className="mt-2 text-sm text-muted">{dec.why.entitlementApprove}</p> : null}
        {editSupported ? (
          <div className="mt-2 space-y-1">
            <p className="text-sm text-muted">To change an approved record choose Edit (needs approval). The approved record keeps granting until the revision is approved, then it is replaced and kept in the history. No second approved record is created.</p>
            <CheckField label="Show history (replaced and revoked records)" checked={showHistory} onChange={setShowHistory} />
          </div>
        ) : null}
        {proposeInline && proposeForm ? <div className="mt-3">{proposeForm}</div> : null}
        {groups.length === 0 ? (
          <div className="mt-3"><EmptyState title="No entitlement has been recorded">Until a record is approved, no benchmark can be published, calculated or shown.</EmptyState></div>
        ) : (
          groups.map((g) => {
            const sp = editSupported ? splitEntitlements(g.entitlements) : { current: g.entitlements, history: [], openRevisionOf: new Map<string, EntitlementRightsView>() };
            const listed = showHistory ? [...sp.current, ...sp.history] : sp.current;
            return (
            <div key={g.catalogue.benchmarkKey} className="mt-3">
              <h3 className="mb-1 text-sm font-semibold text-ink">{g.catalogue.label} <span className="font-mono text-xs text-muted">{g.catalogue.benchmarkKey}</span></h3>
              {listed.length === 0 ? <p className="text-sm text-muted">No current record. Choose Show history to see the earlier ones.</p> : (
              <ScrollTable label={`Entitlements for ${g.catalogue.label}`} minWidth="min-w-[980px]">
                <thead>
                  <tr><Th>Status</Th><Th>Kind</Th>{ENTITLEMENT_RIGHT_INFO.map((r) => <Th key={r.key}>{r.short}</Th>)}<Th>Term</Th><Th>Data range</Th><Th>After expiry</Th><Th>Evidence</Th><Th>Actions</Th></tr>
                </thead>
                <tbody>
                  {listed.map((e) => {
                    const chip = lifecycleChip(e);
                    const acts = entitlementActions(e, caps);
                    const revision = sp.openRevisionOf.get(e.entitlementId);
                    const editActs = editActionsFor(e, revision, caps, editSupported);
                    const link = safeExternalUrl(e.evidenceUrl);
                    const short = e.entitlementId.slice(0, 6);
                    return (
                      <tr key={e.entitlementId}>
                        <Td>
                          <div className="flex flex-col items-start gap-1">
                            <Chip label={chip.label} tone={chip.tone} />
                            {revision ? <Chip label="Revision awaiting approval" tone="warn" title="This record keeps granting as shown. A proposed change waits for approval." /> : null}
                            {e.edit?.endedAt ? <span className="text-xs text-muted">{e.edit.supersededAt ? 'Replaced' : 'Ended'} {formatDate(e.edit.endedAt)}</span> : null}
                          </div>
                        </Td>
                        <Td>{entitlementKindLabel(e.kind)}</Td>
                        {ENTITLEMENT_RIGHT_INFO.map((r) => <Td key={r.key}>{e.rights[r.key] ? 'Yes' : 'No'}</Td>)}
                        <Td>{formatDate(e.validFrom)} to {e.validTo ? formatDate(e.validTo) : 'open'}</Td>
                        <Td>{e.dataFrom ? formatDate(e.dataFrom) : 'any start'} to {e.dataTo ? formatDate(e.dataTo) : 'any end'}</Td>
                        <Td>{postExpiryLabel(e.postExpiryStorage)}</Td>
                        <Td>{e.evidenceReference}{link ? <> <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Document (opens in a new tab)</a></> : null}</Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {acts.canApprove ? <Btn kind="secondary" onClick={() => openAction('approve', e, g.catalogue.label)}>{`Approve ${short}`}</Btn> : null}
                            {editActs.editDraft ? <Btn kind="secondary" ariaLabel={`Edit, record ${short}`} onClick={() => startEdit('draft', e, g.catalogue.benchmarkKey, g.catalogue.label)}>Edit</Btn> : null}
                            {editActs.reviseApproved ? <Btn kind="secondary" ariaLabel={`Edit (needs approval), record ${short}`} onClick={() => startEdit('revise', e, g.catalogue.benchmarkKey, g.catalogue.label)}>Edit (needs approval)</Btn> : null}
                            {revision && editActs.editRevision ? <Btn kind="secondary" ariaLabel={`Edit revision of record ${short}`} onClick={() => startEdit('revision', revision, g.catalogue.benchmarkKey, g.catalogue.label)}>Edit revision</Btn> : null}
                            {revision && editActs.approveRevision ? <Btn kind="secondary" ariaLabel={`Review revision of record ${short}`} onClick={() => openAction('approve', revision, g.catalogue.label, e)}>Review revision</Btn> : null}
                            {revision && editActs.rejectRevision ? <Btn kind="danger" ariaLabel={`Reject revision of record ${short}`} onClick={() => openAction('reject-revision', revision, g.catalogue.label, e)}>Reject revision</Btn> : null}
                            {revision && editActs.cancelRevision ? <Btn kind="danger" ariaLabel={`Cancel revision of record ${short}`} onClick={() => openAction('cancel-revision', revision, g.catalogue.label, e)}>Cancel revision</Btn> : null}
                            {acts.canRevoke ? <Btn kind="danger" onClick={() => openAction('revoke', e, g.catalogue.label)}>{`Revoke ${short}`}</Btn> : null}
                            {editSupported ? <Btn kind="secondary" ariaLabel={`History of record ${short}`} onClick={() => { setTimeline({ id: e.entitlementId, title: `History of the ${g.catalogue.label} record ${short}` }); setHistoryTick((t) => t + 1); }}>History</Btn> : null}
                          </div>
                          {editActs.note ? <p className="mt-1 text-xs text-muted">{editActs.note}</p> : null}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </ScrollTable>
              )}
            </div>
            );
          })
        )}
      </Panel>

      {action && actionText && (action.kind === 'cancel-revision' ? dec.canEditEntitlement : dec.canApproveEntitlement) ? (
        <Panel headingRef={actionHeading} title={actionText.title(action.label, action.original !== undefined)}>
          <div data-form={fbAction.formId}>
          <FormFeedback fb={fbAction} />
          {action.original ? (
            <div className="mb-3 space-y-2">
              <Notice tone="info">The approved record keeps granting until you approve. On approval the revision replaces it in one step, and the replaced record stays in the history. If you reject the revision, the approved record is unchanged.</Notice>
              {action.e.edit?.revisionReason ? <p className="text-sm text-ink">Reason given for the change: {action.e.edit.revisionReason}</p> : null}
              {comparison.length === 0 ? <p className="text-sm text-muted">No visible field differs from the approved record.</p> : (
                <ScrollTable label="What the revision changes" minWidth="min-w-[560px]">
                  <thead><tr><Th>Field</Th><Th>Approved record now</Th><Th>Revision</Th></tr></thead>
                  <tbody>{comparison.map((c) => <tr key={c.label}><Td>{c.label}</Td><Td>{c.current}</Td><Td>{c.proposed}</Td></tr>)}</tbody>
                </ScrollTable>
              )}
            </div>
          ) : null}
          <TextAreaField label={actionText.field} required value={note} onChange={setNote} error={fbAction.errors.note} fieldKey="note" hint={`At least ${actionText.min} characters; recorded permanently.`} />
          {action.kind === 'approve' && action.e.proposedByMe ? <CheckField label="I proposed this record myself and confirm self-approval" hint="Normally a second person approves. Self-approval is recorded." checked={selfAck} onChange={setSelfAck} /> : null}
          {approveCheck && !approveCheck.ok && note.length > 0 ? <p className="mt-1 text-xs text-risk">{approveCheck.reason}</p> : null}
          <div className="mt-2 flex gap-2">
            <Btn kind={actionText.kind} busy={busy} disabled={action.kind === 'approve' ? !approveCheck?.ok : closeProblem !== null} onClick={() => void submitAction()}>{action.kind === 'approve' && action.original ? 'Approve revision' : actionText.submit}</Btn>
            <Btn kind="secondary" onClick={() => { fbAction.clear(); setAction(null); }}>Cancel</Btn>
          </div>
          </div>
        </Panel>
      ) : null}

      {timeline ? <EntitlementHistoryPanel key={`${timeline.id}-${historyTick}`} id={timeline.id} title={timeline.title} headingRef={historyHeading} onClose={() => setTimeline(null)} /> : null}

      {!proposeInline ? proposeForm : null}
    </div>
  );
}
