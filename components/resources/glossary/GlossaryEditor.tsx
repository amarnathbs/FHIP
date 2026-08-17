'use client';

// R1.4 Glossary editor — spec §26-31. Term -> title, Short Definition ->
// excerpt, Detailed Explanation/Example -> content_blocks (R1.3's
// BlockEditor, unmodified), Aliases -> AliasesEditor, Related Terms ->
// RelatedTermsPicker. Reuses every other R1.3 shared primitive unmodified.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { TextField, TextAreaField } from '@/components/resources/editor/FormField';
import { BlockEditor } from '@/components/resources/editor/BlockEditor';
import { MetadataSidebar, type MetadataFormState } from '@/components/resources/editor/MetadataSidebar';
import { WorkflowPanel, type WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';
import { RevisionHistoryPanel } from '@/components/resources/editor/RevisionHistoryPanel';
import { SaveStatus, type SaveState } from '@/components/resources/editor/SaveStatus';
import { useUnsavedChangesGuard } from '@/components/resources/editor/useUnsavedChangesGuard';
import { AliasesEditor } from '@/components/resources/specialist/AliasesEditor';
import { RelatedTermsPicker } from '@/components/resources/specialist/RelatedTermsPicker';
import { slugify } from '@/lib/resources/editor/slug';
import { SHORT_DEFINITION_MAX_LENGTH, validateGlossaryForReview } from '@/lib/resources/glossary/validation';
import { TITLE_MAX_LENGTH } from '@/lib/resources/editor/validation';
import type { AnyBlock } from '@/lib/resources/editor/blocks';
import type { EditorSavePatch, PostVersionSnapshot, EditorReferenceData, PostVersionSummary, RelatedOption } from '@/lib/resources/editor/types';
import type { GlossaryEditorPost } from '@/lib/resources/glossary/types';
import type { ResourceStatus, ComplianceClassification } from '@/lib/resources/types';
import type { WorkflowHistoryEntry } from '@/lib/resources/admin/queries';

const AUTOSAVE_DEBOUNCE_MS = 2500;

function toMetadataForm(post: GlossaryEditorPost): MetadataFormState {
  return {
    primaryCategoryId: post.primary_category_id ?? '',
    categoryIds: post.categories.map((c) => c.id),
    tagIds: post.tags.map((t) => t.id),
    jurisdiction: post.jurisdiction,
    difficulty: post.difficulty ?? '',
    freshnessType: post.freshness_type,
    visibility: post.visibility,
    isFeatured: post.is_featured,
    complianceClassification: post.compliance_classification,
    authorId: post.author_id ?? '',
    reviewerId: post.reviewer_id ?? '',
    complianceReviewerId: post.compliance_reviewer_id ?? '',
    seoTitle: post.seo_title ?? '',
    seoDescription: post.seo_description ?? '',
    canonicalUrl: post.canonical_url ?? '',
    isIndexable: post.is_indexable,
    primaryCtaId: post.primary_cta_id ?? '',
    secondaryCtaId: post.secondary_cta_id ?? '',
    expiresAt: post.expires_at ? post.expires_at.slice(0, 10) : '',
    nextReviewAt: post.next_review_at ? post.next_review_at.slice(0, 10) : '',
  };
}

export function GlossaryEditor({
  post: initialPost,
  reference,
  termOptions,
  initialVersions,
  initialWorkflowHistory,
  currentUserId,
  caps,
}: {
  post: GlossaryEditorPost;
  reference: EditorReferenceData;
  termOptions: RelatedOption[];
  initialVersions: PostVersionSummary[];
  initialWorkflowHistory: WorkflowHistoryEntry[];
  currentUserId: string;
  caps: WorkflowCapabilities;
}) {
  const router = useRouter();

  const [title, setTitle] = useState(initialPost.title);
  const [excerpt, setExcerpt] = useState(initialPost.excerpt ?? '');
  const [slugOverride, setSlugOverride] = useState(initialPost.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(initialPost.slug));
  const slug = slugTouched ? slugOverride : slugify(title);
  const [blocks, setBlocks] = useState<AnyBlock[]>((initialPost.content_blocks as AnyBlock[]) ?? []);
  const [aliases, setAliases] = useState<string[]>(initialPost.aliases ?? []);
  const [relatedTermIds, setRelatedTermIds] = useState<string[]>(initialPost.relatedTerms.map((t) => t.id));
  const [meta, setMeta] = useState<MetadataFormState>(() => toMetadataForm(initialPost));

  const [status, setStatus] = useState<ResourceStatus>(initialPost.status);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialPost.updated_at);
  const [versions, setVersions] = useState(initialVersions);
  const [workflowHistory, setWorkflowHistory] = useState(initialWorkflowHistory);

  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [changeSummary, setChangeSummary] = useState('');
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const similarCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function markDirty() {
    setDirty(true);
    setSaveState((s) => (s === 'error' ? s : 'dirty'));
  }

  // Spec §29 check-as-you-type: debounced similar-term lookup, warning only
  // (never blocks typing) — the hard exact-duplicate reject happens
  // server-side on save. The "title too short to check" case is handled by
  // gating what's *rendered* (see `titleLongEnoughToCheck` below), not by
  // calling setState synchronously inside this effect — a bare
  // `setDuplicateWarning(null)` in the effect body would trigger an
  // avoidable extra render pass (react-hooks/set-state-in-effect), the same
  // reasoning ResourceEditor.tsx documents for deriving its slug from title
  // during render instead of via a matching effect.
  const titleLongEnoughToCheck = title.trim().length >= 3;
  useEffect(() => {
    if (similarCheckTimer.current) clearTimeout(similarCheckTimer.current);
    if (!titleLongEnoughToCheck) return;
    similarCheckTimer.current = setTimeout(() => {
      fetch(`/api/admin/resources/glossary/similar?term=${encodeURIComponent(title.trim())}&excludeId=${initialPost.id}`)
        .then((r) => r.json())
        .then((j) => {
          const matches = (j.data ?? []) as { title: string }[];
          setDuplicateWarning(matches.length > 0 ? `Similar term${matches.length > 1 ? 's' : ''} already exist: ${matches.map((m) => m.title).join(', ')}` : null);
        })
        .catch(() => {});
    }, 500);
    return () => {
      if (similarCheckTimer.current) clearTimeout(similarCheckTimer.current);
    };
  }, [title, titleLongEnoughToCheck, initialPost.id]);

  const buildPatch = useCallback(
    (): EditorSavePatch => ({
      title,
      slug: slug || null,
      excerpt: excerpt || null,
      content_blocks: blocks,
      jurisdiction: meta.jurisdiction,
      difficulty: meta.difficulty || null,
      freshness_type: meta.freshnessType,
      visibility: meta.visibility,
      compliance_classification: meta.complianceClassification,
      primary_category_id: meta.primaryCategoryId || null,
      author_id: meta.authorId || null,
      reviewer_id: meta.reviewerId || null,
      compliance_reviewer_id: meta.complianceReviewerId || null,
      expires_at: meta.expiresAt || null,
      next_review_at: meta.nextReviewAt || null,
      seo_title: meta.seoTitle || null,
      seo_description: meta.seoDescription || null,
      canonical_url: meta.canonicalUrl || null,
      is_indexable: meta.isIndexable,
      primary_cta_id: meta.primaryCtaId || null,
      secondary_cta_id: meta.secondaryCtaId || null,
      content_id: initialPost.content_id,
    }),
    [title, slug, excerpt, blocks, meta, initialPost.content_id]
  );

  const buildSnapshot = useCallback((): PostVersionSnapshot => {
    const patch = buildPatch();
    return {
      title: patch.title,
      slug: patch.slug,
      excerpt: patch.excerpt,
      content_type: initialPost.content_type,
      content_blocks: patch.content_blocks,
      jurisdiction: patch.jurisdiction,
      difficulty: patch.difficulty,
      freshness_type: patch.freshness_type,
      visibility: patch.visibility,
      compliance_classification: patch.compliance_classification,
      primary_category_id: patch.primary_category_id,
      category_ids: meta.categoryIds,
      tag_ids: meta.tagIds,
      author_id: patch.author_id,
      reviewer_id: patch.reviewer_id,
      compliance_reviewer_id: patch.compliance_reviewer_id,
      seo_title: patch.seo_title,
      seo_description: patch.seo_description,
      canonical_url: patch.canonical_url,
      is_indexable: patch.is_indexable,
      primary_cta_id: patch.primary_cta_id,
      secondary_cta_id: patch.secondary_cta_id,
    };
  }, [buildPatch, initialPost.content_type, meta.categoryIds, meta.tagIds]);

  const doSave = useCallback(
    async (createVersion: boolean) => {
      if (savingRef.current) return;
      savingRef.current = true;
      setSaveState('saving');
      setSaveError(null);
      try {
        const res = await fetch(`/api/admin/resources/glossary/${initialPost.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patch: buildPatch(),
            aliases,
            relatedTermIds,
            categoryIds: meta.categoryIds,
            tagIds: meta.tagIds,
            expectedUpdatedAt: lastUpdatedAt,
            createVersion,
            changeSummary: createVersion ? changeSummary : undefined,
            versionSnapshot: createVersion ? buildSnapshot() : undefined,
          }),
        });
        const json = await res.json();
        if (res.status === 409) {
          setConflict(true);
          setSaveState('error');
          return;
        }
        if (res.status === 422) {
          setFieldErrors(json.fields ?? {});
          setSaveState('error');
          setSaveError(json.error ?? 'Please fix the highlighted fields.');
          return;
        }
        if (!res.ok) {
          setSaveState('error');
          setSaveError(json.error ?? 'Could not save your changes.');
          return;
        }
        setFieldErrors({});
        setLastUpdatedAt(json.data.updated_at);
        setDirty(false);
        setSaveState('saved');
        if (createVersion) {
          setChangeSummary('');
          fetch(`/api/admin/resources/glossary/${initialPost.id}/versions`)
            .then((r) => r.json())
            .then((j) => j.data && setVersions(j.data))
            .catch(() => {});
        }
      } catch {
        setSaveState('error');
        setSaveError('Could not reach the server. Check your connection and try again.');
      } finally {
        savingRef.current = false;
      }
    },
    [aliases, buildPatch, buildSnapshot, changeSummary, initialPost.id, lastUpdatedAt, meta.categoryIds, meta.tagIds, relatedTermIds]
  );

  useEffect(() => {
    if (!dirty) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void doSave(false);
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, title, excerpt, slug, blocks, aliases, relatedTermIds, meta]);

  const { promptOpen, confirmNavigate, cancelNavigate } = useUnsavedChangesGuard(dirty);

  async function handleTransition(toStatus: ResourceStatus, reason?: string, notes?: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/admin/resources/glossary/${initialPost.id}/workflow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toStatus, reason, notes }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const fieldMsg = json.fields ? Object.values(json.fields).join(' ') : '';
      return { ok: false, error: [json.error, fieldMsg].filter(Boolean).join(' ') || 'This workflow action could not be completed.' };
    }
    setStatus(json.data.status);
    setLastUpdatedAt(json.data.updated_at);
    router.refresh();
    fetch(`/api/admin/resources/glossary/${initialPost.id}/versions`)
      .then((r) => r.json())
      .then((j) => j.data && setVersions(j.data))
      .catch(() => {});
    setWorkflowHistory((prev) => [
      { id: `local-${Date.now()}`, from_status: prev[0]?.to_status ?? null, to_status: toStatus, actor_role: null, action: 'status_transition', reason: reason ?? null, created_at: new Date().toISOString() },
      ...prev,
    ]);
    return { ok: true };
  }

  const reviewCheck = useMemo(
    () =>
      validateGlossaryForReview({
        title,
        slug,
        excerpt,
        jurisdiction: meta.jurisdiction,
        primary_category_id: meta.primaryCategoryId || null,
        author_id: meta.authorId || null,
        compliance_classification: meta.complianceClassification,
      }),
    [title, slug, excerpt, meta]
  );

  return (
    <div className="space-y-4 pb-24">
      <ConfirmDialog open={promptOpen} title="Leave without saving?" message="You have unsaved changes. If you leave now, they will be lost." confirmLabel="Leave Without Saving" cancelLabel="Stay on This Page" destructive onConfirm={confirmNavigate} onCancel={cancelNavigate} />
      <ConfirmDialog
        open={conflict}
        title="This definition was updated elsewhere"
        message="Someone else saved changes to this glossary definition since you loaded it. Reload the page before saving your changes, or you will lose them."
        confirmLabel="Reload Now"
        cancelLabel="Not Yet"
        destructive
        onConfirm={() => window.location.reload()}
        onCancel={() => setConflict(false)}
      />

      <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-app/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
        <nav aria-label="Breadcrumb" className="text-xs text-muted">
          <Link href="/admin/resources" className="hover:text-trust hover:underline">
            Resources
          </Link>{' '}
          &gt;{' '}
          <Link href="/admin/resources/glossary" className="hover:text-trust hover:underline">
            Glossary
          </Link>{' '}
          &gt; <span className="text-ink">Edit</span>
        </nav>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ResourceTypeBadge contentType={initialPost.content_type} />
            <ResourceStatusBadge status={status} />
            <ResourceComplianceBadge compliance={meta.complianceClassification} />
            <h1 className="truncate text-lg font-semibold text-ink">{title || 'Untitled'}</h1>
          </div>
          <div className="flex items-center gap-3">
            <SaveStatus state={saveState} onRetry={() => doSave(false)} />
            <Link href={`/admin/resources/glossary/${initialPost.id}/preview`} className="rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-gray-50">
              Preview
            </Link>
            <button type="button" onClick={() => doSave(true)} disabled={saveState === 'saving'} className="rounded-full bg-trust px-4 py-1.5 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
              Save
            </button>
          </div>
        </div>
        {saveError && saveState === 'error' && !conflict && (
          <p role="alert" className="mt-1 text-xs text-risk">
            {saveError}
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <div className="rounded-card border border-line bg-white p-4">
            <TextField label="Term" value={title} onChange={(v) => { setTitle(v); markDirty(); }} required maxLength={TITLE_MAX_LENGTH} error={fieldErrors.title || reviewCheck.errors.title} hint="e.g. Savings Rate" />
            {titleLongEnoughToCheck && duplicateWarning && !fieldErrors.title && (
              <p role="status" className="mt-1 text-xs font-medium text-attention">
                {duplicateWarning}
              </p>
            )}
            <div className="mt-4">
              <TextField label="Slug" value={slug} onChange={(v) => { setSlugOverride(slugify(v)); setSlugTouched(true); markDirty(); }} error={fieldErrors.slug || reviewCheck.errors.slug} />
            </div>
            <div className="mt-4">
              <TextAreaField label="Short Definition" value={excerpt} onChange={(v) => { setExcerpt(v); markDirty(); }} maxLength={SHORT_DEFINITION_MAX_LENGTH} rows={2} hint="One clear sentence." error={fieldErrors.excerpt || reviewCheck.errors.excerpt} />
            </div>
            <div className="mt-4">
              <AliasesEditor aliases={aliases} onChange={(a) => { setAliases(a); markDirty(); }} />
            </div>
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-ink">Detailed Explanation &amp; Example</h2>
            <p className="mb-3 text-xs text-muted">Optional for simple terms — plain English, avoid unexplained jargon, use a concrete example where useful.</p>
            <BlockEditor blocks={blocks} onChange={(b) => { setBlocks(b); markDirty(); }} />
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <RelatedTermsPicker options={termOptions} selected={relatedTermIds} onChange={(ids) => { setRelatedTermIds(ids); markDirty(); }} />
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <label htmlFor="change-summary" className="block text-sm font-medium text-ink">
              Change Summary (optional)
            </label>
            <input id="change-summary" type="text" value={changeSummary} onChange={(e) => setChangeSummary(e.target.value)} maxLength={300} className="mt-1 block w-full rounded-compact border border-line px-3 py-2 text-sm" />
          </div>
        </div>

        <div className="space-y-4">
          <MetadataSidebar
            form={meta}
            onChange={(patch) => { setMeta((m) => ({ ...m, ...patch })); markDirty(); }}
            categories={reference.categories}
            tags={reference.tags}
            authors={reference.authors}
            ctas={reference.ctas}
            errors={{ ...fieldErrors, ...reviewCheck.errors }}
          />
          <WorkflowPanel status={status} compliance={meta.complianceClassification as ComplianceClassification} caps={caps} history={workflowHistory} hasUnsavedChanges={dirty} onTransition={handleTransition} />
          <RevisionHistoryPanel versions={versions} currentUserId={currentUserId} />
        </div>
      </div>
    </div>
  );
}
