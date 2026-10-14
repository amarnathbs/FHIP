// Entitlement EDIT (migration 0280) - the pure decisions behind the Entitlements tab, the audit timeline and the view mapper.
// Admin Standard: capabilities touched are catalogue (edit a draft, propose or cancel a revision) and entitlementApprove (approve or
// reject a revision, revoke). None is new. Section 2: each capability decides only its own controls (matrix below). Section 9 and 13:
// the timeline names only "You" or a role and returns only whitelisted fields; the view mapper fails closed.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { BenchmarkCapabilityFlags, EntitlementRightsView } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { EntitlementEditBody, EntitlementReviseBody } from '@/lib/services/investment-intelligence/benchmarkData/routeSupport';
import { EDITABLE_FIELD_LABELS, buildTimeline, diffImages, lineageOf } from '@/lib/services/investment-intelligence/benchmarkData/entitlementHistory';
import { ENTITLEMENT_BASE_COLUMNS, ENTITLEMENT_EDIT_COLUMNS, mapEntitlementRow, readEntitlements } from '@/lib/services/investment-intelligence/benchmarkData/entitlementView';
import { entitlementPanelKeys, validateEntitlementForm } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';
import {
  buildEditBody,
  buildReviseBody,
  changeLine,
  changedFormFields,
  editActionsFor,
  entitlementFormFromRecord,
  formatChangeValue,
  isOpenRevision,
  lifecycleChip,
  lifecycleOf,
  reasonProblem,
  revisionComparison,
  splitEntitlements,
  timelineHeading,
} from '@/components/admin/benchmarkData/entitlementEditLogic';

const ROOT = path.resolve(__dirname, '..', '..');
const ME = 'user-me';
const OTHER = 'user-other-admin-0000';
const BENCH = { id: '11111111-1111-4111-8111-111111111111', returnVariant: 'total_return' as const, currencyCode: 'INR' };

const caps = (o: Partial<BenchmarkCapabilityFlags> = {}): BenchmarkCapabilityFlags => ({ view: true, upload: false, publish: false, correct: false, catalogue: false, entitlementApprove: false, ...o });

type EditPatch = Partial<NonNullable<EntitlementRightsView['edit']>>;
type RecOverrides = Omit<Partial<EntitlementRightsView>, 'edit'> & { edit?: EditPatch | null };
function rec(o: RecOverrides = {}): EntitlementRightsView {
  const { edit, ...rest } = o;
  return {
    entitlementId: 'aaaaaaaa-0000-4000-8000-000000000001',
    kind: 'commercial_licence',
    status: 'approved',
    rights: { ingestManual: true, automation: false, storage: true, calculation: true, customerDisplay: true, reportExport: false },
    dataFrom: null,
    dataTo: '2026-03-31',
    validFrom: '2026-01-05',
    validTo: null,
    postExpiryStorage: 'retain',
    evidenceReference: 'Licence 42',
    evidenceUrl: 'https://example.test/licence',
    proposedByMe: false,
    approvedAt: '2026-01-06T10:00:00Z',
    edit:
      edit === null
        ? undefined
        : {
            supersedesId: null, supersededById: null, supersededAt: null, revisionReason: null, editCount: 0, createdAt: '2026-01-05T09:00:00Z', endedAt: null, endedReason: null,
            postExpiryCalculation: true, postExpiryDisplay: false, evidenceDocumentDate: '2026-01-01', evidenceRetrievedAt: '2026-01-04', attributionText: null, notes: null, ...edit,
          },
    ...rest,
  };
}
const revisionOf = (orig: EntitlementRightsView, o: Omit<Partial<EntitlementRightsView>, 'edit'> = {}, edit: EditPatch = {}) =>
  rec({ entitlementId: 'bbbbbbbb-0000-4000-8000-000000000002', status: 'draft', approvedAt: null, ...o, edit: { supersedesId: orig.entitlementId, revisionReason: 'Correct the rights after re-reading', createdAt: '2026-02-01T09:00:00Z', ...edit } });

