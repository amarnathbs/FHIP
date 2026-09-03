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
import { BlockEditor } from '@/components/resources/editor/BlockEditor';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { actionFailureMessage, readJsonSafely } from '@/lib/resources/admin/resultState';
import { CONTENT_TYPE_LABELS, JURISDICTION_LABELS, JURISDICTION_VALUES } from '@/lib/resources/admin/labels';
import type { ResourceContentType } from '@/lib/resources/types';
import { QUESTION_MAX_LENGTH, SHORT_ANSWER_MAX_LENGTH } from '@/lib/resources/faq/validation';
import type { FaqRow, FaqLinkedPost } from '@/lib/resources/faq/types';
import type { RelatedRef } from '@/lib/resources/admin/queries';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

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
  // R1.4 closure-pass fix (P1, found live-testing the Responsive Matrix
  // Completion Pass): the "Expanded Answer" (answer_blocks) field spec
  // §34-39 describes and the original completion report's §M claims was
  // delivered ("optional structured Expanded Answer") had no editor UI at
  // all — save() always sent the frozen `faq?.answer_blocks ?? []` with no
  // way to view or change it, so the field was entirely dead from the
  // admin's perspective (always empty for a new FAQ, permanently frozen at
  // whatever it started as for an existing one). Reuses R1.3's BlockEditor
  // exactly as GlossaryEditor.tsx already does for content_blocks.
  const [answerBlocks, setAnswerBlocks] = useState<AnyBlock[]>((faq?.answer_blocks as AnyBlock[]) ?? []);

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
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [unlinkNotice, setUnlinkNotice] = useState<string | null>(null);
  const [pendingUnlink, setPendingUnlink] = useState<FaqLinkedPost | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    setSaved(false);
    try {
      const body = { question, short_answer: shortAnswer, answer_blocks: answerBlocks, jurisdiction, is_active: isActive, category_id: categoryId || null, compliance_classification: compliance };
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

  // Admin A0.2 Wave 5 (§9): this never inspected the response — a failed
  // unlink removed the row from the screen anyway, so the FAQ silently kept
  // appearing on a page the operator believed they had detached it from,
  // until the next reload contradicted them. It now verifies the outcome
  // and only updates the list when the server actually accepted it.
  async function unlinkPost(postId: string, title: string) {
    if (!faq) return;
    setError(null);
    setUnlinking(postId);
    try {
      const res = await fetch(`/api/admin/resources/faqs/${faq.id}/links?postId=${postId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        const json = await readJsonSafely(res);
        setError(actionFailureMessage(res.status, json, 'unlink this FAQ'));
        return;
      }
      setLinks((prev) => prev.filter((l) => l.post_id !== postId));
      setSaved(false);
      setUnlinkNotice(`This FAQ is no longer linked to "${title}".`);
    } catch {
      setError('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setUnlinking(null);
    }
  }

  async function confirmDelete() {
    if (!faq) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/admin/resources/faqs/${faq.id}`, { method: 'DELETE' });
      const json = await res.json();
      if (res.status === 409) {
        setDeleteImpact(null);
        // Wave 5: this had no fallback, so a 409 whose body omitted `error`
        // rendered an empty red box — a visible failure with no message.
        setError(actionFailureMessage(409, json, 'delete this FAQ'));
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
      <ConfirmDialog
        open={!!pendingUnlink}
        title="Unlink this FAQ?"
        message={
          pendingUnlink
            ? `This FAQ will stop appearing on "${pendingUnlink.title}". The FAQ itself is not deleted, and you can link it again at any time.`
            : ''
        }
        confirmLabel="Unlink"
        cancelLabel="Cancel"
        destructive
        onConfirm={() => {
          const target = pendingUnlink;
          setPendingUnlink(null);
          if (target) void unlinkPost(target.post_id, target.title);
        }}
        onCancel={() => setPendingUnlink(null)}
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
        <div className="flex flex-wrap items-center gap-3">
          {/* Admin A0.2 Wave 5 (§9): `saved` was set on a successful save and
              never cleared, so the word "Saved" stayed on screen while the
              operator went on making further, unsaved edits — a standing
              claim that the current state was committed when it was not.
              It is now cleared the moment any field changes (see the
              markChanged wrapper on every input below). */}
          <span role="status" aria-live="polite" className="text-sm font-medium text-positive">
            {saved ? 'Saved' : ''}
          </span>
          <button type="button" onClick={save} disabled={saving} className="min-h-11 rounded-full bg-trust px-4 py-1.5 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      <AdminTaskHelp taskId="ADM-14" />

      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 p-3 text-sm text-risk">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite" className="text-sm text-muted">
        {unlinkNotice ?? ''}
      </p>

      <div className="rounded-card border border-line bg-white p-4 space-y-4">
        <TextField label="Question" value={question} onChange={(v) => { setSaved(false); setQuestion(v); }} required maxLength={QUESTION_MAX_LENGTH} error={fieldErrors.question} />
        <TextAreaField label="Short Answer" value={shortAnswer} onChange={(v) => { setSaved(false); setShortAnswer(v); }} required maxLength={SHORT_ANSWER_MAX_LENGTH} rows={4} hint="Must stand alone — avoid 'see above' or 'as explained earlier'. A FAQ may appear independently on several pages." error={fieldErrors.short_answer} />

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <SelectField label="Jurisdiction" value={jurisdiction} onChange={(v) => { setSaved(false); setJurisdiction(v); }} options={JURISDICTION_VALUES.map((j) => ({ value: j, label: JURISDICTION_LABELS[j] }))} error={fieldErrors.jurisdiction} required />
          <SelectField label="Category" value={categoryId} onChange={(v) => { setSaved(false); setCategoryId(v); }} options={categories.map((c) => ({ value: c.id, label: c.name }))} allowBlank blankLabel="None" />
        </div>

        <div>
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink">Compliance Classification</legend>
            <div className="flex flex-wrap gap-3">
              {COMPLIANCE_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-2 text-sm text-ink">
                  <input type="radio" name="faq-compliance" checked={compliance === opt.value} onChange={() => { setSaved(false); setCompliance(opt.value); }} className="h-4 w-4 text-trust focus:ring-trust" />
                  {opt.label}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <CheckboxField label="Active" checked={isActive} onChange={(v) => { setSaved(false); setIsActive(v); }} hint="Inactive FAQs are hidden from public surfaces but remain editable." />
      </div>

      <div className="rounded-card border border-line bg-white p-4">
        <h2 className="mb-1 text-sm font-semibold text-ink">Expanded Answer</h2>
        <p className="mb-3 text-xs text-muted">Optional structured detail beyond the Short Answer — plain English, avoid unexplained jargon.</p>
        <BlockEditor blocks={answerBlocks} onChange={(b) => { setSaved(false); setAnswerBlocks(b); }} />
      </div>

      {!isNew && faq && (
        <div className="rounded-card border border-line bg-white p-4 space-y-3">
          <h2 className="text-sm font-semibold text-ink">Linked Content</h2>
          {links.length === 0 ? (
            <p className="text-sm text-muted">Not linked to any content yet.</p>
          ) : (
            <ul className="space-y-2">
              {links.map((l) => (
                <li key={l.post_id} className="flex flex-wrap items-center justify-between gap-2 rounded-compact border border-line p-2 text-sm">
                  <span>
                    {l.title}{' '}
                    <span className="text-xs text-muted">({CONTENT_TYPE_LABELS[l.content_type as ResourceContentType] ?? l.content_type})</span>
                  </span>
                  <button
                    type="button"
                    disabled={unlinking === l.post_id}
                    onClick={() => setPendingUnlink(l)}
                    aria-label={`Unlink this FAQ from "${l.title}"`}
                    className="min-h-11 text-xs font-semibold text-risk hover:underline disabled:opacity-50"
                  >
                    {unlinking === l.post_id ? 'Unlinking…' : 'Unlink'}
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
                      <button
                        type="button"
                        onClick={() => linkPost(r.id, r.title, r.content_type)}
                        aria-label={`Link this FAQ to "${r.title}"`}
                        className="min-h-11 text-sm text-trust hover:underline"
                      >
                        + {r.title} <span className="text-xs text-muted">({CONTENT_TYPE_LABELS[r.content_type as ResourceContentType] ?? r.content_type})</span>
                      </button>
                    </li>
                  ))}
              </ul>
            )}
          </div>

          <div className="border-t border-line pt-3">
            <button
              type="button"
              onClick={() =>
                setDeleteImpact(
                  links.length > 0
                    ? `"${question || 'This FAQ'}" is linked to ${links.length} piece${links.length === 1 ? '' : 's'} of content. Deleting it cannot be undone. Consider clearing the Active checkbox instead, which hides it from public pages while keeping it editable.`
                    : `"${question || 'This FAQ'}" has no linked content and can be safely deleted. Deleting it cannot be undone.`
                )
              }
              className="min-h-11 text-sm font-semibold text-risk hover:underline"
            >
              Delete FAQ
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
