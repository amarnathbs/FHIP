'use client';

// LR-2 WP-10 (2026-09-07): before this, a Goal had NO working edit
// capability anywhere in the app for any field after creation — not even
// target_date (an earlier discovery pass claimed a `GoalActionabilityCard`
// component provided a target_date-only editor; that component does not
// exist anywhere in the repo, and no component calls `PUT /api/goals/:id`
// at all. Verified directly by grep before writing this file, not assumed).
// This component is the first genuine form-first Edit surface for Goals,
// matching the same "Edit loads the selected record back into the top
// form" pattern used by the other 7 input modules' shared grid (see
// components/grid/FinancialDataGrid.tsx), adapted to Goals' own
// single-record detail-page layout rather than a list+form page.
//
// Scope deliberately excludes: goal_type, country_code, currency_code,
// household_id, owner_member_id, beneficiary_member_id, linked_liability_id
// (identity/relationship fields, not casual edits) and anything already
// owned by its own dedicated UI elsewhere on this page — funding-source
// relationships (FundingSourceList), milestones (MilestoneTracker),
// contribution history (ContributionHistory) and lifecycle transitions
// (archive/complete/pause/resume) are untouched here, matching the LR-2
// pack's own lock: "Preserve Goal funding source relationships, lifecycle
// states and linked investment attribution."
//
// The backend needed no changes at all: app/api/goals/[id]/route.ts's PUT
// already accepts a `.partial()` of the full goalSchema (lib/validation/
// goal.ts) — this form simply exercises fields that already had a working,
// validated write path and just never had a UI in front of them.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export interface GoalEditableFields {
  goalName: string;
  description: string | null;
  targetAmount: number;
  targetDate: string | null;
  targetDateFlexibility: string;
  // Deliberately distinct from any live linked-investment value: this is
  // the manually-entered, unbacked progress figure (goalsData.ts's
  // `current_amount` column, before live funding-source value is added on
  // top for display elsewhere). ORACLE-04 (LR-2): editing this must never
  // create an asset or duplicate a linked Investment's value — it is
  // purely this goal's own informal progress note.
  manualCurrentAmount: number;
  plannedContributionAmount: number;
  contributionFrequency: string;
  annualContributionGrowthPct: number;
  userPriority: number;
  importanceType: string;
  inflationAdjusted: boolean;
}

const FREQUENCY_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'annually', label: 'Annually' },
  { value: 'one_off', label: 'One-off' },
];

const IMPORTANCE_OPTIONS = [
  { value: 'essential', label: 'Essential' },
  { value: 'important', label: 'Important' },
  { value: 'aspirational', label: 'Aspirational' },
];

const FLEXIBILITY_OPTIONS = [
  { value: 'fixed', label: 'Fixed — this date matters' },
  { value: 'flexible', label: 'Flexible — could move' },
  { value: 'indicative', label: 'Indicative — a rough idea' },
];

