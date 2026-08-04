'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const STEPS = ['Profile', 'Household', 'Countries & Currency', 'Goals', 'Review'] as const;

type FormState = {
  full_name: string;
  date_of_birth: string;
  employment_status: string;
  household_type: string;
  marital_status: string;
  dependants_count: number;
  housing_tenure: string;
  residence_type: string;
  country_of_residence: 'AU' | 'IN';
  preferred_currency: 'AUD' | 'INR';
  goal_name: string;
  goal_type: string;
  target_amount: number;
};

const INITIAL: FormState = {
  full_name: '',
  date_of_birth: '',
  employment_status: '',
  household_type: '',
  marital_status: '',
  dependants_count: 0,
  housing_tenure: '',
  residence_type: '',
  country_of_residence: 'AU',
  preferred_currency: 'AUD',
  goal_name: '',
  goal_type: 'starter_emergency_fund',
  target_amount: 0,
};

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const back = () => setStep((s) => Math.max(s - 1, 0));

  async function next() {
    setError(null);
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
      return;
    }
    setSubmitting(true);
    try {
      const profileRes = await fetch('/api/user/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: form.full_name,
          date_of_birth: form.date_of_birth || undefined,
          country_of_residence: form.country_of_residence,
          preferred_currency: form.preferred_currency,
          employment_status: form.employment_status || undefined,
        }),
      });
      if (!profileRes.ok) throw new Error((await profileRes.json()).error ?? 'Could not save profile');

      const householdRes = await fetch('/api/household', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          household_type: form.household_type || undefined,
          marital_status: form.marital_status || undefined,
          dependants_count: form.dependants_count,
          primary_country: form.country_of_residence,
          housing_tenure: form.housing_tenure || undefined,
          residence_type: form.residence_type || undefined,
        }),
      });
      if (!householdRes.ok) throw new Error((await householdRes.json()).error ?? 'Could not save household');

      if (form.goal_name) {
        const goalRes = await fetch('/api/goals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            goal_name: form.goal_name,
            goal_type: form.goal_type,
            target_amount: form.target_amount,
            currency_code: form.preferred_currency,
          }),
        });
        if (!goalRes.ok) throw new Error((await goalRes.json()).error ?? 'Could not save goal');
      }

      const completeRes = await fetch('/api/onboarding/complete', { method: 'POST' });
      if (!completeRes.ok) throw new Error('Could not complete onboarding');

      router.push('/dashboard');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <ol className="mb-6 flex gap-2 text-xs">
        {STEPS.map((label, i) => (
          <li key={label} className={i <= step ? 'font-semibold text-trust' : 'text-gray-400'}>
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="full_name" className="block text-sm text-gray-600">Full name</label>
            <input
              id="full_name"
              value={form.full_name}
              onChange={(e) => update({ full_name: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="date_of_birth" className="block text-sm text-gray-600">Date of birth</label>
            <input
              id="date_of_birth"
              type="date"
              value={form.date_of_birth}
              onChange={(e) => update({ date_of_birth: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="employment_status" className="block text-sm text-gray-600">Employment status</label>
            <input
              id="employment_status"
              value={form.employment_status}
              onChange={(e) => update({ employment_status: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="household_type" className="block text-sm text-gray-600">Household type</label>
            <input
              id="household_type"
              value={form.household_type}
              onChange={(e) => update({ household_type: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="marital_status" className="block text-sm text-gray-600">Marital status</label>
            <input
              id="marital_status"
              value={form.marital_status}
              onChange={(e) => update({ marital_status: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="dependants_count" className="block text-sm text-gray-600">Dependants</label>
            <input
              id="dependants_count"
              type="number"
              min={0}
              value={form.dependants_count}
              onChange={(e) => update({ dependants_count: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="housing_tenure" className="block text-sm text-gray-600">Housing</label>
            <select
              id="housing_tenure"
              value={form.housing_tenure}
              onChange={(e) => update({ housing_tenure: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              <option value="">Prefer not to say</option>
              <option value="renter">Renting</option>
              <option value="mortgage_owner">Homeowner with mortgage</option>
              <option value="outright_owner">Homeowner outright</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label htmlFor="residence_type" className="block text-sm text-gray-600">Area type</label>
            <select
              id="residence_type"
              value={form.residence_type}
              onChange={(e) => update({ residence_type: e.target.value })}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              <option value="unspecified">Prefer not to say</option>
              <option value="metro">Metropolitan / major city</option>
              <option value="regional">Regional</option>
              <option value="rural">Rural</option>
            </select>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="country_of_residence" className="block text-sm text-gray-600">Country of residence</label>
            <select
              id="country_of_residence"
              value={form.country_of_residence}
              onChange={(e) =>
                update({
                  country_of_residence: e.target.value as 'AU' | 'IN',
                  preferred_currency: e.target.value === 'IN' ? 'INR' : 'AUD',
                })
              }
              className="mt-1 w-full rounded border px-3 py-2"
            >
              <option value="AU">Australia</option>
              <option value="IN">India</option>
            </select>
          </div>
          <div>
            <label htmlFor="preferred_currency" className="block text-sm text-gray-600">Preferred currency</label>
            <select
              id="preferred_currency"
              value={form.preferred_currency}
              onChange={(e) => update({ preferred_currency: e.target.value as 'AUD' | 'INR' })}
              className="mt-1 w-full rounded border px-3 py-2"
            >
              <option value="AUD">AUD</option>
              <option value="INR">INR</option>
            </select>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <div>
            <label htmlFor="goal_name" className="block text-sm text-gray-600">First goal (optional)</label>
            <input
              id="goal_name"
              value={form.goal_name}
              onChange={(e) => update({ goal_name: e.target.value })}
              placeholder="e.g. Build a 3-month emergency fund"
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
          <div>
            <label htmlFor="target_amount" className="block text-sm text-gray-600">Target amount</label>
            <input
              id="target_amount"
              type="number"
              min={0}
              value={form.target_amount}
              onChange={(e) => update({ target_amount: Number(e.target.value) })}
              className="mt-1 w-full rounded border px-3 py-2"
            />
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-2 rounded-card border bg-gray-50 p-4 text-sm">
          <p>
            <strong>{form.full_name || 'Unnamed'}</strong> · {form.country_of_residence} ·{' '}
            {form.preferred_currency}
          </p>
          <p>Household: {form.household_type || 'not set'}, {form.dependants_count} dependants</p>
          {form.goal_name && (
            <p>
              Goal: {form.goal_name} ({form.preferred_currency} {form.target_amount})
            </p>
          )}
        </div>
      )}

      {error && <p className="mt-4 text-sm text-risk">{error}</p>}

      <div className="mt-6 flex justify-between">
        <button onClick={back} disabled={step === 0 || submitting} className="rounded px-4 py-2 text-gray-600">
          Back
        </button>
        <button
          onClick={next}
          disabled={submitting}
          className="rounded bg-trust px-4 py-2 text-white disabled:opacity-60"
        >
          {submitting ? 'Saving...' : step === STEPS.length - 1 ? 'Finish' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