describe('lifecycle and the current list', () => {
  it('names every state, and a record without the edit columns falls back to its plain status', () => {
    const orig = rec();
    expect(lifecycleOf(orig)).toBe('approved');
    expect(lifecycleOf(rec({ status: 'draft' }))).toBe('draft');
    expect(lifecycleOf(revisionOf(orig))).toBe('revision_open');
    expect(lifecycleOf(rec({ status: 'revoked', edit: { supersededAt: '2026-02-02T00:00:00Z', supersededById: 'x' } }))).toBe('superseded');
    expect(lifecycleOf(revisionOf(orig, { status: 'revoked' }))).toBe('revision_closed');
    expect(lifecycleOf(rec({ status: 'revoked' }))).toBe('revoked');
    expect(lifecycleOf(rec({ edit: null }))).toBe('approved');
    expect(lifecycleOf(rec({ status: 'revoked', edit: null }))).toBe('revoked');
  });

  it('the list shows draft and approved records only; an open revision is a badge on its original; replaced and revoked records are history', () => {
    const orig = rec();
    const rev = revisionOf(orig);
    const draft = rec({ entitlementId: 'dddddddd-0000-4000-8000-000000000004', status: 'draft' });
    const old = rec({ entitlementId: 'eeeeeeee-0000-4000-8000-000000000005', status: 'revoked', edit: { supersededAt: '2026-01-30T00:00:00Z', supersededById: 'z', createdAt: '2025-12-01T00:00:00Z' } });
    const revoked = rec({ entitlementId: 'ffffffff-0000-4000-8000-000000000006', status: 'revoked', edit: { createdAt: '2025-11-01T00:00:00Z' } });
    const sp = splitEntitlements([old, rev, orig, draft, revoked]);
    expect(sp.current.map((e) => e.entitlementId).sort()).toEqual([draft.entitlementId, orig.entitlementId].sort());
    expect(sp.history.map((e) => e.entitlementId)).toEqual([old.entitlementId, revoked.entitlementId]);
    expect(sp.openRevisionOf.get(orig.entitlementId)?.entitlementId).toBe(rev.entitlementId);
    expect(sp.current.some((e) => isOpenRevision(e))).toBe(false);
  });

  it('chips: an open revision, a replaced record and a withdrawn revision have their own words; the others keep the existing ones', () => {
    const orig = rec();
    expect(lifecycleChip(revisionOf(orig)).label).toBe('Revision awaiting approval');
    expect(lifecycleChip(rec({ status: 'revoked', edit: { supersededAt: '2026-02-02T00:00:00Z', supersededById: 'x' } })).label).toBe('Replaced by a newer version');
    expect(lifecycleChip(revisionOf(orig, { status: 'revoked' })).label).toBe('Revision withdrawn');
    expect(lifecycleChip(orig)).toEqual({ label: 'Approved', tone: 'ok' });
    expect(lifecycleChip(rec({ status: 'revoked' })).label).toBe('Revoked');
  });
});

