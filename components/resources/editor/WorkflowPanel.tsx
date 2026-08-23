'use client';

// R1.3 workflow action UI — spec §65-76, §109-111.
//
// Every action calls POST /api/admin/resources/content/[id]/workflow, which
// wraps public.transition_resource_post_status (spec §65: "never bypass the
// RPC"). Button visibility here is role-aware UX only, not the security
// boundary (mirrors the R1.2 nav-hiding convention, spec §90) — the RPC
// performs its own independent permission check every time regardless of
// which buttons this component decided to show.
//
// Schedule is deliberately NOT implemented (spec §70): R1.1/R1.2 grant no
// authenticated write path for `scheduled_at` at all (checked during the
// pre-implementation audit — it is absent from both the transition RPC's
// parameters and the column-scoped UPDATE grant in migration 0033), and no
// scheduled-publishing worker exists. Rather than add a third migration to
// open that column for a feature with no automation behind it yet (spec
// §70's own explicit allowance: "If this creates user confusion, defer
// Schedule action until the worker exists"), this build offers Publish Now
// only, which works cleanly today (the RPC sets published_at itself). This
// decision is documented in the R1.3 completion report.

import { useState } from 'react';
import { ResourceStatusBadge, ResourceComplianceBadge } from '@/components/resources/admin/ResourceBadges';
import { formatAdminDateTime, STATUS_LABELS } from '@/lib/resources/admin/labels';
import type { ResourceStatus, ComplianceClassification } from '@/lib/resources/types';
import type { WorkflowHistoryEntry } from '@/lib/resources/admin/queries';

export interface WorkflowCapabilities {
  isCreator: boolean;
  canEditorial: boolean; // editor / resource_admin / super_admin
  canCompliance: boolean; // compliance_reviewer / resource_admin / super_admin
  canPublish: boolean; // publisher / resource_admin / super_admin
  canManage: boolean; // resource_admin / super_admin
}

interface Action {
  key: string;
  label: string;
  toStatus: ResourceStatus;
  needsReason?: boolean;
  destructive?: boolean;
}

function availableActions(status: ResourceStatus, compliance: ComplianceClassification, caps: WorkflowCapabilities): Action[] {
  const actions: Action[] = [];
  const canSubmit = caps.isCreator || caps.canEditorial;

  if ((status === 'idea' || status === 'draft') && canSubmit) {
    actions.push({ key: 'submit', label: 'Submit for Editorial Review', toStatus: 'editorial_review' });
  }
  if (status === 'editorial_review' && caps.canEditorial) {
    if (compliance === 'amber') {
      actions.push({ key: 'to-compliance', label: 'Send to Compliance Review', toStatus: 'compliance_review' });
    } else if (compliance === 'green') {
      actions.push({ key: 'approve-editorial', label: 'Approve Editorially', toStatus: 'approved' });
    }
    // RED never gets a forward action here — display-only warning below.
    actions.push({ key: 'back-to-draft', label: 'Send Back to Draft', toStatus: 'draft', needsReason: true, destructive: true });
  }
  if (status === 'compliance_review' && caps.canCompliance) {
    actions.push({ key: 'approve-compliance', label: 'Approve Compliance Review', toStatus: 'approved' });
    actions.push({ key: 'back-to-draft-compliance', label: 'Send Back to Draft', toStatus: 'draft', needsReason: true, destructive: true });
  }
  if (status === 'approved' && caps.canPublish && compliance !== 'red') {
    actions.push({ key: 'publish', label: 'Publish Now', toStatus: 'published' });
  }
  if (status !== 'archived' && (caps.canPublish || caps.canManage)) {
    actions.push({ key: 'archive', label: 'Archive', toStatus: 'archived', needsReason: true, destructive: true });
  }
  return actions;
}

export function WorkflowPanel({
  status,
  compliance,
  caps,
  history,
  hasUnsavedChanges,
  onTransition,
}: {
  status: ResourceStatus;
  compliance: ComplianceClassification;
  caps: WorkflowCapabilities;
  history: WorkflowHistoryEntry[];
  hasUnsavedChanges: boolean;
  onTransition: (toStatus: ResourceStatus, reason?: string, notes?: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [pending, setPending] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const actions = availableActions(status, compliance, caps);

  async function run(action: Action, reasonText?: string) {
    setBusy(true);
    setError(null);
    const res = await onTransition(action.toStatus, reasonText || undefined);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'This workflow action could not be completed.');
      return;
    }
    setPending(null);
    setReason('');
  }

  return (
    <div className="rounded-card border border-line bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ResourceStatusBadge status={status} />
        <ResourceComplianceBadge compliance={compliance} />
      </div>

      {compliance === 'red' && (
        <p role="alert" className="mb-3 rounded-compact border border-risk/30 bg-risk/5 p-2 text-xs text-risk">
          RED content cannot be scheduled or published under the current Resources workflow.
        </p>
      )}
      {compliance === 'amber' && status !== 'published' && status !== 'approved' && (
        <p className="mb-3 rounded-compact border border-attention/30 bg-attention/5 p-2 text-xs text-attention">AMBER content requires compliance approval before it can be published.</p>
      )}

      {hasUnsavedChanges && <p className="mb-3 text-xs text-muted">Save your changes before performing a workflow action, so the reviewer sees your latest edits.</p>}

      {error && (
        <p role="alert" className="mb-3 rounded-compact border border-risk/30 bg-risk/5 p-2 text-xs text-risk">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {actions.length === 0 && <p className="text-sm text-muted">No workflow actions are available to you for this content right now.</p>}
        {actions.map((a) => (
          <button
            key={a.key}
            type="button"
            disabled={busy || hasUnsavedChanges}
            onClick={() => (a.needsReason ? setPending(a) : run(a))}
            className={`rounded-full border px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${
              a.destructive ? 'border-risk text-risk hover:bg-risk/5' : 'border-trust text-trust hover:bg-trust/5'
            }`}
          >
            {a.label}
          </button>
        ))}
      </div>

      <p className="mt-3 text-xs text-muted">Scheduled publication automation is not yet enabled — Publish Now takes effect immediately; there is no separate Schedule action in this release.</p>

      {pending && (
        <div className="mt-3 rounded-compact border border-line bg-gray-50 p-3">
          <label htmlFor="workflow-reason" className="block text-sm font-medium text-ink">
            Reason (optional)
          </label>
          <textarea id="workflow-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1 block w-full rounded-compact border border-line px-3 py-2 text-sm" />
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={busy} onClick={() => run(pending, reason)} className="rounded-full bg-risk px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
              Confirm {pending.label}
            </button>
            <button type="button" onClick={() => setPending(null)} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink">
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 border-t border-line pt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Workflow History</p>
        {history.length === 0 ? (
          <p className="text-sm text-muted">No workflow transitions recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {history.map((entry) => (
              <li key={entry.id} className="border-l-2 border-line pl-3 text-sm">
                <p className="font-medium text-ink">{STATUS_LABELS[entry.to_status as keyof typeof STATUS_LABELS] ?? entry.to_status}</p>
                <p className="text-xs text-muted">
                  {formatAdminDateTime(entry.created_at)} · by {entry.actor_role ?? 'unknown role'}
                </p>
                {entry.reason && <p className="mt-0.5 text-xs text-muted">Reason: {entry.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
