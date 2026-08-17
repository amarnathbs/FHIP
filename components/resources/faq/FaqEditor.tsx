'use client';

// R1.4 FAQ create/edit form — spec §34-39. FAQs have no draft/review/publish
// workflow (not a resource_post — spec §32/§54), so this is a single form
// component used by both /faqs/new and /faqs/[id]/edit, not a
// ResourceEditor-style multi-panel shell. Explicit Save only — no autosave
// (spec §56, documented in lib/resources/faq/mutations.ts's header).

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { TextField, TextAreaField, SelectField, CheckboxField } from '@/components/resources/editor/FormField';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { JURISDICTION_LABELS, JURISDICTION_VALUES } from '@/lib/resources/admin/labels';
import { QUESTION_MAX_LENGTH, SHORT_ANSWER_MAX_LENGTH } from '@/lib/resources/faq/validation';
import type { FaqRow, FaqLinkedPost } from '@/lib/resources/faq/types';
import type { RelatedRef } from '@/lib/resources/admin/queries';

const COMPLIANCE_OPTIONS = [
  { value: 'green', label: 'GREEN — General Education' },
  { value: 'amber', label: 'AMBER — Additional Review Required' },
  { value: 'red', label: 'RED — Restricted' },
];

export function FaqEditor({ faq, categories, linkedPosts }: { faq: FaqRow | null; categories: RelatedRef[]; linkedPosts: FaqLinkedPost[] }) {
  const router = useRouter();
  const isNew = !faq;

  const [question, setQuestion] = useState(faq?.question ?? '');
  const [shortAnswer, setShortAnswer] = useState(faq?.short_answer ?? '');
  const [jurisdiction, setJurisdiction] = useState(faq?.jurisdiction ?? 'global');
  const [categoryId, setCategoryId] = useState(faq?.category_id ?? '');
  const [isActive, setIsActive] = useState(faq?.is_active ?? true);
  const [compliance, setCompliance] = useState(faq?.compliance_classification ?? 'green');

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);

  const [linkSearch, setLinkSearch] = useState('');
  const [linkResults, setLinkResults] = useState<{ id: string; title: string; content_type: string }[]>([]);
  const [links, setLinks] = useState<FaqLinkedPost[]>(linkedPosts);
  const [deleteImpact, setDeleteImpact] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      const body = { question, short_answer: shortAnswer, answer_blocks: faq?.answer_blocks ?? [], jurisdiction, is_active: isActive, category_id: categoryId || null, compliance_classification: compliance };
      if (isNew) {
        const res = await fetch('/api/admin/resources/faqs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const json = await res.json();
        if (res.status === 422) {
          setFieldErrors(json.fields ?? {});
          setError(json.error ?? 'Please fix the highlighted fields.');
          return;
        }
        if (!res.ok) throw new Error(json.error ?? 'Could not create this FAQ.');
        router.push(`/admin/resources/faqs/${json.data.id}/edit`);
        return;
      }
      const res = await fetch(`/api/admin/resources/faqs/${faq.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, expectedUpdatedAt: faq.updated_at }),
      });
      const json = await res.json();
      if (res.status === 409) {
        setConflict(true);
        return;
      }
      if (res.status === 422) {
        setFieldErrors(json.fields ?? {});
        setError(json.error ?? 'Please fix the highlighted fields.');
        return;
      }
      if (!res.ok) throw new Error(json.error ?? 'Could not save this FAQ.');
      setSaved(true);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setSaving(false);
    }
  }

  async function searchLinkable(q: string) {
    setLinkSearch(q);
    if (!q.trim()) {
      setLinkResults([]);
      return;
    }
    const res = await fetch(`/api/admin/resources/faqs/search-posts?q=${encodeURIComponent(q)}`);
    const json = await res.json();
    if (res.ok) setLinkResults(json.data ?? []);
  }

  async function linkPost(postId: string, title: string, contentType: string) {
    if (!faq) return;
    const res = await fetch(`/api/admin/resources/faqs/${faq.id}/links`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ postId }) });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error ?? 'Could not link this FAQ.');
      return;
    }
    setLinks((prev) => [...prev, { post_id: postId, title, content_type: contentType, status: '', sort_order: prev.length }]);
  }

  async function unlinkPost(postId: string) {
    if (!faq) return;
    await fetch(`/api/admin/resources/faqs/${faq.id}/links?postId=${postId}`, { method: 'DELETE' });
    setLinks((prev) => prev.filter((l) => l.post_id !== postId));
  }

  async function confirmDelete() {
    if (!faq) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/resources/faqs/${faq.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (res.status === 409) {
        setDeleteImpact(null);
        setError(json.error);
        return;
      }
      if (!res.ok) throw new Error(json.error ?? 'Could not delete this FAQ.');
      router.push('/admin/resources/faqs');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4 pb-24">
      <ConfirmDialog
        open={conflict}
        title="This FAQ was updated elsewhere"
        message="Someone else saved changes to this FAQ since you loaded it. Reload the page before saving your changes, or you will lose them."
        confirmLabel="Reload Now"
        cancelLabel="Not Yet"
        destructive
        onConfirm={() => window.location.reload()}
        onCancel={() => setConflict(false)}
      />
      <ConfirmDialog
        open={deleteImpact !== null}
        title="Delete this FAQ?"
        message={deleteImpact ?? ''}
        confirmLabel={deleting ? 'Deleting…' : 'Delete FAQ'}
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setDeleteImpact(null)}
      />

      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/faqs" className="hover:text-trust hover:underline">
          FAQs
        </Link>{' '}
        &gt; <span className="text-ink">{isNew ? 'New FAQ' : 'Edit FAQ'}</span>
      </nav>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-ink">{isNew ? 'New FAQ' : 'Edit FAQ'}</h1>
        <div className="flex items-center gap-3">
          {saved && (
            <span role="status" className="text-sm font-medium text-positive">
              Saved
            </span>
          )}
          <button type="button" onClick={save} disabled={saving} className="rounded-full bg-trust px-4 py-1.5 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {error}
        </p>
      )}

      <div className="rounded-card border border-line bg-white p-4 space-y-4">
        <TextField label="Question" value={question} onChange={setQuestion} required maxLength={QUESTION_MAX_LENGTH} error={fieldErrors.question} />
        <TextAreaField label="Short Answer" value={shortAnswer} onChange={setShortAnswer} required maxLength={SHORT_ANSWER_MAX_LENGTH} rows={4} hint="Must stand alone — avoid 'see above' or 'as explained earlier'. A FAQ may appear independently on several pages." error={fieldErrors.short_answer} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Jurisdiction" value={jurisdiction} onChange={setJurisdiction} options={JURISDICTION_VALUES.map((j) => ({ value: j, label: JURISDICTION_LABELS[j] }))} error={fieldErrors.jurisdiction} required />
          <SelectField label="Category" value={categoryId} onChange={setCategoryId} options={categories.map((c) => ({ value: c.id, label: c.name }))} allowBlank blankLabel="None" />
        </div>

        <div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink">Compliance Classification</legend>
            <div className="flex flex-wrap gap-3">
              {COMPLIANCE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-ink">
                  <input type="radio" name="faq-compliance" checked={compliance === opt.value} onChange={() => setCompliance(opt.value)} className="h-4 w-4 text-trust focus:ring-trust" />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <CheckboxField label="Active" checked={isActive} onChange={setIsActive} hint="Inactive FAQs are hidden from public surfaces but remain editable." />
      </div>

      {!isNew && faq && (
        <div className="rounded-card border border-line bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold text-ink">Linked Content</h2>
          {links.length === 0 ? (
            <p className="text-sm text-muted">Not linked to any content yet.</p>
          ) : (
            <ul className="space-y-2">
              {links.map((l) => (
                <li key={l.post_id} className="flex items-center justify-between gap-2 rounded-compact border border-line p-2 text-sm">
                  <span>
                    {l.title} <span className="text-xs text-muted">({l.content_type})</span>
                  </span>
                  <button type="button" onClick={() => unlinkPost(l.post_id)} className="text-xs font-semibold text-risk hover:underline">
                    Unlink
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <label htmlFor="faq-link-search" className="block text-sm font-medium text-ink">
              Link to content
            </label>
            <input id="faq-link-search" type="search" value={linkSearch} onChange={(e) => searchLinkable(e.target.value)} placeholder="Search content by title…" className="mt-1 block w-full max-w-sm rounded-compact border border-line px-3 py-2 text-sm" />
            {linkResults.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto rounded-compact border border-line p-2">
                {linkResults
                  .filter((r) => !links.some((l) => l.post_id === r.id))
                  .map((r) => (
                    <li key={r.id}>
                      <button type="button" onClick={() => linkPost(r.id, r.title, r.content_type)} className="text-sm text-trust hover:underline">
                        + {r.title} <span className="text-xs text-muted">({r.content_type})</span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          <div className="border-t border-line pt-3">
            <button
              type="button"
              onClick={() => setDeleteImpact(links.length > 0 ? `This FAQ is linked to ${links.length} piece${links.length === 1 ? '' : 's'} of content. Consider marking it inactive instead of deleting it.` : 'This FAQ has no linked content and can be safely deleted.')}
              className="text-sm font-semibold text-risk hover:underline"
            >
              Delete FAQ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
