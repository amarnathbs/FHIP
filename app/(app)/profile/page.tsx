'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { COUNTRY_OPTIONS } from '@/lib/constants';
import { MIN_PLAUSIBLE_AGE, MAX_PLAUSIBLE_AGE } from '@/lib/engines/age';

// App Review spec §16 — Profile Page.
// No dedicated Profile page previously existed (confirmed absent — no
// app/(app)/profile/ directory). Backed by the EXISTING app/api/user/profile
// GET/PUT route and profileSchema (lib/validation/profile.ts) — this page
// adds no new profile-fields API surface beyond the one genuinely missing
// column, Contact number (migration 0078).
//
// §16.1 Email changes: email is never read from or written to user_profiles
// — it lives solely in Supabase Auth (auth.users.email) and is changed here
// via supabase.auth.updateUser({ email }), which triggers Supabase's own
// built-in verification-email flow. Because there is no second, mirrored
// copy of email in this app's own tables, "the application profile staying
// synchronised with Auth's verified email" is structurally guaranteed —
// there is nothing to drift out of sync in the first place. The change only
// takes effect once the user clicks the confirmation link Supabase sends;
// until then supabase.auth.getUser() keeps returning the current (old)
// email, which is what this page always displays fresh on every load.
//
// §16.2 Date of birth: editing DOB here saves straight through the normal
// PUT /api/user/profile call. Checked every in-scope consumer of
// date_of_birth (healthScoreData.ts, forecastData.ts, financialDnaData.ts,
// retirementMemberData.ts) — none of them cache or persist a derived "age"
// value; every one calls ageFromDob(profile.date_of_birth) fresh on each
// read. There is therefore no stale derived output to explicitly invalidate
// for anything in scope: the very next Health Score / Forecast / DNA read
// after saving already reflects the new DOB. Financial Twin cohort-matching
// specifically is out of scope for this task and is not touched here.
type ProfileData = {
  full_name: string | null;
  date_of_birth: string | null;
  country_of_residence: 'AU' | 'IN' | null;
  secondary_country: 'AU' | 'IN' | null;
  preferred_currency: 'AUD' | 'INR' | null;
  employment_status: string | null;
  phone: string | null;
};

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: 'full_time_employed', label: 'Full-time employed' },
  { value: 'part_time_employed', label: 'Part-time employed' },
  { value: 'self_employed', label: 'Self-employed' },
  { value: 'unemployed', label: 'Unemployed' },
  { value: 'retired', label: 'Retired' },
  { value: 'student', label: 'Student' },
];

function isoDateYearsAgo(years: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString().slice(0, 10);
}
const DOB_MIN_DATE = isoDateYearsAgo(MAX_PLAUSIBLE_AGE);
const DOB_MAX_DATE = isoDateYearsAgo(MIN_PLAUSIBLE_AGE);

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json.data as T;
}

