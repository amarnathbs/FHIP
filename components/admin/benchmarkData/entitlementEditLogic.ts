// Market Index Data - the Edit option for entitlement records: every decision as a PURE function (no React, no browser).
//
// The rules, in plain words (the database enforces every one again; hiding a button is never the control):
//   * A DRAFT is edited in place, only by the person who proposed it.
//   * An APPROVED record is never edited in place. "Edit (needs approval)" proposes ONE revision, with a reason.
//     The original keeps granting exactly as before until the revision is approved; then it is closed as superseded.
//   * The list shows current records only: drafts, approved records, and an open revision as a badge on its original.
//     "Show history" adds superseded and revoked records.
//   * A person is only ever "you" or a role on screen, never another administrator.
import type { BenchmarkCapabilityFlags, CatalogueRowView, EntitlementRightsView, EntitlementTimelineEntry } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { formatDateInput } from '@/lib/engines/dateInput';
import {
  ENTITLEMENT_RIGHT_INFO,
  buildEntitlementBody,
  entitlementKindLabel,
  entitlementStatusChip,
  formatDate,
  formatDateTime,
  noteProblem,
  postExpiryLabel,
  type EntitlementFormState,
  type Tone,
} from './benchmarkDataUiLogic';

export const REVISION_REASON_MIN = 10;

export type EntitlementLifecycle = 'draft' | 'approved' | 'revision_open' | 'superseded' | 'revision_closed' | 'revoked';

/** Where a record is in its life. Unknown or pre-0280 rows fall back to their plain status. */
export function lifecycleOf(e: EntitlementRightsView): EntitlementLifecycle {
  if (e.edit?.supersededAt) return 'superseded';
  if (e.status === 'draft') return e.edit?.supersedesId ? 'revision_open' : 'draft';
  if (e.status === 'approved') return 'approved';
  return e.edit?.supersedesId ? 'revision_closed' : 'revoked';
}

export const isOpenRevision = (e: EntitlementRightsView) => lifecycleOf(e) === 'revision_open';

export interface SplitEntitlements {
  /** Draft and approved records, newest first. An open revision is NOT listed: it is a badge on its original. */
  current: EntitlementRightsView[];
  /** Superseded, revoked and withdrawn-revision records. */
  history: EntitlementRightsView[];
  /** original id -> its open revision */
  openRevisionOf: ReadonlyMap<string, EntitlementRightsView>;
}

export function splitEntitlements(list: readonly EntitlementRightsView[]): SplitEntitlements {
  const openRevisionOf = new Map<string, EntitlementRightsView>();
  const current: EntitlementRightsView[] = [];
  const history: EntitlementRightsView[] = [];
  for (const e of list) {
    const l = lifecycleOf(e);
    if (l === 'revision_open') {
      if (e.edit?.supersedesId) openRevisionOf.set(e.edit.supersedesId, e);
    } else if (l === 'draft' || l === 'approved') current.push(e);
    else history.push(e);
  }
  const newest = (a: EntitlementRightsView, b: EntitlementRightsView) => (b.edit?.createdAt ?? '').localeCompare(a.edit?.createdAt ?? '');
  return { current: current.sort(newest), history: history.sort(newest), openRevisionOf };
}

/** Status chip for a record, including the states migration 0280 adds. */
export function lifecycleChip(e: EntitlementRightsView): { label: string; tone: Tone } {
  switch (lifecycleOf(e)) {
    case 'superseded':
      return { label: 'Replaced by a newer version', tone: 'neutral' };
    case 'revision_closed':
      return { label: 'Revision withdrawn', tone: 'neutral' };
    case 'revision_open':
      return { label: 'Revision awaiting approval', tone: 'warn' };
    default:
      return entitlementStatusChip(e.status);
  }
}

export interface EditActions {
  /** Draft: edit in place (the proposer only). */
  editDraft: boolean;
  /** Approved record without an open revision: "Edit (needs approval)". */
  reviseApproved: boolean;
  /** Open revision: the proposer edits it. */
  editRevision: boolean;
  /** Open revision: the proposer cancels it. */
  cancelRevision: boolean;
  /** Open revision: an approver reviews and approves it. */
  approveRevision: boolean;
  /** Open revision: an approver rejects it. */
  rejectRevision: boolean;
  /** Plain-language reason the edit controls are missing, empty when one is shown or nothing applies. */
  note: string;
}

export const NO_EDIT_ACTIONS: EditActions = { editDraft: false, reviseApproved: false, editRevision: false, cancelRevision: false, approveRevision: false, rejectRevision: false, note: '' };

/**
 * `e` is a current record; `revision` its open revision (if any). Needs the edit columns (migration 0280):
 * without them nothing is offered and the screen behaves exactly as before.
 */
