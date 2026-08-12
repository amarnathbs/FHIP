'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MIN_PLAUSIBLE_AGE, MAX_PLAUSIBLE_AGE } from '@/lib/engines/age';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { SelectWithOther, type SelectOption } from '@/components/ui/SelectWithOther';

const STEPS = ['Profile', 'Household', 'Countries & Currency', 'Goals', 'Review'] as const;

const STEP_DESCRIPTIONS: Record<number, string> = {
  0: 'Tell us a little about yourself.',
  1: "Who's in your household? This shapes how we benchmark and forecast for you.",
  2: 'Where you live and which currency your numbers should show in.',
  3: 'Optional — you can always add or refine goals later from Planning.',
};

// Client-side hints only — lib/validation/profile.ts's Zod refine is the
// authoritative check. This is the primary account holder's own DOB, so the
// adult bounds apply (not the wider household-member bounds).
function isoDateYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
const DOB_MIN_DATE = isoDateYearsAgo(MAX_PLAUSIBLE_AGE);
const DOB_MAX_DATE = isoDateYearsAgo(MIN_PLAUSIBLE_AGE);

const EMPLOYMENT_STATUS_OPTIONS: SelectOption[] = [
  { value: 'full_time_employed', label: 'Full-time employed' },
  { value: 'part_time_employed', label: 'Part-time employed' },
  { value: 'self_employed', label: 'Self-employed' },
  { value: 'unemployed', label: 'Unemployed' },
  { value: 'retired', label: 'Retired' },
  { value: 'student', label: 'Student' },
];

const HOUSEHOLD_TYPE_OPTIONS: SelectOption[] = [
  { value: 'single', label: 'Single' },
  { value: 'couple_no_dependants', label: 'Couple, no dependants' },
  { value: 'couple_with_dependants', label: 'Couple with dependants' },
  { value: 'single_parent', label: 'Single parent' },
  { value: 'multi_generational', label: 'Multi-generational household' },
  { value: 'share_house', label: 'Share house' },
];

const MARITAL_STATUS_OPTIONS: SelectOption[] = [
  { value: 'single', label: 'Single' },
  { value: 'married_partnered', label: 'Married or partnered' },
  { value: 'divorced', label: 'Divorced' },
  { value: 'widowed', label: 'Widowed' },
];

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

// Per-step required fields — a lightweight client-side gate before the user
// can advance, distinct from (and less strict than) the authoritative Zod
// schemas (lib/validation/profile.ts, household.ts) the server still
// enforces on final submit. Only fields worth blocking progress over are
// listed here; Countries & Currency (step 2) and Goals (step 3) have no
// entries because their fields either always carry a real default (country/
// currency selects have no blank option) or are genuinely optional.
function validateStep(step: number, form: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (step === 0) {
    if (!form.full_name.trim()) errors.full_name = 'Full name is required.';
  }
  if (step === 1) {
    if (!form.household_type) errors.household_type = 'Please select a household type.';
  }
  return errors;
}