export default function ProfilePage() {
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const [newEmail, setNewEmail] = useState('');
  const [emailStatus, setEmailStatus] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const supabase = createClient();
      const [profileData, userRes] = await Promise.all([
        fetchJson<ProfileData>('/api/user/profile'),
        supabase.auth.getUser(),
      ]);
      if (cancelled) return;
      setProfile(profileData);
      setEmail(userRes.data.user?.email ?? null);
      setLoading(false);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  function updateField<K extends keyof ProfileData>(field: K, value: ProfileData[K]) {
    setProfile((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  async function handleSave() {
    if (!profile) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const updated = await fetchJson<ProfileData>('/api/user/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          full_name: profile.full_name,
          date_of_birth: profile.date_of_birth || undefined,
          country_of_residence: profile.country_of_residence,
          secondary_country: profile.secondary_country,
          preferred_currency: profile.preferred_currency,
          employment_status: profile.employment_status,
          phone: profile.phone,
        }),
      });
      setProfile(updated);
      setSaveMessage({ kind: 'ok', text: 'Saved.' });
    } catch (err) {
      setSaveMessage({ kind: 'error', text: err instanceof Error ? err.message : 'Could not save changes.' });
    } finally {
      setSaving(false);
    }
  }

  async function handleEmailChange() {
    setEmailStatus(null);
    const trimmed = newEmail.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailStatus({ kind: 'error', text: 'Enter a valid email address.' });
      return;
    }
    if (trimmed === email) {
      setEmailStatus({ kind: 'error', text: 'That is already your current email address.' });
      return;
    }
    setEmailSubmitting(true);
    try {
      const supabase = createClient();
      // Supabase Auth's own native email-change flow — not a custom one.
      // Sends a verification email; auth.users.email only changes once the
      // user confirms via that link (and, if "secure email change" is
      // enabled on this Supabase project, only after confirming from the
      // OLD address too) — this app never flips the displayed email itself.
      const { error } = await supabase.auth.updateUser({ email: trimmed });
      if (error) throw error;
      setEmailStatus({
        kind: 'ok',
        text: `Verification email sent to ${trimmed}. Your sign-in email won't change until you confirm it.`,
      });
      setNewEmail('');
    } catch (err) {
      setEmailStatus({ kind: 'error', text: err instanceof Error ? err.message : 'Could not start the email change.' });
    } finally {
      setEmailSubmitting(false);
    }
  }

  if (loading || !profile) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-trust">Profile</h1>
        <p className="text-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Profile</h1>
        <p className="mt-1 text-muted">Your account and core personal details.</p>
      </div>

      <SectionCard title="Personal details" description="Used across your dashboard, forecasts and reports.">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-muted">Name</label>
            <input
              type="text"
              value={profile.full_name ?? ''}
              onChange={(e) => updateField('full_name', e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Contact number</label>
            <input
              type="tel"
              value={profile.phone ?? ''}
              onChange={(e) => updateField('phone', e.target.value)}
              placeholder="Optional"
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Date of birth</label>
            <input
              type="date"
              min={DOB_MIN_DATE}
              max={DOB_MAX_DATE}
              value={profile.date_of_birth ?? ''}
              onChange={(e) => updateField('date_of_birth', e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">
              Used for age-based figures (e.g. Health Score, Forecasting). Changing this updates those the next time
              they're calculated — it doesn't affect your Financial Twin benchmark cohort.
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Employment status</label>
            <select
              value={profile.employment_status ?? ''}
              onChange={(e) => updateField('employment_status', e.target.value)}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            >
              <option value="">-</option>
              {EMPLOYMENT_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Country of residence</label>
            <select
              value={profile.country_of_residence ?? ''}
              onChange={(e) => updateField('country_of_residence', e.target.value as 'AU' | 'IN')}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            >
              {COUNTRY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted">Preferred currency</label>
            <select
              value={profile.preferred_currency ?? ''}
              onChange={(e) => updateField('preferred_currency', e.target.value as 'AUD' | 'INR')}
              className="mt-1 w-full rounded border px-3 py-2 text-sm"
            >
              <option value="AUD">AUD</option>
              <option value="INR">INR</option>
            </select>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="rounded-full bg-primary px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          {saveMessage && (
            <span className={`text-sm ${saveMessage.kind === 'ok' ? 'text-positive' : 'text-risk'}`}>
              {saveMessage.text}
            </span>
          )}
        </div>
      </SectionCard>

      <SectionCard title="Email" description="Your sign-in email, managed securely through account verification.">
        <p className="text-sm text-ink">
          Current: <span className="font-medium">{email ?? 'Unknown'}</span>
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="New email address"
            className="w-64 rounded border px-3 py-2 text-sm"
          />
          <button
            onClick={() => void handleEmailChange()}
            disabled={emailSubmitting}
            className="rounded-full border border-trust px-4 py-2 text-sm font-medium text-trust hover:bg-trust/5 disabled:opacity-50"
          >
            {emailSubmitting ? 'Sending…' : 'Change email'}
          </button>
        </div>
        {emailStatus && (
          <p className={`mt-2 text-sm ${emailStatus.kind === 'ok' ? 'text-positive' : 'text-risk'}`}>{emailStatus.text}</p>
        )}
        <p className="mt-2 text-xs text-muted">
          We'll send a verification link to the new address — your sign-in email only changes once you confirm it.
        </p>
      </SectionCard>
    </div>
  );
}
