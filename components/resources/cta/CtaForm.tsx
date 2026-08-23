'use client';

// R1.6 CTA Library create/edit form — spec §42-43, §52, §93.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CTA_DESTINATION_TYPES, CTA_DESTINATION_TYPE_LABELS } from '@/lib/resources/cta/types';
import type { CtaDestinationType, CtaRow } from '@/lib/resources/cta/types';

const DESTINATION_HINTS: Record<CtaDestinationType, string> = {
  internal_resource: 'A path starting with /resources/, e.g. /resources/emergency-fund-guide',
  fhip_module: 'A verified FHIP module route, e.g. /dashboard, /goals, /forecast/net-worth',
  registration: '/signup or /login',
  external: 'A full https:// URL',
  youtube: 'A full https://youtube.com or https://youtu.be URL',
};

export function CtaForm({ initial, ctaId }: { initial?: CtaRow; ctaId?: string }) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? '');
  const [label, setLabel] = useState(initial?.label ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [destinationType, setDestinationType] = useState<CtaDestinationType>(initial?.destination_type ?? 'internal_resource');
  const [destinationUrl, setDestinationUrl] = useState(initial?.destination_url ?? '');
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setServerError(null);
    setErrors({});
    try {
      const body = { name, label, description, destination_type: destinationType, destination_url: destinationUrl, is_active: isActive };
      const res = await fetch(ctaId ? `/api/admin/resources/ctas/${ctaId}` : '/api/admin/resources/ctas', {
        method: ctaId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        if (json.fields) setErrors(json.fields);
        setServerError(json.error ?? 'Could not save this CTA.');
        return;
      }
      router.push('/admin/resources/ctas');
      router.refresh();
    } catch {
      setServerError('Something went wrong. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-4">
      {serverError && (
        <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {serverError}
        </div>
      )}

      <div>
        <label htmlFor="cta-name" className="mb-1 block text-sm font-medium text-ink">
          Internal Name
        </label>
        <input id="cta-name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-compact border border-line px-3 py-2 text-sm" />
        {errors.name && <p className="mt-1 text-xs text-risk">{errors.name}</p>}
      </div>

      <div>
        <label htmlFor="cta-label" className="mb-1 block text-sm font-medium text-ink">
          Public Label
        </label>
        <input id="cta-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Check Your Financial Health" className="w-full rounded-compact border border-line px-3 py-2 text-sm" />
        {errors.label && <p className="mt-1 text-xs text-risk">{errors.label}</p>}
      </div>

      <div>
        <label htmlFor="cta-description" className="mb-1 block text-sm font-medium text-ink">
          Description / helper text (internal)
        </label>
        <textarea id="cta-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} className="w-full rounded-compact border border-line px-3 py-2 text-sm" />
      </div>

      <div>
        <label htmlFor="cta-destination-type" className="mb-1 block text-sm font-medium text-ink">
          Destination Type
        </label>
        <select id="cta-destination-type" value={destinationType} onChange={(e) => setDestinationType(e.target.value as CtaDestinationType)} className="w-full rounded-compact border border-line bg-white px-3 py-2 text-sm">
          {CTA_DESTINATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {CTA_DESTINATION_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="cta-destination-url" className="mb-1 block text-sm font-medium text-ink">
          Destination
        </label>
        <input id="cta-destination-url" value={destinationUrl} onChange={(e) => setDestinationUrl(e.target.value)} className="w-full rounded-compact border border-line px-3 py-2 text-sm" aria-describedby="cta-destination-hint" />
        <p id="cta-destination-hint" className="mt-1 text-xs text-muted">
          {DESTINATION_HINTS[destinationType]}
        </p>
        {errors.destination_url && <p className="mt-1 text-xs text-risk">{errors.destination_url}</p>}
      </div>

      <div className="flex items-center gap-2">
        <input id="cta-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border-line text-trust focus:ring-trust" />
        <label htmlFor="cta-active" className="text-sm text-ink">
          Active (visible on public content)
        </label>
      </div>

      <div className="flex items-center gap-3 pt-2">
        <button type="submit" disabled={saving} className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
          {saving ? 'Saving…' : ctaId ? 'Save Changes' : 'Create CTA'}
        </button>
        <button type="button" onClick={() => router.push('/admin/resources/ctas')} className="text-sm font-semibold text-muted hover:text-ink">
          Cancel
        </button>
      </div>
    </form>
  );
}