export function OnboardingWizard() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(INITIAL);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const update = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const back = () => {
    setFieldErrors({});
    setStep((s) => Math.max(s - 1, 0));
  };

  async function next() {
    setError(null);
    const errors = validateStep(step, form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});

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
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <ol className="flex gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex-1">
            <div className={`h-1.5 rounded-full ${i <= step ? 'bg-trust' : 'bg-gray-200'}`} />
            <p className={`mt-1.5 text-xs ${i <= step ? 'font-semibold text-trust' : 'text-gray-400'}`}>{label}</p>
          </li>
        ))}
      </ol>

      {step === 0 && (
        <SectionCard title="Profile" description={STEP_DESCRIPTIONS[0]}>
          <div className="space-y-4">
            <div>
              <label htmlFor="full_name" className="block text-sm text-gray-600">
                Full name<span className="text-risk"> *</span>
              </label>
              <input
                id="full_name"
                value={form.full_name}
                onChange={(e) => update({ full_name: e.target.value })}
                className={`mt-1 w-full rounded border px-3 py-2 ${fieldErrors.full_name ? 'border-risk' : 'border-line'}`}
              />
              {fieldErrors.full_name && <p className="mt-1 text-xs text-risk">{fieldErrors.full_name}</p>}
            </div>
            <div>
              <label htmlFor="date_of_birth" className="block text-sm text-gray-600">Date of birth</label>
              <input
                id="date_of_birth"
                type="date"
                value={form.date_of_birth}
                onChange={(e) => update({ date_of_birth: e.target.value })}
                min={DOB_MIN_DATE}
                max={DOB_MAX_DATE}
                className="mt-1 w-full rounded border border-line px-3 py-2"
              />
            </div>
            <SelectWithOther
              id="employment_status"
              label="Employment status"
              value={form.employment_status}
              onChange={(v) => update({ employment_status: v })}
              options={EMPLOYMENT_STATUS_OPTIONS}
            />
          </div>
        </SectionCard>
      )}

      {step === 1 && (
        <SectionCard title="Household" description={STEP_DESCRIPTIONS[1]}>
          <div className="space-y-4">
            <SelectWithOther
              id="household_type"
              label="Household type"
              value={form.household_type}
              onChange={(v) => update({ household_type: v })}
              options={HOUSEHOLD_TYPE_OPTIONS}
              required
              error={fieldErrors.household_type}
            />
            <SelectWithOther
              id="marital_status"
              label="Marital status"
              value={form.marital_status}
              onChange={(v) => update({ marital_status: v })}
              options={MARITAL_STATUS_OPTIONS}
            />
            <div>
              <label htmlFor="dependants_count" className="block text-sm text-gray-600">Dependants</label>
              <input
                id="dependants_count"
                type="number"
                min={0}
                value={form.dependants_count}
                onChange={(e) => update({ dependants_count: Number(e.target.value) })}
                className="mt-1 w-full rounded border border-line px-3 py-2"
              />
            </div>
            <div>
              <label htmlFor="housing_tenure" className="block text-sm text-gray-600">Housing</label>
              <select
                id="housing_tenure"
                value={form.housing_tenure}
                onChange={(e) => update({ housing_tenure: e.target.value })}
                className="mt-1 w-full rounded border border-line px-3 py-2"
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
                className="mt-1 w-full rounded border border-line px-3 py-2"
              >
                <option value="unspecified">Prefer not to say</option>
                <option value="metro">Metropolitan / major city</option>
                <option value="regional">Regional</option>
                <option value="rural">Rural</option>
              </select>
            </div>
          </div>
        </SectionCard>
      )}

      {step === 2 && (
        <SectionCard title="Countries & Currency" description={STEP_DESCRIPTIONS[2]}>
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
                className="mt-1 w-full rounded border border-line px-3 py-2"
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
                className="mt-1 w-full rounded border border-line px-3 py-2"
              >
                <option value="AUD">AUD</option>
                <option value="INR">INR</option>
              </select>
            </div>
          </div>
        </SectionCard>
      )}

      {step === 3 && (
        <SectionCard title="Goals" description={STEP_DESCRIPTIONS[3]}>
          <div className="space-y-4">
            <div>
              <label htmlFor="goal_name" className="block text-sm text-gray-600">First goal (optional)</label>
              <input
                id="goal_name"
                value={form.goal_name}
                onChange={(e) => update({ goal_name: e.target.value })}
                placeholder="e.g. Build a 3-month emergency fund"
                className="mt-1 w-full rounded border border-line px-3 py-2"
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
                className="mt-1 w-full rounded border border-line px-3 py-2"
              />
            </div>
          </div>
        </SectionCard>
      )}

      {step === 4 && (
        <SectionCard title="Review" description="Check everything looks right before you finish.">
          <div className="space-y-2 text-sm">
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
        </SectionCard>
      )}

      {error && <p className="text-sm text-risk">{error}</p>}

      <div className="flex justify-between">
        <button onClick={back} disabled={step === 0 || submitting} className="rounded px-4 py-2 text-gray-600 disabled:opacity-40">
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
