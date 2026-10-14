// Market Index Data - the audit timeline of one entitlement record (pure; the route only loads the rows).
//
// Source: the append-only ii_benchmark_governance_events log. Privacy rules (Admin Architecture Standard sections 9 and 13):
//   * the actor is only ever "You" (the caller) or a ROLE named by what the event is ("A catalogue administrator",
//     "An entitlement approver"), never another administrator's identity or user id;
//   * only the whitelisted editable fields are ever returned in a before and after comparison. The raw before and after
//     images of older events (which can hold user ids) are never copied to the response;
//   * an unknown event type is shown as a generic "Recorded change" with no comparison, never dropped and never guessed at.
import type { EntitlementTimelineEntry } from './apiTypes';

/** The fields an administrator can edit, with the label the screen shows. Mirrors ii_bm_entitlement_editable() of migration 0280. */
export const EDITABLE_FIELD_LABELS: Readonly<Record<string, string>> = {
  benchmark_id: 'Benchmark',
  source_id: 'Source',
  entitlement_kind: 'Kind of permission',
  allow_manual_ingest: 'Right: manual ingestion',
  allow_automation: 'Right: automated ingestion',
  allow_storage: 'Right: storage',
  allow_calculation: 'Right: calculation',
  allow_customer_display: 'Right: customer display',
  allow_report_export: 'Right: report and export',
  data_from: 'First data date covered',
  data_to: 'Last data date covered',
  valid_from: 'Valid from',
  valid_to: 'Valid to',
  post_expiry_storage: 'Stored data after expiry',
  post_expiry_calculation: 'Calculation after expiry',
  post_expiry_display: 'Display after expiry',
  evidence_reference: 'Evidence reference',
  evidence_url: 'Evidence URL',
  evidence_document_date: 'Evidence document date',
  evidence_retrieved_at: 'Evidence retrieved on',
  attribution_text: 'Attribution wording',
  notes: 'Notes',
  revision_reason: 'Reason for the revision',
};

type Role = 'catalogue' | 'approver';

const EVENT_INFO: Readonly<Record<string, { summary: string; role: Role }>> = {
  entitlement_proposed: { summary: 'Proposed', role: 'catalogue' },
  entitlement_draft_edited: { summary: 'Draft edited', role: 'catalogue' },
  entitlement_approved: { summary: 'Approved', role: 'approver' },
  entitlement_revoked: { summary: 'Revoked', role: 'approver' },
  entitlement_revision_proposed: { summary: 'Revision proposed', role: 'catalogue' },
  entitlement_revision_edited: { summary: 'Revision edited', role: 'catalogue' },
  entitlement_revision_approved: { summary: 'Revision approved. It replaced the earlier version.', role: 'approver' },
  entitlement_superseded: { summary: 'Replaced by an approved revision', role: 'approver' },
  entitlement_revision_cancelled: { summary: 'Revision cancelled by the person who proposed it', role: 'catalogue' },
  entitlement_revision_rejected: { summary: 'Revision rejected by an approver', role: 'approver' },
  entitlement_revision_closed: { summary: 'Revision closed because the record it would replace was revoked', role: 'approver' },
};

/** The only event types whose before and after images are comparable edit images (the others carry identity-bearing snapshots). */
const COMPARABLE = new Set(['entitlement_draft_edited', 'entitlement_revision_proposed', 'entitlement_revision_edited', 'entitlement_revision_approved']);

const ROLE_LABEL: Readonly<Record<Role, string>> = { catalogue: 'A catalogue administrator', approver: 'An entitlement approver' };

export interface GovernanceEventRow {
  event_type: string;
  actor_user_id: string | null;
  actor_kind: string | null;
  before_state: unknown;
  after_state: unknown;
  reason: string | null;
  created_at: string;
  subject_id: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Whitelisted before and after comparison. Returns nothing unless BOTH images are objects (a proposal has no before image). */
export function diffImages(before: unknown, after: unknown): EntitlementTimelineEntry['changes'] {
  if (!isObj(before) || !isObj(after)) return [];
  const out: EntitlementTimelineEntry['changes'] = [];
  for (const key of Object.keys(EDITABLE_FIELD_LABELS)) {
    if (!(key in before) && !(key in after)) continue;
    if (same(before[key], after[key])) continue;
    out.push({ field: key, label: EDITABLE_FIELD_LABELS[key], before: before[key] ?? null, after: after[key] ?? null });
  }
  return out;
}

/** The connected set of records (originals, revisions, successors) of one record, and which are earlier versions of it. */
export function lineageOf(
  rows: ReadonlyArray<{ id: string; supersedes_entitlement_id: string | null; superseded_by: string | null }>,
  id: string
): { ids: string[]; earlier: Set<string> } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const earlier = new Set<string>();
  let cur = byId.get(id)?.supersedes_entitlement_id ?? null;
  for (let hops = 0; cur && hops < 50; hops++) {
    earlier.add(cur);
    cur = byId.get(cur)?.supersedes_entitlement_id ?? null;
  }
  const seen = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      const linked = (r.supersedes_entitlement_id && seen.has(r.supersedes_entitlement_id)) || (r.superseded_by && seen.has(r.superseded_by)) || seen.has(r.id);
      if (!linked) continue;
      for (const x of [r.id, r.supersedes_entitlement_id, r.superseded_by]) {
        if (x && !seen.has(x)) {
          seen.add(x);
          grew = true;
        }
      }
    }
  }
  return { ids: [...seen], earlier };
}

export function buildTimeline(events: readonly GovernanceEventRow[], ctx: { callerId: string; recordId: string; earlierIds: ReadonlySet<string> }): EntitlementTimelineEntry[] {
  return [...events]
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
    .map((e): EntitlementTimelineEntry => {
      const info = EVENT_INFO[e.event_type];
      const about: EntitlementTimelineEntry['about'] = e.subject_id === ctx.recordId ? 'this' : e.subject_id && ctx.earlierIds.has(e.subject_id) ? 'earlier' : 'later';
      const byYou = e.actor_user_id !== null && e.actor_user_id === ctx.callerId;
      const actor: EntitlementTimelineEntry['actor'] = byYou
        ? { kind: 'you', label: 'You' }
        : { kind: 'role', label: info ? ROLE_LABEL[info.role] : e.actor_kind === 'admin' ? 'An administrator' : 'The system' };
      const selfApproved = isObj(e.after_state) && e.after_state.self_approved === true;
      const summary = info ? info.summary + (selfApproved && (e.event_type === 'entitlement_approved' || e.event_type === 'entitlement_revision_approved') ? ' (the proposer approved it, with the recorded acknowledgement)' : '') : 'Recorded change';
      const changes = COMPARABLE.has(e.event_type) ? diffImages(e.before_state, e.after_state) : [];
      return { at: e.created_at, event: e.event_type, summary, actor, about, reason: e.reason && e.reason.trim() !== '' ? e.reason : null, changes };
    });
}
