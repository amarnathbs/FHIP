'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';
import type { RetirementPlanningContext } from '@/lib/services/retirementMemberData';

// Retirement Member UI — Self/Spouse Target Retirement Age (spec s.6-9,
// s.35-39). Sits above the retirement accounts/contributions grid on the
// Retirement page. Target retirement age is captured once per member here,
// not once per account (the account grid's own field was removed — spec
// s.16). Spouse/Partner only appears when the household's own canonical
// composition model says a spouse/partner applies (spec s.9); this
// component never asks about DOB — Profile remains the sole source (s.7).
type MemberFormState = {
  value: string; // raw input value, '' = empty
  ageSource: 'user_confirmed' | 'suggested_default' | 'needs_confirmation' | null;
};

function initialFormState(row: RetirementPlanningContext['self'] | RetirementPlanningContext['spouse']): MemberFormState {
  if (!row) return { value: '', ageSource: null };
  return { value: row.target_retirement_age != null ? String(row.target_retirement_age) : '', ageSource: row.age_source };
}

export function RetirementPlanningSection() {
  const [context, setContext] = useState<RetirementPlanningContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selfForm, setSelfForm] = useState<MemberFormState>({ value: '', ageSource: null });
  const [spouseForm, setSpouseForm] = useState<MemberFormState>({ value: '', ageSource: null });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/retirement/members');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not load retirement planning data');
        if (cancelled) return;
        const ctx = json.data as RetirementPlanningContext;
        setContext(ctx);
        setSelfForm(initialFormState(ctx.self));
        setSpouseForm(initialFormState(ctx.spouse));
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Something went wrong');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function save() {
    if (!context) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const requests: Promise<Response>[] = [];
      if (selfForm.value !== '') {
        requests.push(
          fetch('/api/retirement/members', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ member_type: 'self', target_retirement_age: Number(selfForm.value) }),
          })
        );
      }
      if (context.spouseApplicable && spouseForm.value !== '') {
        requests.push(
          fetch('/api/retirement/members', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ member_type: 'spouse', target_retirement_age: Number(spouseForm.value) }),
          })
        );
      }
      const responses = await Promise.all(requests);
      for (const res of responses) {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? 'Could not save retirement plan');
      }
      setSelfForm((s) => ({ ...s, ageSource: 'user_confirmed' }));
      if (context.spouseApplicable) setSpouseForm((s) => ({ ...s, ageSource: 'user_confirmed' }));
      setMessage('Saved. FHIP will use these ages the next time it projects retirement savings.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <SectionCard title="Retirement Planning" description="Loading your retirement planning details…">
        <div />
      </SectionCard>
    );
  }

  if (loadError || !context) {
    return (
      <SectionCard title="Retirement Planning" description="Set the age you and your partner plan to retire.">
        <p className="text-sm text-risk">{loadError ?? 'Could not load retirement planning data.'}</p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Retirement Planning"
      description="Set the age you and your partner plan to retire. FHIP uses this when projecting retirement savings and retirement readiness."
      className="mb-6"
    >
      {/* Desktop/tablet: compact Member/Current Age/Target Age table (spec s.37). */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className="pb-2 pr-4 font-medium">Member</th>
              <th className="pb-2 pr-4 font-medium">Current Age</th>
              <th className="pb-2 font-medium">Target Retirement Age</th>
            </tr>
          </thead>
          <tbody>
            <MemberRow
              label="Self"
              currentAge={context.selfCurrentAge}
              form={selfForm}
              onChange={(value) => setSelfForm((s) => ({ ...s, value }))}
              countryDefault={context.countryDefaultRetirementAge}
            />
            {context.spouseApplicable && (
              <MemberRow
                label="Spouse/Partner"
                currentAge={null}
                form={spouseForm}
                onChange={(value) => setSpouseForm((s) => ({ ...s, value }))}
                countryDefault={context.countryDefaultRetirementAge}
              />
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards, same fields (spec s.37). */}
      <div className="space-y-3 sm:hidden">
        <MemberCard
          label="Self"
          currentAge={context.selfCurrentAge}
          form={selfForm}
          onChange={(value) => setSelfForm((s) => ({ ...s, value }))}
          countryDefault={context.countryDefaultRetirementAge}
        />
        {context.spouseApplicable && (
          <MemberCard
            label="Spouse/Partner"
            currentAge={null}
            form={spouseForm}
            onChange={(value) => setSpouseForm((s) => ({ ...s, value }))}
            countryDefault={context.countryDefaultRetirementAge}
          />
        )}
      </div>

      <p className="mt-3 text-xs text-muted">
        Your target retirement age helps FHIP estimate how long you have to build retirement savings. You can change it at any time.
        {context.spouseApplicable && ' Your partner can have a different target retirement age.'}
      </p>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="rounded bg-trust px-4 py-1.5 text-sm text-white disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save Retirement Plan'}
        </button>
        {message && <p className="text-sm text-progress">{message}</p>}
        {error && <p className="text-sm text-risk">{error}</p>}
      </div>
    </SectionCard>
  );
}

function AgeInput({
  label,
  form,
  onChange,
  countryDefault,
}: {
  label: string;
  form: MemberFormState;
  onChange: (value: string) => void;
  countryDefault: number;
}) {
  const showSuggestedBadge = form.value === '' && form.ageSource !== 'needs_confirmation';
  const showConfirmBadge = form.ageSource === 'needs_confirmation';
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min={1}
        max={119}
        value={form.value}
        placeholder={String(countryDefault)}
        onChange={(e) => onChange(e.target.value)}
        className="w-24 rounded border border-line px-2 py-1"
        aria-label={`${label} target retirement age`}
      />
      {showSuggestedBadge && <span className="rounded bg-app px-2 py-0.5 text-xs text-muted">Suggested: {countryDefault}</span>}
      {showConfirmBadge && <span className="rounded bg-attention/10 px-2 py-0.5 text-xs text-attention">Please confirm</span>}
    </div>
  );
}

function MemberRow({
  label,
  currentAge,
  form,
  onChange,
  countryDefault,
}: {
  label: string;
  currentAge: number | null;
  form: MemberFormState;
  onChange: (value: string) => void;
  countryDefault: number;
}) {
  return (
    <tr className="border-t border-line">
      <td className="py-2 pr-4 font-medium text-ink">{label}</td>
      <td className="py-2 pr-4 text-muted">{currentAge !== null ? `${currentAge}` : '—'}</td>
      <td className="py-2">
        <AgeInput label={label} form={form} onChange={onChange} countryDefault={countryDefault} />
      </td>
    </tr>
  );
}

function MemberCard({
  label,
  currentAge,
  form,
  onChange,
  countryDefault,
}: {
  label: string;
  currentAge: number | null;
  form: MemberFormState;
  onChange: (value: string) => void;
  countryDefault: number;
}) {
  return (
    <div className="rounded-compact border border-line p-3">
      <div className="flex items-center justify-between">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-xs text-muted">{currentAge !== null ? `Current age: ${currentAge}` : null}</span>
      </div>
      <div className="mt-2">
        <label className="block text-xs text-muted">Target Retirement Age</label>
        <div className="mt-1">
          <AgeInput label={label} form={form} onChange={onChange} countryDefault={countryDefault} />
        </div>
      </div>
    </div>
  );
}
