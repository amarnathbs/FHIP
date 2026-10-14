'use client';

// Planning Benchmarks Admin — the Super Admin surface for benchmark source and
// dataset governance.
//
// Admin A0.2 Wave 5 rebuilt this screen's feedback layer. Every change below
// is a defect this Wave's own inventory found; none changes what any action
// does, who may perform it, or what the server enforces:
//
//   §10  Activate, Approve and Reinstate had NO confirmation, while the
//        reversible Retire and Suspend did — the risk gradient was inverted.
//        Activating a dataset starts serving a benchmark figure to every
//        user, and approving a source unblocks every dataset citing it.
//        All five lifecycle actions now confirm, naming the object and the
//        effect (never a bare "Are you sure?").
//   §8   Native window.alert()/window.confirm() were the only feedback
//        mechanism, despite the app's own ConfirmDialog primitive existing
//        (and this file being the only place in the codebase still using
//        them). Replaced, so confirmation looks and behaves the same here
//        as everywhere else in Admin.
//   §9   Every failure collapsed into one string with the raw server
//        message forwarded verbatim; a 403 was indistinguishable from a
//        500. Failures are now classified, and no raw database text can
//        reach the screen.
//   §9   Activate/Retire/Approve/Suspend/Reinstate gave no success
//        confirmation at all — the only evidence was that a button label
//        changed. Each now announces its committed outcome.
//   §11  <th> carried no scope, the table had no accessible name, the empty
//        row's colSpan was wrong on the four tabs with no Actions column,
//        and no state change was announced.
//   §18  Raw snake_case database values (`under_review`, `data_status`) and
//        raw column names (`citation_text`, `rows_rejected`) were shown to
//        operators. Both are now mapped to human labels.
//   §19  The page's purpose sentence cited "spec sections 20 and 26" — an
//        internal engineering reference an operator cannot look up.

import { useEffect, useState, useCallback } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import {
  actionFailureMessage,
  failureFromResponse,
  failureFromThrown,
  readJsonSafely,
  type AdminFailure,
} from '@/lib/resources/admin/resultState';
import { cell, displayCell, fmt, type Row } from '@/components/admin/adminBenchmarksCells';
import { PlanningBenchmarkUpload } from '@/components/admin/PlanningBenchmarkUpload';
import { parseAdminCapabilities } from '@/lib/admin/adminNav';

type Tab = 'sources' | 'datasets' | 'cohorts' | 'values' | 'target-ranges' | 'update-runs' | 'upload';

const TABS: { key: Tab; label: string; purpose: string; subject: string; helpTaskId: string }[] = [
  {
    key: 'sources',
    label: 'Sources',
    purpose:
      'The published sources benchmark figures are cited from. A dataset can only be activated once the source it cites is approved.',
    subject: 'benchmark sources',
    helpTaskId: 'ADM-01',
  },
  {
    key: 'datasets',
    label: 'Datasets',
    purpose:
      'The benchmark figures themselves. Activating a dataset starts serving it to everyone; retiring one takes it out of service.',
    subject: 'benchmark datasets',
    helpTaskId: 'ADM-02',
  },
  {
    key: 'cohorts',
    label: 'Cohorts',
    purpose: 'The population groups benchmark figures are measured against. Read-only.',
    subject: 'benchmark cohorts',
    helpTaskId: 'ADM-03',
  },
  {
    key: 'values',
    label: 'Observed values',
    purpose: 'The individual measured figures recorded against each dataset. Read-only.',
    subject: 'observed benchmark values',
    helpTaskId: 'ADM-03',
  },
  {
    key: 'target-ranges',
    label: 'Planning target ranges',
    purpose: 'The planning bands the product compares a household against. Read-only.',
    subject: 'planning target ranges',
    helpTaskId: 'ADM-03',
  },
  {
    key: 'update-runs',
    label: 'Update / audit log',
    purpose:
      'Every benchmark lifecycle change that has been recorded, including activation attempts that were rejected. Read-only.',
    subject: 'the benchmark update and audit log',
    helpTaskId: 'ADM-03',
  },
  {
    key: 'upload',
    label: 'Upload',
    purpose:
      'Upload new benchmark figures from a template. A file is checked and staged first and nothing is live until an authorised administrator activates it. The figures they replace are kept as history.',
    subject: 'the benchmark upload area',
    helpTaskId: 'ADM-03',
  },
];