export function editActionsFor(e: EntitlementRightsView, revision: EntitlementRightsView | undefined, caps: BenchmarkCapabilityFlags, editSupported: boolean): EditActions {
  if (!editSupported || !e.edit) return NO_EDIT_ACTIONS;
  const catalogue = caps.catalogue === true;
  const approver = caps.entitlementApprove === true;
  const l = lifecycleOf(e);
  if (l === 'draft') {
    const mine = e.proposedByMe === true;
    return { ...NO_EDIT_ACTIONS, editDraft: catalogue && mine, note: catalogue && !mine ? 'Only the person who proposed a draft can edit it.' : '' };
  }
  if (l !== 'approved') return NO_EDIT_ACTIONS;
  if (!revision) return { ...NO_EDIT_ACTIONS, reviseApproved: catalogue };
  const mine = revision.proposedByMe === true;
  return {
    ...NO_EDIT_ACTIONS,
    editRevision: catalogue && mine,
    cancelRevision: catalogue && mine,
    approveRevision: approver,
    rejectRevision: approver,
    note: catalogue && !mine && !approver ? 'A revision is open. Only the person who proposed it can edit or cancel it.' : '',
  };
}

// ------------------------------------------------------------------ the edit form ---

/** The Propose form pre-filled from an existing record (dates are shown day-first). */
export function entitlementFormFromRecord(e: EntitlementRightsView, benchmarkKey: string): EntitlementFormState {
  const x = e.edit;
  return {
    benchmarkKey,
    kind: e.kind,
    rights: { ...e.rights },
    validFrom: formatDateInput(e.validFrom),
    validTo: formatDateInput(e.validTo),
    dataFrom: formatDateInput(e.dataFrom),
    dataTo: formatDateInput(e.dataTo),
    postExpiryStorage: e.postExpiryStorage,
    postExpiryCalculation: x?.postExpiryCalculation ?? false,
    postExpiryDisplay: x?.postExpiryDisplay ?? false,
    evidenceReference: e.evidenceReference,
    evidenceUrl: e.evidenceUrl ?? '',
    evidenceDocumentDate: formatDateInput(x?.evidenceDocumentDate ?? null),
    evidenceRetrievedAt: formatDateInput(x?.evidenceRetrievedAt ?? null),
    attributionText: x?.attributionText ?? '',
    notes: x?.notes ?? '',
  };
}

/** Labels of the form fields whose value differs, in form order. A save that changes nothing is refused by the database too. */
export function changedFormFields(initial: EntitlementFormState, now: EntitlementFormState): string[] {
  const out: string[] = [];
  const add = (label: string, changed: boolean) => {
    if (changed) out.push(label);
  };
  const t = (v: string) => v.trim();
  add('Benchmark', initial.benchmarkKey !== now.benchmarkKey);
  add('Kind of permission', initial.kind !== now.kind);
  for (const r of ENTITLEMENT_RIGHT_INFO) add(`Right: ${r.short}`, initial.rights[r.key] !== now.rights[r.key]);
  add('Valid from', t(initial.validFrom) !== t(now.validFrom));
  add('Valid to', t(initial.validTo) !== t(now.validTo));
  add('First data date covered', t(initial.dataFrom) !== t(now.dataFrom));
  add('Last data date covered', t(initial.dataTo) !== t(now.dataTo));
  add('Stored data after expiry', initial.postExpiryStorage !== now.postExpiryStorage);
  add('Calculation after expiry', initial.postExpiryCalculation !== now.postExpiryCalculation);
  add('Display after expiry', initial.postExpiryDisplay !== now.postExpiryDisplay);
  add('Evidence reference', t(initial.evidenceReference) !== t(now.evidenceReference));
  add('Evidence URL', t(initial.evidenceUrl) !== t(now.evidenceUrl));
  add('Evidence document date', t(initial.evidenceDocumentDate) !== t(now.evidenceDocumentDate));
  add('Evidence retrieved on', t(initial.evidenceRetrievedAt) !== t(now.evidenceRetrievedAt));
  add('Attribution wording', t(initial.attributionText) !== t(now.attributionText));
  add('Notes', t(initial.notes) !== t(now.notes));
  return out;
}

export function reasonProblem(reason: string): string | null {
  return noteProblem(reason, REVISION_REASON_MIN, 'The reason for the change');
}

type RowForBody = Pick<CatalogueRowView, 'id' | 'returnVariant' | 'currencyCode'>;

/** Body for the edit route: the proposal body plus the edit counter the screen was loaded with. */
export function buildEditBody(f: EntitlementFormState, row: RowForBody, editCount: number, revisionReason?: string): Record<string, unknown> {
  return { ...buildEntitlementBody(f, row), expectedEditCount: editCount, ...(revisionReason !== undefined ? { revision_reason: revisionReason.trim() } : {}) };
}

/** Body for the revise route: the proposal body plus the reason. */
export function buildReviseBody(f: EntitlementFormState, row: RowForBody, reason: string): Record<string, unknown> {
  return { ...buildEntitlementBody(f, row), reason: reason.trim() };
}

export type EditMode = 'draft' | 'revise' | 'revision';

