'use client';

// R1.4 Money Update creation — spec §41-45: Money Update vs Money Update
// Template, plus "Create Update from Template".

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export function MoneyUpdateNewChooser({ canCreate }: { canCreate: boolean }) {
  const router = useRouter();
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ id: string; title: string }[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');

  useEffect(() => {
    fetch('/api/admin/resources/money-updates/templates')
      .then((r) => r.json())
      .then((j) => setTemplates(j.data ?? []))
      .catch(() => {});
  }, []);

  async function createBlank(contentType: 'money_update' | 'money_update_template') {
    setCreating(contentType);
    setError(null);
    try {
      const res = await fetch('/api/admin/resources/money-updates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contentType }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create this record.');
      router.push(`/admin/resources/money-updates/${json.data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setCreating(null);
    }
  }

  async function createFromTemplate() {
    if (!selectedTemplate) return;
    setCreating('from-template');
    setError(null);
    try {
      const res = await fetch('/api/admin/resources/money-updates/from-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ templateId: selectedTemplate }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not create a Money Update from this template.');
      router.push(`/admin/resources/money-updates/${json.data.id}/edit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
      setCreating(null);
    }
  }

  if (!canCreate) {
    return (
      <div className="rounded-card border border-line bg-white p-6 text-center">
        <p className="text-sm font-semibold text-ink">You don&apos;t have permission to create a Money Update.</p>
        <Link href="/admin/resources/money-updates" className="mt-4 inline-block text-sm font-semibold text-trust hover:underline">
          Back to Money Updates
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/money-updates" className="hover:text-trust hover:underline">
          Money Updates
        </Link>{' '}
        &gt; <span className="text-ink">New</span>
      </nav>

      <div>
        <h1 className="text-2xl font-semibold text-ink">Create a Money Update</h1>
        <p className="mt-1 text-sm text-muted">Governed interpretation of a financial development — not a generic news article.</p>
      </div>

      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {error}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <button type="button" onClick={() => createBlank('money_update')} disabled={creating !== null} className="rounded-card border border-line bg-white p-5 text-left hover:border-trust hover:shadow-sm disabled:opacity-50">
          <h2 className="text-base font-semibold text-ink">Money Update</h2>
          <p className="mt-2 text-sm text-muted">A time-sensitive interpretation of a current financial development, with the full structured section set.</p>
          <p className="mt-4 text-sm font-semibold text-trust">{creating === 'money_update' ? 'Creating…' : 'Create Money Update'}</p>
        </button>
        <button type="button" onClick={() => createBlank('money_update_template')} disabled={creating !== null} className="rounded-card border border-line bg-white p-5 text-left hover:border-trust hover:shadow-sm disabled:opacity-50">
          <h2 className="text-base font-semibold text-ink">Money Update Template</h2>
          <p className="mt-2 text-sm text-muted">Reusable starter structure with guidance text — not itself a published current event.</p>
          <p className="mt-4 text-sm font-semibold text-trust">{creating === 'money_update_template' ? 'Creating…' : 'Create Template'}</p>
        </button>
      </div>

      {templates.length > 0 && (
        <div className="rounded-card border border-line bg-white p-5">
          <h2 className="text-base font-semibold text-ink">Create from an Existing Template</h2>
          <p className="mt-1 text-sm text-muted">Copies the template&apos;s structure into a new Draft Money Update with its own id and slug. The template itself is never modified.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label htmlFor="template-select" className="sr-only">
              Choose a template
            </label>
            <select id="template-select" value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)} className="rounded border border-line bg-white px-3 py-2 text-sm text-ink">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
            <button type="button" onClick={createFromTemplate} disabled={!selectedTemplate || creating !== null} className="rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
              {creating === 'from-template' ? 'Creating…' : 'Create Update from Template'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