export function GoalEditPanel({
  goalId,
  goalTypeLabel,
  countryLabel,
  currency,
  initial,
}: {
  goalId: string;
  goalTypeLabel: string;
  countryLabel: string;
  currency: string;
  initial: GoalEditableFields;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<GoalEditableFields>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: Partial<GoalEditableFields>) => setForm((f) => ({ ...f, ...patch }));

  // NEG-03 equivalent: cancel discards every uncommitted change — `form`
  // is reset back to `initial` (the last genuinely saved values), never
  // partially applied.
  function handleCancel() {
    setForm(initial);
    setError(null);
    setEditing(false);
  }

  async function handleSave() {
    if (!form.goalName.trim()) {
      setError('Give this goal a name.');
      return;
    }
    if (!(form.targetAmount >= 0)) {
      setError('Enter a valid target amount.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/goals/${goalId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_name: form.goalName.trim(),
          description: form.description || undefined,
          target_amount: form.targetAmount,
          target_date: form.targetDate || undefined,
          target_date_flexibility: form.targetDateFlexibility,
          current_amount: form.manualCurrentAmount,
          planned_contribution_amount: form.plannedContributionAmount,
          contribution_frequency: form.contributionFrequency,
          annual_contribution_growth_pct: form.annualContributionGrowthPct,
          user_priority: form.userPriority,
          importance_type: form.importanceType,
          inflation_adjusted: form.inflationAdjusted,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not save changes');
      setEditing(false);
      router.refresh(); // reload through the canonical GET path (AC-07 — reload durability)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-trust">{form.goalName}</h1>
          <p className="text-muted">
            {goalTypeLabel} · {countryLabel} · {currency} · Priority {form.userPriority}/5
          </p>
        </div>
        <button
          onClick={() => setEditing(true)}
          className="shrink-0 rounded border px-4 py-2 text-sm font-medium text-trust hover:bg-blue-50"
        >
          Edit goal
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-card border bg-white p-6">
      <h2 className="text-lg font-semibold text-ink">Edit goal</h2>
      <div className="mt-4 space-y-4">
        <div>
          <label className="block text-sm text-gray-600">Goal name</label>
          <input
            value={form.goalName}
            onChange={(e) => update({ goalName: e.target.value })}
            className="mt-1 w-full max-w-md rounded border px-3 py-2 text-sm"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600">Description (optional)</label>
          <textarea
            value={form.description ?? ''}
            onChange={(e) => update({ description: e.target.value })}
            className="mt-1 w-full max-w-md rounded border px-3 py-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-md">
          <div>
            <label className="block text-sm text-gray-600">Target amount ({currency})</label>
            <input
              type="number"
              value={form.targetAmount}
              onChange={(e) => update({ targetAmount: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600">Target date</label>
            <input
              type="date"
              value={form.targetDate ?? ''}
              onChange={(e) => update({ targetDate: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
        </div>
        <div className="sm:max-w-md">
          <label className="block text-sm text-gray-600">How fixed is this date?</label>
          <select
            value={form.targetDateFlexibility}
            onChange={(e) => update({ targetDateFlexibility: e.target.value })}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          >
            {FLEXIBILITY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:max-w-md">
          <label className="block text-sm text-gray-600">
            Manually tracked progress ({currency})
            <span className="block text-xs font-normal text-muted">
              A rough note of what you&apos;ve already set aside — separate from any investment you&apos;ve linked to this goal below, which
              is tracked automatically and isn&apos;t affected by this field.
            </span>
          </label>
          <input
            type="number"
            value={form.manualCurrentAmount}
            onChange={(e) => update({ manualCurrentAmount: Number(e.target.value) })}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-md">
          <div>
            <label className="block text-sm text-gray-600">Planned contribution ({currency})</label>
            <input
              type="number"
              value={form.plannedContributionAmount}
              onChange={(e) => update({ plannedContributionAmount: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600">Frequency</label>
            <select
              value={form.contributionFrequency}
              onChange={(e) => update({ contributionFrequency: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            >
              {FREQUENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="sm:max-w-md">
          <label className="block text-sm text-gray-600">Annual contribution increase (%, optional)</label>
          <input
            type="number"
            value={form.annualContributionGrowthPct}
            onChange={(e) => update({ annualContributionGrowthPct: Number(e.target.value) })}
            className="mt-1 w-full rounded border px-3 py-2 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:max-w-md">
          <div>
            <label className="block text-sm text-gray-600">Priority (1 highest – 5 lowest)</label>
            <input
              type="number"
              min={1}
              max={5}
              value={form.userPriority}
              onChange={(e) => update({ userPriority: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-600">Importance</label>
            <select
              value={form.importanceType}
              onChange={(e) => update({ importanceType: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            >
              {IMPORTANCE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={form.inflationAdjusted}
            onChange={(e) => update({ inflationAdjusted: e.target.checked })}
          />
          Adjust this target for inflation to the target date
        </label>

        {error && <p className="text-sm text-risk">{error}</p>}

        <div className="flex items-center gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={handleCancel} disabled={saving} className="rounded border px-4 py-2 text-sm text-gray-700">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