const TABS_WITH_ACTIONS: Tab[] = ['sources', 'datasets'];

type PendingAction =
  | { kind: 'activate'; id: string; name: string }
  | { kind: 'retire'; id: string; name: string }
  | { kind: 'approve'; id: string; name: string }
  | { kind: 'suspend'; id: string; name: string }
  | { kind: 'reinstate'; id: string; name: string };

const CONFIRM_COPY: Record<PendingAction['kind'], { title: string; message: (name: string) => string; confirmLabel: string; destructive: boolean }> = {
  activate: {
    title: 'Activate this dataset?',
    message: (name) =>
      `"${name}" will immediately start being served as an active benchmark to every FHIP user. Validate it first if you have not already.`,
    confirmLabel: 'Activate Dataset',
    destructive: false,
  },
  retire: {
    title: 'Retire this dataset?',
    message: (name) => `"${name}" will stop being served as an active benchmark. You can activate it again later, which re-validates it from scratch.`,
    confirmLabel: 'Retire Dataset',
    destructive: true,
  },
  approve: {
    title: 'Approve this source?',
    message: (name) =>
      `"${name}" becomes an approved citation source, and every dataset citing it becomes eligible for activation. There is no control that returns an approved source to draft.`,
    confirmLabel: 'Approve Source',
    destructive: false,
  },
  suspend: {
    title: 'Suspend this source?',
    message: (name) => `"${name}" will be suspended, and every dataset that depends on it will fail validation until it is reinstated.`,
    confirmLabel: 'Suspend Source',
    destructive: true,
  },
  reinstate: {
    title: 'Reinstate this source?',
    message: (name) => `"${name}" returns to approved, and datasets citing it can pass validation again.`,
    confirmLabel: 'Reinstate Source',
    destructive: false,
  },
};

