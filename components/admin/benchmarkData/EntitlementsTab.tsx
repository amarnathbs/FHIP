'use client';

// Entitlements: what FHIP may DO with each benchmark, right by right. A licence
// status label on a benchmark grants nothing; only an approved record does.
import { useEffect, useRef, useState } from 'react';
import type { EntitlementRightsView, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { usePost, type Say } from './api';
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
  entitlementStatusChip,
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
import { Btn, CheckField, Chip, EmptyState, Notice, Panel, ScrollTable, SelectField, Td, DateField, TextAreaField, TextField, Th } from './ui';

type Action = { kind: 'approve' | 'revoke'; e: EntitlementRightsView; label: string };

export default function EntitlementsTab({ ov, onChanged, say }: { ov: OverviewResponse; onChanged: () => void; say: Say }) {
  const caps = ov.capabilities;
  const dec = capabilityDecisions(caps);
  const { busy, post } = usePost(say);
  const [form, setForm] = useState<EntitlementFormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [action, setAction] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  const [selfAck, setSelfAck] = useState(false);
  const set = (p: Partial<EntitlementFormState>) => setForm((f) => (f ? { ...f, ...p } : f));
  const groups = ov.rows.filter((r) => r.entitlements.length > 0);

  // An opened panel is scrolled into view and its heading focused (keyboard + screen-reader users), never silently
  // appended far below the control. Reduced-motion users get an instant jump.
  const proposeHeading = useRef<HTMLHeadingElement>(null);
  const actionHeading = useRef<HTMLHeadingElement>(null);
  const [pressTick, setPressTick] = useState(0);
  const lastPress = useRef(0);
  const keys = entitlementPanelKeys(form, action);
  const prevKeys = useRef<{ propose: OpenPanelKey; action: OpenPanelKey }>({ propose: null, action: null });
  useEffect(() => {
    const reveal = (el: HTMLHeadingElement | null) => {
      if (!el) return;
      const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      el.scrollIntoView({ block: 'start', behavior: revealScrollBehavior(reduced) });
      el.focus({ preventScroll: true });
    };
    const pressed = pressTick !== lastPress.current;
    lastPress.current = pressTick;
    if (shouldRevealPanel(prevKeys.current.propose, keys.propose, pressed && keys.propose !== null)) reveal(proposeHeading.current);
    else if (shouldRevealPanel(prevKeys.current.action, keys.action, pressed && keys.action !== null)) reveal(actionHeading.current);
    prevKeys.current = keys;
  }, [keys.propose, keys.action, pressTick]); // eslint-disable-line react-hooks/exhaustive-deps -- keys is derived from these two strings

  async function propose() {
    if (!form) return;
    const e = validateEntitlementForm(form);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const row = ov.rows.find((r) => r.catalogue.benchmarkKey === form.benchmarkKey);
    if (!row) return;
    const r = await post(apiPaths.entitlements(), buildEntitlementBody(form, row.catalogue), 'Proposed. It grants nothing until a user who can approve entitlements approves it.', 'propose this entitlement');
    if (r.ok) {
      setForm(null);
      onChanged();
    }
  }

  async function submitAction() {
    if (!action) return;
    const ok =
      action.kind === 'approve'
        ? await post(apiPaths.entitlementApprove(action.e.entitlementId), { note: note.trim(), selfApprovalAck: action.e.proposedByMe ? selfAck : undefined }, 'The entitlement is approved.', 'approve this entitlement')
        : await post(apiPaths.entitlementRevoke(action.e.entitlementId), { reason: note.trim() }, 'The entitlement is revoked. Publications that depend on it will now be refused.', 'revoke this entitlement');
    if (ok.ok) {
      setAction(null);
      setNote('');
      setSelfAck(false);
      onChanged();
    }
  }

  const approveCheck = action?.kind === 'approve' ? canApproveEntitlementNow({ note, proposedByMe: action.e.proposedByMe, selfApprovalAck: selfAck }) : null;
  const revokeProblem = action?.kind === 'revoke' ? noteProblem(note, MIN_NOTE, 'The revocation reason') : null;

  // With no records yet the form opens directly beneath the Propose button's panel header (not far below it).
  const proposeInline = groups.length === 0;
  const proposeForm = form && dec.canProposeEntitlement ? (
        <Panel headingRef={proposeHeading} title="Propose an entitlement" description="A proposal grants nothing until a user with the approval permission approves it.">
          <div className="grid gap-3 sm:grid-cols-2">
            <SelectField label="Benchmark" required value={form.benchmarkKey} onChange={(v) => set({ benchmarkKey: v })} options={ov.rows.map((r) => ({ value: r.catalogue.benchmarkKey, label: `${r.catalogue.label} (${r.catalogue.currencyCode ?? 'no currency'})` }))} error={errors.benchmarkKey} />
            <SelectField label="Kind of permission" required value={form.kind} onChange={(v) => set({ kind: v as EntitlementFormState['kind'] })} options={[{ value: 'public_use_permission', label: 'Public-use permission (published terms)' }, { value: 'commercial_licence', label: 'Commercial licence' }]} error={errors.kind} />
          </div>
          <fieldset className="mt-3 rounded-compact border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink">Rights granted</legend>
            {ENTITLEMENT_RIGHT_INFO.map((r) => <CheckField key={r.key} label={r.label} hint={r.meaning} checked={form.rights[r.key]} onChange={(v) => set({ rights: { ...form.rights, [r.key]: v } })} />)}
            {errors.rights ? <p role="alert" className="text-xs font-medium text-risk">{errors.rights}</p> : null}
          </fieldset>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <DateField label="Valid from" required value={form.validFrom} onChange={(v) => set({ validFrom: v })} error={errors.validFrom} />
            <DateField label="Valid to (empty if no end)" value={form.validTo} onChange={(v) => set({ validTo: v })} error={errors.validTo} />
            <DateField label="First data date covered (optional)" value={form.dataFrom} onChange={(v) => set({ dataFrom: v })} error={errors.dataFrom} />
            <DateField label="Last data date covered (optional)" value={form.dataTo} onChange={(v) => set({ dataTo: v })} error={errors.dataTo} />
            <SelectField label="Stored data after expiry" value={form.postExpiryStorage} onChange={(v) => set({ postExpiryStorage: v as EntitlementFormState['postExpiryStorage'] })} options={[{ value: 'retain', label: 'May be kept' }, { value: 'delete', label: 'Must be deleted' }, { value: 'unknown', label: 'Not stated' }]} placeholder="Not stated" />
            <TextField label="Evidence reference" required value={form.evidenceReference} onChange={(v) => set({ evidenceReference: v })} error={errors.evidenceReference} hint="Document title or contract reference." />
            <TextField label={`Evidence URL${form.kind === 'public_use_permission' ? '' : ' (optional)'}`} type="url" required={form.kind === 'public_use_permission'} value={form.evidenceUrl} onChange={(v) => set({ evidenceUrl: v })} error={errors.evidenceUrl} />
            <DateField label={`Evidence document date${form.kind === 'public_use_permission' ? '' : ' (optional)'}`} required={form.kind === 'public_use_permission'} value={form.evidenceDocumentDate} onChange={(v) => set({ evidenceDocumentDate: v })} error={errors.evidenceDocumentDate} />
            <DateField label={`Evidence retrieved on${form.kind === 'public_use_permission' ? '' : ' (optional)'}`} required={form.kind === 'public_use_permission'} value={form.evidenceRetrievedAt} onChange={(v) => set({ evidenceRetrievedAt: v })} error={errors.evidenceRetrievedAt} />
            <TextField label="Attribution wording (optional)" value={form.attributionText} onChange={(v) => set({ attributionText: v })} />
          </div>
          {form.kind === 'public_use_permission' ? <p className="mt-2 text-xs text-muted">A public-use permission must be backed by a document: its web address, its date and the date you retrieved it. A box saying you have permission is not enough.</p> : null}
          <div className="mt-3"><TextAreaField label="Notes (optional)" value={form.notes} onChange={(v) => set({ notes: v })} /></div>
          <div className="mt-3 flex gap-2"><Btn busy={busy} onClick={() => void propose()}>Propose</Btn><Btn kind="secondary" onClick={() => setForm(null)}>Cancel</Btn></div>
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

      <Panel title="Entitlement records" description="Grouped by benchmark. Only an approved record inside its term grants a right." actions={dec.canProposeEntitlement ? <Btn onClick={() => { setForm(emptyEntitlementForm()); setErrors({}); setPressTick((t) => t + 1); }}>Propose an entitlement</Btn> : undefined}>
        {!dec.canProposeEntitlement ? <Notice tone="info">{dec.why.catalogue} You can propose nothing here.</Notice> : null}
        {!dec.canApproveEntitlement ? <p className="mt-2 text-sm text-muted">{dec.why.entitlementApprove}</p> : null}
        {proposeInline && proposeForm ? <div className="mt-3">{proposeForm}</div> : null}
        {groups.length === 0 ? (
          <div className="mt-3"><EmptyState title="No entitlement has been recorded">Until a record is approved, no benchmark can be published, calculated or shown.</EmptyState></div>
        ) : (
          groups.map((g) => (
            <div key={g.catalogue.benchmarkKey} className="mt-3">
              <h3 className="mb-1 text-sm font-semibold text-ink">{g.catalogue.label} <span className="font-mono text-xs text-muted">{g.catalogue.benchmarkKey}</span></h3>
              <ScrollTable label={`Entitlements for ${g.catalogue.label}`} minWidth="min-w-[980px]">
                <thead>
                  <tr><Th>Status</Th><Th>Kind</Th>{ENTITLEMENT_RIGHT_INFO.map((r) => <Th key={r.key}>{r.short}</Th>)}<Th>Term</Th><Th>Data range</Th><Th>After expiry</Th><Th>Evidence</Th><Th>Actions</Th></tr>
                </thead>
                <tbody>
                  {g.entitlements.map((e) => {
                    const chip = entitlementStatusChip(e.status);
                    const acts = entitlementActions(e, caps);
                    const link = safeExternalUrl(e.evidenceUrl);
                    return (
                      <tr key={e.entitlementId}>
                        <Td><Chip label={chip.label} tone={chip.tone} /></Td>
                        <Td>{entitlementKindLabel(e.kind)}</Td>
                        {ENTITLEMENT_RIGHT_INFO.map((r) => <Td key={r.key}>{e.rights[r.key] ? 'Yes' : 'No'}</Td>)}
                        <Td>{formatDate(e.validFrom)} to {e.validTo ? formatDate(e.validTo) : 'open'}</Td>
                        <Td>{e.dataFrom ? formatDate(e.dataFrom) : 'any start'} to {e.dataTo ? formatDate(e.dataTo) : 'any end'}</Td>
                        <Td>{postExpiryLabel(e.postExpiryStorage)}</Td>
                        <Td>{e.evidenceReference}{link ? <> <a href={link} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust underline">Document (opens in a new tab)</a></> : null}</Td>
                        <Td>
                          <div className="flex flex-wrap gap-1">
                            {acts.canApprove ? <Btn kind="secondary" onClick={() => { setAction({ kind: 'approve', e, label: g.catalogue.label }); setNote(''); setSelfAck(false); setPressTick((t) => t + 1); }}>{`Approve ${e.entitlementId.slice(0, 6)}`}</Btn> : null}
                            {acts.canRevoke ? <Btn kind="danger" onClick={() => { setAction({ kind: 'revoke', e, label: g.catalogue.label }); setNote(''); setPressTick((t) => t + 1); }}>{`Revoke ${e.entitlementId.slice(0, 6)}`}</Btn> : null}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </ScrollTable>
            </div>
          ))
        )}
      </Panel>

      {action && dec.canApproveEntitlement ? (
        <Panel headingRef={actionHeading} title={`${action.kind === 'approve' ? 'Approve' : 'Revoke'} an entitlement for ${action.label}`}>
          <TextAreaField label={action.kind === 'approve' ? 'Approval note' : 'Reason for revoking'} required value={note} onChange={setNote} hint={`At least ${action.kind === 'approve' ? 5 : MIN_NOTE} characters; recorded permanently.`} />
          {action.kind === 'approve' && action.e.proposedByMe ? <CheckField label="I proposed this record myself and confirm self-approval" hint="Normally a second person approves. Self-approval is recorded." checked={selfAck} onChange={setSelfAck} /> : null}
          {approveCheck && !approveCheck.ok && note.length > 0 ? <p className="mt-1 text-xs text-risk">{approveCheck.reason}</p> : null}
          <div className="mt-2 flex gap-2">
            <Btn kind={action.kind === 'revoke' ? 'danger' : 'primary'} busy={busy} disabled={action.kind === 'approve' ? !approveCheck?.ok : revokeProblem !== null} onClick={() => void submitAction()}>{action.kind === 'approve' ? 'Approve' : 'Revoke'}</Btn>
            <Btn kind="secondary" onClick={() => setAction(null)}>Cancel</Btn>
          </div>
        </Panel>
      ) : null}

      {!proposeInline ? proposeForm : null}
    </div>
  );
}