describe('which Edit controls each capability sees (the database enforces it again)', () => {
  const orig = rec();
  const myDraft = rec({ status: 'draft', proposedByMe: true });
  const otherDraft = rec({ status: 'draft', proposedByMe: false });
  const rev = (mine: boolean) => revisionOf(orig, { proposedByMe: mine });
  const none = { editDraft: false, reviseApproved: false, editRevision: false, cancelRevision: false, approveRevision: false, rejectRevision: false };
  const flags = (a: ReturnType<typeof editActionsFor>) => ({ editDraft: a.editDraft, reviseApproved: a.reviseApproved, editRevision: a.editRevision, cancelRevision: a.cancelRevision, approveRevision: a.approveRevision, rejectRevision: a.rejectRevision });

  it('a draft: only its proposer, and only with the catalogue capability, edits it in place', () => {
    expect(flags(editActionsFor(myDraft, undefined, caps({ catalogue: true }), true))).toEqual({ ...none, editDraft: true });
    expect(flags(editActionsFor(otherDraft, undefined, caps({ catalogue: true }), true))).toEqual(none);
    expect(editActionsFor(otherDraft, undefined, caps({ catalogue: true }), true).note).toMatch(/Only the person who proposed a draft/);
    for (const c of [caps(), caps({ entitlementApprove: true }), caps({ upload: true, publish: true, correct: true })]) expect(flags(editActionsFor(myDraft, undefined, c, true))).toEqual(none);
  });

  it('an approved record without a revision: "Edit (needs approval)" for the catalogue capability only', () => {
    expect(flags(editActionsFor(orig, undefined, caps({ catalogue: true }), true))).toEqual({ ...none, reviseApproved: true });
    for (const c of [caps(), caps({ entitlementApprove: true }), caps({ publish: true })]) expect(flags(editActionsFor(orig, undefined, c, true))).toEqual(none);
  });

  it('an open revision: the proposer edits or cancels; an approver approves or rejects; nobody can start a second one', () => {
    expect(flags(editActionsFor(orig, rev(true), caps({ catalogue: true }), true))).toEqual({ ...none, editRevision: true, cancelRevision: true });
    expect(flags(editActionsFor(orig, rev(false), caps({ catalogue: true }), true))).toEqual(none);
    expect(flags(editActionsFor(orig, rev(false), caps({ entitlementApprove: true }), true))).toEqual({ ...none, approveRevision: true, rejectRevision: true });
    expect(flags(editActionsFor(orig, rev(true), caps({ catalogue: true, entitlementApprove: true }), true))).toEqual({ editDraft: false, reviseApproved: false, editRevision: true, cancelRevision: true, approveRevision: true, rejectRevision: true });
    for (const c of [caps({ catalogue: true }), caps({ entitlementApprove: true }), caps({ catalogue: true, entitlementApprove: true })]) expect(editActionsFor(orig, rev(true), c, true).reviseApproved).toBe(false);
  });

  it('NEGATIVE CONTROL: before migration 0280 is applied (no edit columns) no Edit control is offered to anyone', () => {
    const all = caps({ catalogue: true, entitlementApprove: true });
    expect(flags(editActionsFor(rec({ edit: null }), undefined, all, true))).toEqual(none);
    expect(flags(editActionsFor(myDraft, undefined, all, false))).toEqual(none);
    expect(flags(editActionsFor(orig, undefined, all, false))).toEqual(none);
  });

  it('revoked, replaced and withdrawn records offer no edit', () => {
    const all = caps({ catalogue: true, entitlementApprove: true });
    expect(flags(editActionsFor(rec({ status: 'revoked' }), undefined, all, true))).toEqual(none);
    expect(flags(editActionsFor(rec({ status: 'revoked', edit: { supersededAt: '2026-02-02T00:00:00Z', supersededById: 'x' } }), undefined, all, true))).toEqual(none);
  });
});