export function editPanelTitle(mode: EditMode, benchmarkLabel: string): string {
  switch (mode) {
    case 'draft':
      return `Edit a draft entitlement for ${benchmarkLabel}`;
    case 'revise':
      return `Edit an approved entitlement for ${benchmarkLabel} (needs approval)`;
    default:
      return `Edit the revision awaiting approval for ${benchmarkLabel}`;
  }
}

export function editPanelDescription(mode: EditMode): string {
  switch (mode) {
    case 'draft':
      return 'Changes are saved on this draft and recorded. It still grants nothing until a user with the approval permission approves it.';
    case 'revise':
      return 'This does not change the approved record. It creates one revision that waits for approval. The approved record keeps granting exactly as it does now until the revision is approved, then it is replaced and kept in the history.';
    default:
      return 'This revision grants nothing yet. The approved record it will replace keeps granting until a user with the approval permission approves this revision.';
  }
}

export function editSuccessMessage(mode: EditMode): string {
  switch (mode) {
    case 'draft':
      return 'Saved. It grants nothing until a user who can approve entitlements approves it.';
    case 'revise':
      return 'Revision proposed. The approved record stays in force and unchanged until the revision is approved.';
    default:
      return 'The revision was saved. It still waits for approval; the approved record is unchanged.';
  }
}

// ------------------------------------------------------------ approver comparison ---

const yn = (v: boolean) => (v ? 'Yes' : 'No');
const dateOrNone = (v: string | null) => (v ? formatDate(v) : 'none');

interface Shown {
  label: string;
  value: string;
}

function shown(e: EntitlementRightsView): Shown[] {
  const x = e.edit;
  return [
    { label: 'Kind of permission', value: entitlementKindLabel(e.kind) },
    ...ENTITLEMENT_RIGHT_INFO.map((r) => ({ label: `Right: ${r.label}`, value: yn(e.rights[r.key]) })),
    { label: 'Valid from', value: dateOrNone(e.validFrom) },
    { label: 'Valid to', value: e.validTo ? formatDate(e.validTo) : 'open' },
    { label: 'First data date covered', value: e.dataFrom ? formatDate(e.dataFrom) : 'any start' },
    { label: 'Last data date covered', value: e.dataTo ? formatDate(e.dataTo) : 'any end' },
    { label: 'Stored data after expiry', value: postExpiryLabel(e.postExpiryStorage) },
    { label: 'Calculation after expiry', value: yn(x?.postExpiryCalculation ?? false) },
    { label: 'Display after expiry', value: yn(x?.postExpiryDisplay ?? false) },
    { label: 'Evidence reference', value: e.evidenceReference },
    { label: 'Evidence URL', value: e.evidenceUrl ?? 'none' },
    { label: 'Evidence document date', value: dateOrNone(x?.evidenceDocumentDate ?? null) },
    { label: 'Evidence retrieved on', value: dateOrNone(x?.evidenceRetrievedAt ?? null) },
    { label: 'Attribution wording', value: x?.attributionText ?? 'none' },
    { label: 'Notes', value: x?.notes ?? 'none' },
  ];
}

/** What a revision changes compared with the approved record it replaces: only the rows that differ. */
export function revisionComparison(original: EntitlementRightsView, revision: EntitlementRightsView): Array<{ label: string; current: string; proposed: string }> {
  const a = shown(original);
  const b = shown(revision);
  const out: Array<{ label: string; current: string; proposed: string }> = [];
  for (let i = 0; i < a.length; i++) if (a[i].value !== b[i].value) out.push({ label: a[i].label, current: a[i].value, proposed: b[i].value });
  return out;
}

// ------------------------------------------------------------------- the history ---

const DATE_FIELDS = new Set(['data_from', 'data_to', 'valid_from', 'valid_to', 'evidence_document_date', 'evidence_retrieved_at']);

/** One value of a before or after comparison, as text (dates day-first, no raw identifiers). */
export function formatChangeValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'none';
  if (typeof v === 'boolean') return yn(v);
  if (DATE_FIELDS.has(field) && typeof v === 'string') return formatDate(v);
  if (field === 'entitlement_kind' && (v === 'public_use_permission' || v === 'commercial_licence')) return entitlementKindLabel(v);
  if (field === 'post_expiry_storage' && (v === 'retain' || v === 'delete' || v === 'unknown')) return postExpiryLabel(v);
  if (field === 'benchmark_id') return 'a different benchmark';
  if (field === 'source_id') return 'a recorded source';
  return String(v);
}

export function changeLine(c: EntitlementTimelineEntry['changes'][number]): string {
  return `${c.label}: ${formatChangeValue(c.field, c.before)} to ${formatChangeValue(c.field, c.after)}`;
}

/** The heading line of one timeline entry, e.g. "08-10-2026 14:05 UTC. You. Revision proposed". */
export function timelineHeading(e: EntitlementTimelineEntry): string {
  const where = e.about === 'earlier' ? ' (earlier version)' : e.about === 'later' ? ' (later version or revision)' : '';
  return `${formatDateTime(e.at)}. ${e.actor.label}. ${e.summary}${where}`;
}
