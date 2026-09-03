'use client';

// R1.6 CTA Library create/edit form — spec §42-43, §52, §93.

// Admin A0.2 Wave 5 (§8.6, §11, §19):
//   - The per-field error paragraphs were rendered but never associated with
//     their inputs — no `aria-invalid`, no `aria-describedby` — so a screen
//     reader user tabbing into a rejected field was told nothing was wrong
//     with it. Each field is now wired to its own error, and the required
//     fields are marked as required rather than only being rejected by the
//     server after submission.
//   - There was no summary when several fields failed at once, and focus
//     stayed on the submit button at the bottom of the form while the error
//     appeared at the top, potentially off-screen. Focus now moves to the
//     summary so the reason for the failure is where the user is.
//   - The server's `error` string was forwarded verbatim.
//   - Cancel discarded typed input with no warning and stayed live during a
//     save; it now confirms when there is something to lose, and is disabled
//     while the save is in flight.

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { actionFailureMessage, readJsonSafely } from '@/lib/resources/admin/resultState';
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
  const [confirmCancel, setConfirmCancel] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  const dirty =
    name !== (initial?.name ?? '') ||
    label !== (initial?.label ?? '') ||
    description !== (initial?.description ?? '') ||
    destinationType !== (initial?.destination_type ?? 'internal_resource') ||
    destinationUrl !== (initial?.destination_url ?? '') ||
    isActive !== (initial?.is_active ?? true);

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
      const json = await readJsonSafely(res);
      if (!res.ok) {
        const fields = json?.fields as Record<string, string> | undefined;
        if (fields) setErrors(fields);
        setServerError(actionFailureMessage(res.status, json, 'save this CTA'));
        // Move focus to the reason so it is not left below the fold.
        requestAnimationFrame(() => errorRef.current?.focus());
        return;
      }
      router.push('/admin/resources/ctas');
      router.refresh();
    } catch {
      setServerError('Could not reach the server, so nothing was saved. Check your connection and try again.');
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setSaving(false);
    }
  }

  const errorCount = Object.keys(errors).length;

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-4" noValidate>
      <ConfirmDialog
        open={confirmCancel}
        title="Discard your changes?"
        message="You have unsaved changes to this CTA. If you leave now they will be lost."
        confirmLabel="Discard Changes"
        cancelLabel="Keep Editing"
        destructive
        onConfirm={() => router.push('/admin/resources/ctas')}
        onCancel={() => setConfirmCancel(false)}
      />

      {serverError && (
        <div ref={errorRef} tabIndex={-1} role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          <p className="font-semibold">{serverError}</p>
          {errorCount > 0 && (
            <p className="mt-1">
              {errorCount === 1 ? 'One field needs correcting' : `${errorCount} fields need correcting`}, marked below. Nothing has been saved.
            </p>
          )}
        </div>
      )}

      <div>
        <label htmlFor="cta-name" className="mb-1 block text-sm font-medium text-ink">
          Internal Name <span className="text-risk" aria-hidden="true">*</span>
        </label>
        <input
          id="cta-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          aria-required="true"
          aria-invalid={!!errors.name}
          aria-describedby={errors.name ? 'cta-name-error' : undefined}
          className="w-full rounded-compact border border-line px-3 py-2 text-sm"
        />
        {errors.name && (
          <p id="cta-name-error" className="mt-1 text-xs text-risk">
            {errors.name}
          </p>
        )}
      </div>

      <div>
        <label htmlFor="cta-label" className="mb-1 block text-sm font-medium text-ink">
          Public Label <span className="text-risk" aria-hidden="true">*</span>
        </label>
        <input
          id="cta-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          required
          aria-required="true"
          aria-invalid={!!errors.label}
          aria-describedby={errors.label ? 'cta-label-error' : undefined}
          placeholder="e.g. Check Your Financial Health"
          className="w-full rounded-compact border border-line px-3 py-2 text-sm"
        />
        {errors.label && (
          <p id="cta-label-error" className="mt-1 text-xs text-risk">
            {errors.label}
          </p>
        )}
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
          Destination <span className="text-risk" aria-hidden="true">*</span>
        </label>
        <input
          id="cta-destination-url"
          value={destinationUrl}
          onChange={(e) => setDestinationUrl(e.target.value)}
          required
          aria-required="true"
          aria-invalid={!!errors.destination_url}
          className="w-full rounded-compact border border-line px-3 py-2 text-sm"
          aria-describedby={errors.destination_url ? 'cta-destination-hint cta-destination-error' : 'cta-destination-hint'}
        />
        <p id="cta-destination-hint" className="mt-1 text-xs text-muted">
          {DESTINATION_HINTS[destinationType]}
        </p>
        {errors.destination_url && (
          <p id="cta-destination-error" className="mt-1 text-xs text-risk">
            {errors.destination_url}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <input id="cta-active" type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="h-4 w-4 rounded border-line text-trust focus:ring-trust" />
        <label htmlFor="cta-active" className="text-sm text-ink">
          Active (visible on public content)
        </label>
      </div>

      <p className="text-xs text-muted">
        <span className="text-risk" aria-hidden="true">*</span> Required.
      </p>

      <div className="flex flex-wrap items-center gap-3 pt-2">
        <button type="submit" disabled={saving} className="min-h-11 rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
          {saving ? 'Saving…' : ctaId ? 'Save Changes' : 'Create CTA'}
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => (dirty ? setConfirmCancel(true) : router.push('/admin/resources/ctas'))}
          className="min-h-11 text-sm font-semibold text-muted hover:text-ink disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