export function AdminBenchmarksClient() {
  const [tab, setTab] = useState<Tab>('datasets');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [validation, setValidation] = useState<{ name: string; valid: boolean; errors: string[] } | null>(null);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();
  // The Upload tab is shown only to a caller holding one of the two upload capabilities. UX only: the page, the
  // API and the database each enforce the capability themselves (Admin Standard section 4).
  const [showUploadTab, setShowUploadTab] = useState(false);

  const activeTab = TABS.find((t) => t.key === tab)!;

  const load = useCallback(async (t: Tab) => {
    if (t === 'upload') {
      // The Upload tab loads its own data (see PlanningBenchmarkUpload); there is no list to fetch here.
      setRows(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailure(null);
    const subject = TABS.find((x) => x.key === t)?.subject ?? 'this data';
    try {
      const res = await fetch(`/api/admin/benchmarks/${t}`);
      const json = await readJsonSafely(res);
      if (!res.ok) {
        setFailure(failureFromResponse(res.status, json, subject));
        setRows(null);
        return;
      }
      setRows((json?.data as Row[]) ?? []);
    } catch (e) {
      setFailure(failureFromThrown(e, subject));
      // Clear stale rows: a populated table under an error banner reads as
      // if the data on screen is current, when it is not.
      setRows(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Deferred a tick, matching the convention the sibling Resources admin
    // screens already use (see ContextMappingManager and
    // RelatedContentManager, which adopted it for the same reason):
    // `load` begins executing its own setState calls before its first
    // `await`, which the react-hooks/set-state-in-effect rule flags as a
    // cascading-render risk even though the function is declared async.
    // Behaviour is unchanged — the fetch still starts immediately on mount
    // and on every tab change.
    const timer = setTimeout(() => void load(tab), 0);
    return () => clearTimeout(timer);
  }, [tab, load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/me');
        const caps = parseAdminCapabilities(await readJsonSafely(res));
        if (!cancelled) setShowUploadTab(res.ok && (caps.planningBenchmarkUpload || caps.planningBenchmarkActivate));
      } catch {
        if (!cancelled) setShowUploadTab(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runLifecycle(action: PendingAction) {
    setBusyId(action.id);
    clearOutcome();
    try {
      const res =
        action.kind === 'activate'
          ? await fetch(`/api/admin/benchmarks/datasets/${action.id}/activate`, { method: 'POST' })
          : action.kind === 'retire'
            ? await fetch(`/api/admin/benchmarks/datasets/${action.id}/retire`, { method: 'POST' })
            : await fetch(`/api/admin/benchmarks/sources/${action.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: action.kind === 'suspend' ? 'suspended' : 'approved' }),
              });

      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, LIFECYCLE_VERB[action.kind]));
        // Reload anyway so the table reflects committed server state rather
        // than what the operator expected to happen.
        await load(tab);
        return;
      }
      reportSuccess(LIFECYCLE_SUCCESS[action.kind](action.name));
      await load(tab);
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusyId(null);
    }
  }

  // Wave 3: completes the "import -> validate -> correct -> commit" task
  // graph. Activate already runs this same check server-side and records
  // an audited rejection on failure, so this button changes nothing about
  // what is allowed to activate — it lets an admin see why a dataset isn't
  // ready *before* triggering that audited attempt.
  async function validate(datasetId: string, name: string) {
    setBusyId(datasetId);
    clearOutcome();
    setValidation(null);
    try {
      const res = await fetch('/api/admin/benchmarks/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataset_id: datasetId }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'check whether this dataset is ready to activate'));
        return;
      }
      const result = json?.data as { valid: boolean; errors: string[] } | undefined;
      setValidation({ name, valid: !!result?.valid, errors: result?.errors ?? [] });
    } catch {
      reportFailure('Could not reach the server. Nothing was checked and nothing was changed.');
    } finally {
      setBusyId(null);
    }
  }

  const columns = columnsFor(tab);
  const showActions = TABS_WITH_ACTIONS.includes(tab);
  const columnCount = columns.length + (showActions ? 1 : 0);

  return (
    <div className="space-y-6">
      <ConfirmDialog
        open={!!pending}
        title={pending ? CONFIRM_COPY[pending.kind].title : ''}
        message={pending ? CONFIRM_COPY[pending.kind].message(pending.name) : ''}
        confirmLabel={pending ? CONFIRM_COPY[pending.kind].confirmLabel : 'Confirm'}
        cancelLabel="Cancel"
        destructive={pending ? CONFIRM_COPY[pending.kind].destructive : true}
        onConfirm={() => {
          const action = pending;
          setPending(null);
          if (action) void runLifecycle(action);
        }}
        onCancel={() => setPending(null)}
      />

      <div>
        <h1 className="text-2xl font-semibold text-ink">Planning Benchmarks</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Govern the benchmark figures FHIP compares households against. No benchmark is served until its source has been
          approved, its dataset has passed validation, and an administrator has activated it.
        </p>
      </div>

      {tab !== 'upload' && <AdminTaskHelp taskId={activeTab.helpTaskId} />}

      <div className="flex flex-wrap gap-2 border-b border-line">
        {TABS.filter((t) => t.key !== 'upload' || showUploadTab).map((t) => (
          <button
            key={t.key}
            type="button"
            aria-pressed={tab === t.key}
            onClick={() => {
              setTab(t.key);
              setValidation(null);
              clearOutcome();
            }}
            className={`min-h-11 rounded-t px-3 py-2 text-sm outline-offset-2 focus-visible:outline-2 focus-visible:outline-trust ${
              tab === t.key ? 'border-b-2 border-trust font-semibold text-trust' : 'text-muted hover:text-trust'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <p className="max-w-3xl text-sm text-muted">{activeTab.purpose}</p>

      <AdminActionStatus outcome={outcome} />

      {tab === 'upload' && <PlanningBenchmarkUpload />}

      {validation && (
        <div
          role="status"
          aria-live="polite"
          className={`rounded-card border p-4 text-sm ${validation.valid ? 'border-positive/30 bg-positive/5 text-ink' : 'border-attention/40 bg-attention/5 text-ink'}`}
        >
          <p className="font-semibold">
            {validation.valid ? `"${validation.name}" is ready to activate.` : `"${validation.name}" is not ready to activate.`}
          </p>
          {validation.valid ? (
            <p className="mt-1 text-muted">Nothing has been changed. Select Activate when you want it served.</p>
          ) : (
            <>
              <p className="mt-1 text-muted">Nothing has been changed. Fix each of these, then check again:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
                {validation.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )}
          <button
            type="button"
            onClick={() => setValidation(null)}
            className="mt-3 min-h-11 text-sm font-semibold text-trust hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {tab !== 'upload' && failure && (
        <div
          role={failure.retryable ? 'alert' : 'status'}
          className={`rounded-card border p-4 text-sm ${failure.retryable ? 'border-risk/40 bg-risk/5' : 'border-line bg-white'}`}
        >
          <p className={`font-semibold ${failure.retryable ? 'text-risk' : 'text-ink'}`}>{failure.title}</p>
          <p className="mt-1 text-muted">{failure.message}</p>
          {failure.retryable && (
            <button
              type="button"
              onClick={() => load(tab)}
              className="mt-3 min-h-11 rounded border border-risk/30 px-3 py-1.5 text-sm font-semibold text-risk hover:bg-risk/10"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {tab !== 'upload' && loading && (
        <p role="status" aria-live="polite" className="text-sm text-muted">
          Loading {activeTab.subject}…
        </p>
      )}

      {tab !== 'upload' && !loading && rows && (
        <>
          <p role="status" aria-live="polite" className="text-xs text-muted">
            {rows.length} {rows.length === 1 ? 'row' : 'rows'} shown.
          </p>
          {/* `relative` — the sr-only <caption> is position:absolute and
              would otherwise resolve against the document, extending the
              page's scroll width past the viewport. See
              ResourceContentTable for the full explanation. */}
          <div className="relative overflow-x-auto rounded-card border border-line bg-white">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">{activeTab.label} — {activeTab.purpose}</caption>
              <thead className="bg-gray-50 text-muted">
                <tr>
                  {columns.map((c) => (
                    <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">
                      {COLUMN_LABELS[c] ?? c}
                    </th>
                  ))}
                  {showActions && (
                    <th scope="col" className="px-3 py-2 font-medium">
                      Actions
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={columnCount} className="px-3 py-4 text-center text-muted">
                      No {activeTab.subject} recorded yet.
                    </td>
                  </tr>
                )}
                {rows.map((r, i) => (
                  <tr key={(r.id as string) ?? i} className="border-t border-line">
                    {columns.map((c) => (
                      <td key={c} className="max-w-xs truncate px-3 py-2" title={displayCell(r, c)}>
                        {displayCell(r, c)}
                      </td>
                    ))}
                    {tab === 'datasets' && (
                      <td className="whitespace-nowrap px-3 py-2">
                        <div className="flex min-h-11 items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => validate(r.id as string, fmt(cell(r, 'Dataset')))}
                            aria-label={`Check whether ${fmt(cell(r, 'Dataset'))} is ready to activate`}
                            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded border border-line px-2 py-1 text-xs hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                          >
                            Validate
                          </button>
                          {r.data_status === 'active' ? (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setPending({ kind: 'retire', id: r.id as string, name: fmt(cell(r, 'Dataset')) })}
                              aria-label={`Retire ${fmt(cell(r, 'Dataset'))}`}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                            >
                              Retire
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setPending({ kind: 'activate', id: r.id as string, name: fmt(cell(r, 'Dataset')) })}
                              aria-label={`Activate ${fmt(cell(r, 'Dataset'))}`}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-trust px-2 py-1 text-xs text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                            >
                              Activate
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                    {tab === 'sources' && (
                      <td className="whitespace-nowrap px-3 py-2">
                        <div className="flex min-h-11 items-center gap-1.5">
                          {(r.status === 'draft' || r.status === 'under_review') && (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setPending({ kind: 'approve', id: r.id as string, name: fmt(cell(r, 'Source')) })}
                              aria-label={`Approve ${fmt(cell(r, 'Source'))}`}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-trust px-2 py-1 text-xs text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                            >
                              Approve
                            </button>
                          )}
                          {(r.status === 'approved' || r.status === 'active') && (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setPending({ kind: 'suspend', id: r.id as string, name: fmt(cell(r, 'Source')) })}
                              aria-label={`Suspend ${fmt(cell(r, 'Source'))}`}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-gray-200 px-2 py-1 text-xs hover:bg-gray-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                            >
                              Suspend
                            </button>
                          )}
                          {r.status === 'suspended' && (
                            <button
                              type="button"
                              disabled={busyId === r.id}
                              onClick={() => setPending({ kind: 'reinstate', id: r.id as string, name: fmt(cell(r, 'Source')) })}
                              aria-label={`Reinstate ${fmt(cell(r, 'Source'))}`}
                              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded bg-trust px-2 py-1 text-xs text-white hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-trust disabled:opacity-50"
                            >
                              Reinstate
                            </button>
                          )}
                          {!['draft', 'under_review', 'approved', 'active', 'suspended'].includes(String(r.status)) && (
                            <span className="text-muted">No action available</span>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

const LIFECYCLE_VERB: Record<PendingAction['kind'], string> = {
  activate: 'activate this dataset',
  retire: 'retire this dataset',
  approve: 'approve this source',
  suspend: 'suspend this source',
  reinstate: 'reinstate this source',
};

const LIFECYCLE_SUCCESS: Record<PendingAction['kind'], (name: string) => string> = {
  activate: (n) => `"${n}" is now active and is being served as a benchmark. The change is recorded in the Update / audit log tab.`,
  retire: (n) => `"${n}" has been retired and is no longer served. The change is recorded in the Update / audit log tab.`,
  approve: (n) => `"${n}" is now approved. Datasets citing it can now pass validation.`,
  suspend: (n) => `"${n}" is now suspended. Datasets citing it will fail validation until it is reinstated.`,
  reinstate: (n) => `"${n}" has been reinstated and is approved again.`,
};

// §18 — the table previously used raw database column names as headings.
const COLUMN_LABELS: Record<string, string> = {
  country_code: 'Country',
  citation_text: 'Citation',
  quality_rating: 'Quality rating',
  life_stage: 'Life stage',
  household_type: 'Household type',
  is_derived: 'Derived',
  rows_imported: 'Rows imported',
  rows_rejected: 'Rows rejected',
  evidence_level: 'Evidence level',
};

function columnsFor(tab: Tab): string[] {
  switch (tab) {
    case 'sources':
      return ['Source', 'Publisher', 'Status', 'country_code', 'citation_text', 'quality_rating'];
    case 'datasets':
      return ['Dataset', 'Version', 'Class', 'Evidence', 'Status', 'Effective From', 'Review Due', 'Publisher'];
    case 'cohorts':
      return ['Cohort Code', 'country_code', 'Tier', 'life_stage', 'household_type', 'Description'];
    case 'values':
      return ['Dataset', 'Metric', 'Statistic', 'Value', 'Currency', 'is_derived'];
    case 'target-ranges':
      return ['Metric', 'country_code', 'Band Label', 'Band Tier', 'Min', 'Max', 'evidence_level'];
    case 'update-runs':
      return ['Dataset', 'Approval', 'rows_imported', 'rows_rejected', 'Imported At'];
    case 'upload':
      return [];
  }
}