describe('the Propose form reused for Edit', () => {
  it('pre-fills every field from the record with dates day-first, and a pre-filled form passes the same validation as a new proposal', () => {
    const e = rec({ edit: { attributionText: 'Source: the index owner', notes: 'Renewal 2026', evidenceDocumentDate: '2026-01-01', evidenceRetrievedAt: '2026-01-04' } });
    const f = entitlementFormFromRecord(e, 'IN_NIFTY_50_TRI');
    expect(f).toMatchObject({ benchmarkKey: 'IN_NIFTY_50_TRI', kind: 'commercial_licence', validFrom: '05-01-2026', validTo: '', dataFrom: '', dataTo: '31-03-2026', postExpiryStorage: 'retain', postExpiryCalculation: true, evidenceReference: 'Licence 42', evidenceDocumentDate: '01-01-2026', evidenceRetrievedAt: '04-01-2026', attributionText: 'Source: the index owner', notes: 'Renewal 2026' });
    expect(f.rights).toEqual(e.rights);
    expect(validateEntitlementForm(f, { returnVariant: 'total_return', currencyCode: 'INR' })).toEqual({});
    expect(JSON.stringify(f)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('detects exactly the fields that changed (and a save that changes nothing is flagged, as the database refuses it too)', () => {
    const f = entitlementFormFromRecord(rec(), 'K');
    expect(changedFormFields(f, f)).toEqual([]);
    expect(changedFormFields(f, { ...f, rights: { ...f.rights, reportExport: true }, validTo: '31-12-2027', notes: 'x' })).toEqual(['Right: Export', 'Valid to', 'Notes']);
    expect(changedFormFields(f, { ...f, validTo: '31-12-2027' })).toEqual(['Valid to']);
    expect(changedFormFields(f, { ...f, notes: '  ' })).toEqual([]);
  });

  it('builds a body the SERVER schema accepts: edit carries the counter, revise carries the reason, and neither loses a field', () => {
    const f = { ...entitlementFormFromRecord(rec({ edit: { notes: 'n' } }), 'K'), validTo: '31-12-2027' };
    const edit = buildEditBody(f, BENCH, 3, 'A better explanation of the change');
    const parsedEdit = EntitlementEditBody.safeParse(edit);
    expect(parsedEdit.success, JSON.stringify(parsedEdit)).toBe(true);
    expect(edit).toMatchObject({ expectedEditCount: 3, revision_reason: 'A better explanation of the change', valid_from: '2026-01-05', valid_to: '2027-12-31', data_to: '2026-03-31', notes: 'n', post_expiry_calculation: true });
    expect(buildEditBody(f, BENCH, 0)).not.toHaveProperty('revision_reason');
    const revise = buildReviseBody(f, BENCH, '  Correct the rights after re-reading  ');
    const parsedRevise = EntitlementReviseBody.safeParse(revise);
    expect(parsedRevise.success, JSON.stringify(parsedRevise)).toBe(true);
    expect(revise.reason).toBe('Correct the rights after re-reading');
  });

  it('the reason needs 10 characters', () => {
    expect(reasonProblem('short')).toMatch(/at least 10/);
    expect(reasonProblem('   a   ')).not.toBeNull();
    expect(reasonProblem('Correct the rights')).toBeNull();
  });

  it('each edit panel has its own key so pressing Edit on another record scrolls and focuses it; the old keys are unchanged', () => {
    expect(entitlementPanelKeys({}, null)).toEqual({ propose: 'propose', action: null });
    expect(entitlementPanelKeys({}, null, 'revise:abc').propose).toBe('edit:revise:abc');
    expect(entitlementPanelKeys({}, null, 'draft:abc').propose).not.toBe(entitlementPanelKeys({}, null, 'revise:abc').propose);
    expect(entitlementPanelKeys(null, { kind: 'reject-revision', e: { entitlementId: 'x' } })).toEqual({ propose: null, action: 'reject-revision:x' });
  });
});

describe('what the approver sees: only the fields a revision changes, day-first', () => {
  it('lists changed rows and nothing else', () => {
    const orig = rec();
    const rev = revisionOf(orig, { rights: { ...orig.rights, reportExport: true }, validTo: '2027-12-31', dataTo: null }, { notes: 'Renewal' });
    const rows = revisionComparison(orig, rev);
    expect(rows).toEqual([
      { label: 'Right: Report and export', current: 'No', proposed: 'Yes' },
      { label: 'Valid to', current: 'open', proposed: '31-12-2027' },
      { label: 'Last data date covered', current: '31-03-2026', proposed: 'any end' },
      { label: 'Notes', current: 'none', proposed: 'Renewal' },
    ]);
    expect(revisionComparison(orig, revisionOf(orig))).toEqual([]);
    expect(JSON.stringify(rows)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('audit timeline: a person is only You or a role; only whitelisted fields; day-first', () => {
  const ev = (event_type: string, over: Record<string, unknown> = {}) => ({ event_type, actor_user_id: OTHER, actor_kind: 'admin', before_state: null, after_state: null, reason: null, created_at: '2026-10-01T10:05:00Z', subject_id: 'rec-1', ...over });

  it('the caller is You, every other administrator is only the role their action belongs to (never an id)', () => {
    const t = buildTimeline(
      [ev('entitlement_proposed', { actor_user_id: ME }), ev('entitlement_approved', { created_at: '2026-10-02T10:00:00Z' }), ev('entitlement_revision_proposed', { created_at: '2026-10-03T10:00:00Z' }), ev('some_future_event', { created_at: '2026-10-04T10:00:00Z' })],
      { callerId: ME, recordId: 'rec-1', earlierIds: new Set() }
    );
    expect(t.map((e) => e.actor)).toEqual([{ kind: 'you', label: 'You' }, { kind: 'role', label: 'An entitlement approver' }, { kind: 'role', label: 'A catalogue administrator' }, { kind: 'role', label: 'An administrator' }]);
    expect(JSON.stringify(t)).not.toContain(OTHER);
    expect(t[3].summary).toBe('Recorded change');
    expect(t[3].changes).toEqual([]);
  });

  it('an edit shows the before and after of the changed fields only; a proposal, approval, revocation and supersede show no raw image', () => {
    const before = { notes: 'a', allow_report_export: false, valid_to: '2026-12-31', created_by: OTHER, hidden: 1 };
    const after = { notes: 'b', allow_report_export: true, valid_to: '2026-12-31', created_by: OTHER, hidden: 2 };
    const t = buildTimeline([ev('entitlement_draft_edited', { before_state: before, after_state: after, actor_user_id: ME })], { callerId: ME, recordId: 'rec-1', earlierIds: new Set() });
    expect(t[0].changes.map((c) => c.field)).toEqual(['allow_report_export', 'notes']);
    expect(JSON.stringify(t)).not.toMatch(/created_by|hidden|user-other/);
    for (const type of ['entitlement_proposed', 'entitlement_approved', 'entitlement_revoked', 'entitlement_superseded']) {
      const x = buildTimeline([ev(type, { before_state: before, after_state: after })], { callerId: ME, recordId: 'rec-1', earlierIds: new Set() });
      expect(x[0].changes, type).toEqual([]);
    }
    expect(diffImages(null, after)).toEqual([]);
    expect(diffImages(before, null)).toEqual([]);
  });

  it('marks a self-approved revision, orders oldest first, and says which version an entry is about', () => {
    const t = buildTimeline(
      [
        ev('entitlement_revision_approved', { subject_id: 'rev-2', after_state: { self_approved: true }, created_at: '2026-10-05T10:00:00Z' }),
        ev('entitlement_proposed', { subject_id: 'old-0', created_at: '2026-10-01T10:00:00Z' }),
        ev('entitlement_superseded', { subject_id: 'rec-1', created_at: '2026-10-05T10:00:01Z' }),
      ],
      { callerId: ME, recordId: 'rec-1', earlierIds: new Set(['old-0']) }
    );
    expect(t.map((e) => e.about)).toEqual(['earlier', 'later', 'this']);
    expect(t[1].summary).toMatch(/the proposer approved it/);
    expect(t[0].event).toBe('entitlement_proposed');
  });

  it('values are shown day-first and without identifiers', () => {
    expect(formatChangeValue('valid_to', '2027-12-31')).toBe('31-12-2027');
    expect(formatChangeValue('data_from', null)).toBe('none');
    expect(formatChangeValue('allow_storage', true)).toBe('Yes');
    expect(formatChangeValue('entitlement_kind', 'public_use_permission')).toBe('Public-use permission');
    expect(formatChangeValue('benchmark_id', '11111111-1111-4111-8111-111111111111')).toBe('a different benchmark');
    expect(changeLine({ field: 'valid_to', label: 'Valid to', before: '2026-12-31', after: null })).toBe('Valid to: 31-12-2026 to none');
    expect(timelineHeading({ at: '2026-10-08T14:05:00Z', event: 'x', summary: 'Revision proposed', actor: { kind: 'you', label: 'You' }, about: 'this', reason: null, changes: [] })).toBe('08-10-2026 14:05 UTC. You. Revision proposed');
    expect(Object.keys(EDITABLE_FIELD_LABELS)).toContain('revision_reason');
  });

  it('lineage: finds the earlier versions, the revisions and the successors of a record, and no other benchmark record', () => {
    const rows = [
      { id: 'a', supersedes_entitlement_id: null, superseded_by: 'b' },
      { id: 'b', supersedes_entitlement_id: 'a', superseded_by: 'c' },
      { id: 'c', supersedes_entitlement_id: 'b', superseded_by: null },
      { id: 'd', supersedes_entitlement_id: 'c', superseded_by: null },
      { id: 'z', supersedes_entitlement_id: null, superseded_by: null },
    ];
    const l = lineageOf(rows, 'c');
    expect([...l.ids].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...l.earlier].sort()).toEqual(['a', 'b']);
    expect(lineageOf(rows, 'z').ids).toEqual(['z']);
  });
});

describe('view mapper and the deploy-before-SQL safety net', () => {
  const dbRow = { id: 'r1', benchmark_id: 'b1', entitlement_kind: 'commercial_licence', status: 'approved', allow_manual_ingest: true, allow_automation: false, allow_storage: true, allow_calculation: true, allow_customer_display: false, allow_report_export: false, data_from: null, data_to: null, valid_from: '2026-01-05', valid_to: null, post_expiry_storage: 'retain', evidence_reference: 'Licence 42', evidence_url: null, created_by: ME, approved_at: null, supersedes_entitlement_id: null, superseded_by: 'r2', superseded_at: '2026-02-01T00:00:00Z', revision_reason: null, edit_count: 2, created_at: '2026-01-05T00:00:00Z', revoked_at: '2026-02-01T00:00:00Z', revoked_reason: 'Superseded by an approved revision', post_expiry_calculation: true, post_expiry_display: false, evidence_document_date: null, evidence_retrieved_at: null, attribution_text: null, notes: null };

  it('maps a row, flags the caller as proposer only, and never exposes created_by', () => {
    const v = mapEntitlementRow(dbRow, ME, true);
    expect(v.proposedByMe).toBe(true);
    expect(mapEntitlementRow(dbRow, 'someone-else', true).proposedByMe).toBe(false);
    expect(v.edit).toMatchObject({ supersededById: 'r2', editCount: 2, endedReason: 'Superseded by an approved revision' });
    expect(JSON.stringify(v)).not.toContain('created_by');
    expect(mapEntitlementRow(dbRow, ME, false).edit).toBeUndefined();
  });

  it('reads the 0280 columns first and, when only those are missing, repeats the read with the 0241 columns and reports edit as unsupported', async () => {
    const seen: string[] = [];
    const out = await readEntitlements(async (cols) => {
      seen.push(cols);
      return cols.includes('edit_count') ? { data: null, error: { code: '42703', message: 'column ii_benchmark_entitlements.edit_count does not exist' } } : { data: [{ id: 'r1' }], error: null };
    });
    expect(out.editSupported).toBe(false);
    expect(out.data).toEqual([{ id: 'r1' }]);
    expect(seen).toEqual([`${ENTITLEMENT_BASE_COLUMNS}, ${ENTITLEMENT_EDIT_COLUMNS}`, ENTITLEMENT_BASE_COLUMNS]);
  });

  it('any other error is returned as an error (never an empty success), and success reports edit as supported', async () => {
    const bad = await readEntitlements(async () => ({ data: null, error: { code: '57P01', message: 'terminating connection' } }));
    expect(bad.error?.code).toBe('57P01');
    expect(bad.editSupported).toBe(false);
    const good = await readEntitlements(async () => ({ data: [], error: null }));
    expect(good.editSupported).toBe(true);
  });
});

describe('wiring: the tab uses the edit logic, keeps its capability gates, and routes only through the logic module paths', () => {
  const tab = fs.readFileSync(path.join(ROOT, 'components', 'admin', 'benchmarkData', 'EntitlementsTab.tsx'), 'utf8');
  it('shows Edit controls only when the overview says edit is supported, and offers the history toggle only then', () => {
    expect(tab).toContain('ov.entitlementEdit === true');
    expect(tab).toContain('Edit (needs approval)');
    expect(tab).toContain('Show history');
    expect(tab).toContain('editActionsFor(e, revision, caps, editSupported)');
    expect(tab).toContain('apiPaths.entitlementRevise(');
    expect(tab).toContain('apiPaths.entitlementEdit(');
    expect(tab).toContain('apiPaths.entitlementRejectRevision(');
    expect(tab).toContain('apiPaths.entitlementCancelRevision(');
    expect(tab).not.toMatch(/\/api\//);
  });
  it('sends the edit counter the approver saw, and the buttons for different records have different accessible names', () => {
    expect(tab).toContain('expectedEditCount: action.e.edit?.editCount');
    expect(tab).toContain('ariaLabel={`Edit (needs approval), record ${short}`}');
    // label in name (WCAG 2.5.3): every spoken name starts with or contains the visible text of its button
    for (const [visible, spoken] of [['Edit', 'Edit, record'], ['Edit revision', 'Edit revision of record'], ['Review revision', 'Review revision of record'], ['Reject revision', 'Reject revision of record'], ['Cancel revision', 'Cancel revision of record'], ['History', 'History of record']]) {
      expect(spoken.startsWith(visible) || spoken.includes(visible), `${visible}`).toBe(true);
      expect(tab, spoken).toContain(spoken);
    }
    expect(tab).toContain('ariaLabel={`History of record ${short}`}');
  });
  it('NEGATIVE CONTROL: with the capability matrix removed the Edit controls would appear for everyone (the logic test above names the rule that prevents it)', () => {
    const everyone = caps({ view: true });
    expect(editActionsFor(rec(), undefined, everyone, true).reviseApproved).toBe(false);
  });
});
