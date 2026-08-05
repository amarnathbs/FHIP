'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

const STEPS = ['Goal Type', 'Define', 'Target', 'Contribution Plan', 'Review'] as const;

interface GoalTypeRef {
  type_key: string;
  category: string;
  type_label: string;
  default_priority: number;
  default_importance_type: string;
}

type FormState = {
  goal_type: string;
  goal_name: string;
  description: string;
  country_code: 'AU' | 'IN';
  currency_code: 'AUD' | 'INR';
  target_date: string;
  target_amount: number;
  current_amount: number;
  inflation_adjusted: boolean;
  planned_contribution_amount: number;
  contribution_frequency: string;
  annual_contribution_growth_pct: number;
  user_priority: number;
  importance_type: string;
};

const INITIAL: FormState = {
  goal_type: '',
  goal_name: '',
  description: '',
  country_code: 'AU',
  currency_code: 'AUD',
  target_date: '',
  target_amount: 0,
  current_amount: 0,
  inflation_adjusted: true,
  planned_contribution_amount: 0,
  contribution_frequency: 'monthly',
  annual_contribution_growth_pct: 0,
  user_priority: 3,
  importance_type: 'important',
};

export function GoalCreationWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [goalTypes, setGoalTypes] = useState<GoalTypeRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/reference/goal-types')
      .then((r) => r.json())
      .then((json) => setGoalTypes(json.data ?? []));
  }, []);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  const grouped = goalTypes.reduce<Record<string, GoalTypeRef[]>>((acc, t) => {
    (acc[t.category] ??= []).push(t);
    return acc;
  }, {});

  async function next() {
    setError(null);
    if (step === 0 && !form.goal_type) {
      setError('Select a goal type to continue.');
      return;
    }
    if (step === 1 && !form.goal_name) {
      setError('Give this goal a name.');
      return;
    }
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal_type: form.goal_type,
          goal_name: form.goal_name,
          description: form.description || undefined,
          country_code: form.country_code,
          currency_code: form.currency_code,
          target_date: form.target_date || undefined,
          target_amount: form.target_amount,
          current_amount: form.current_amount,
          inflation_adjusted: form.inflation_adjusted,
          planned_contribution_amount: form.planned_contribution_amount,
          contribution_frequency: form.contribution_frequency,
          annual_contribution_growth_pct: form.annual_contribution_growth_pct,
          user_priority: form.user_priority,
          importance_type: form.importance_type,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Could not save goal');
      router.push('/goals');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex flex-wrap gap-2">
        {STEPS.map((s, i) => (
          <span key={s} className={`rounded-full px-3 py-1 text-xs ${i === step ? 'bg-trust text-white' : 'bg-gray-100 text-muted'}`}>
            {i + 1}. {s}
          </span>
        ))}
      </div>

      <div className="rounded-card border bg-white p-6">
        {step === 0 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">What are you saving or planning for?</h2>
            {Object.entries(grouped).map(([category, types]) => (
              <div key={category}>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">{category.replace(/_/g, ' ')}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {types.map((t) => (
                    <button
                      key={t.type_key}
                      onClick={() =>
                        update({
                          goal_type: t.type_key,
                          user_priority: t.default_priority,
                          importance_type: t.default_importance_type,
                        })
                      }
                      className={`rounded border px-3 py-2 text-sm ${
                        form.goal_type === t.type_key ? 'border-trust bg-blue-50 text-trust' : 'text-gray-700 hover:border-trust'
                      }`}
                    >
                      {t.type_label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Define the goal</h2>
            <div>
              <label className="block text-sm text-gray-600">Goal name</label>
              <input
                value={form.goal_name}
                onChange={(e) => update({ goal_name: e.target.value })}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">Description (optional)</label>
              <textarea
                value={form.description}
                onChange={(e) => update({ description: e.target.value })}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Country</label>
                <select
                  value={form.country_code}
                  onChange={(e) => update({ country_code: e.target.value as 'AU' | 'IN' })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                >
                  <option value="AU">Australia</option>
                  <option value="IN">India</option>
                </select>
              </div>
              <div>
                <label className="block text-sm text-gray-600">Currency</label>
                <select
                  value={form.currency_code}
                  onChange={(e) => update({ currency_code: e.target.value as 'AUD' | 'INR' })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                >
                  <option value="AUD">AUD</option>
                  <option value="INR">INR</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600">Target date (optional)</label>
              <input
                type="date"
                value={form.target_date}
                onChange={(e) => update({ target_date: e.target.value })}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Define the target</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Target amount (today&apos;s money)</label>
                <input
                  type="number"
                  value={form.target_amount}
                  onChange={(e) => update({ target_amount: Number(e.target.value) })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Current amount already set aside</label>
                <input
                  type="number"
                  value={form.current_amount}
                  onChange={(e) => update({ current_amount: Number(e.target.value) })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={form.inflation_adjusted}
                onChange={(e) => update({ inflation_adjusted: e.target.checked })}
              />
              Adjust this target for inflation to the target date
            </label>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-ink">Contribution plan</h2>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-gray-600">Planned contribution</label>
                <input
                  type="number"
                  value={form.planned_contribution_amount}
                  onChange={(e) => update({ planned_contribution_amount: Number(e.target.value) })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                />
              </div>
              <div>
                <label className="block text-sm text-gray-600">Frequency</label>
                <select
                  value={form.contribution_frequency}
                  onChange={(e) => update({ contribution_frequency: e.target.value })}
                  className="mt-1 w-full rounded border px-3 py-2 text-sm"
                >
                  <option value="weekly">Weekly</option>
                  <option value="fortnightly">Fortnightly</option>
                  <option value="monthly">Monthly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600">Annual contribution increase (%, optional)</label>
              <input
                type="number"
                value={form.annual_contribution_growth_pct}
                onChange={(e) => update({ annual_contribution_growth_pct: Number(e.target.value) })}
                className="mt-1 w-full rounded border px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3 text-sm">
            <h2 className="text-lg font-semibold text-ink">Review</h2>
            <p>
              <span className="text-muted">Goal:</span> {form.goal_name || '—'}
            </p>
            <p>
              <span className="text-muted">Target:</span> {form.currency_code} {form.target_amount.toLocaleString()}
              {form.target_date && ` by ${form.target_date}`}
            </p>
            <p>
              <span className="text-muted">Current amount:</span> {form.currency_code} {form.current_amount.toLocaleString()}
            </p>
            <p>
              <span className="text-muted">Contribution:</span> {form.currency_code} {form.planned_contribution_amount.toLocaleString()}{' '}
              {form.contribution_frequency}
            </p>
            <p className="text-xs text-muted">
              Your estimated progress, funding gap, required contribution and forecast completion date will be calculated
              from the assumptions shown once this goal is saved — this is an estimate, not a guarantee.
            </p>
          </div>
        )}

        {error && <p className="mt-4 text-sm text-risk">{error}</p>}

        <div className="mt-6 flex justify-between">
          <button onClick={back} disabled={step === 0} className="rounded border px-4 py-2 text-sm text-gray-700 disabled:opacity-40">
            Back
          </button>
          <button onClick={next} disabled={submitting} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
            {step === STEPS.length - 1 ? (submitting ? 'Saving...' : 'Save Goal') : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
