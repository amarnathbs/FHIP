'use client';

// R1.3 editor shell — spec §14-15, §93-95. Orchestrates the title/excerpt/
// block editor (main column) and the metadata sidebar + workflow panel
// (sidebar column), save/autosave, validation, and the unsaved-changes guard.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { TextField, TextAreaField } from './FormField';
import { BlockEditor } from './BlockEditor';
import { MetadataSidebar, type MetadataFormState } from './MetadataSidebar';
import { WorkflowPanel, type WorkflowCapabilities } from './WorkflowPanel';
import { RevisionHistoryPanel } from './RevisionHistoryPanel';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { SaveStatus, type SaveState } from './SaveStatus';
import { useUnsavedChangesGuard } from './useUnsavedChangesGuard';
import { slugify } from '@/lib/resources/editor/slug';
import { toPlainText } from '@/lib/resources/editor/richtext';
import { validateForReview, TITLE_MAX_LENGTH, EXCERPT_MAX_LENGTH } from '@/lib/resources/editor/validation';
import type { AnyBlock } from '@/lib/resources/editor/blocks';
import type { EditorPost, EditorReferenceData, PostVersionSummary, EditorSavePatch, PostVersionSnapshot } from '@/lib/resources/editor/types';
import type { ResourceStatus, ComplianceClassification } from '@/lib/resources/types';
import type { WorkflowHistoryEntry } from '@/lib/resources/admin/queries';

const AUTOSAVE_DEBOUNCE_MS = 2500;

function toMetadataForm(post: EditorPost): MetadataFormState {
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

export function ResourceEditor({
  post: initialPost,
  reference,
  initialVersions,
  initialWorkflowHistory,
  currentUserId,
  caps,
}: {
  post: EditorPost;
  reference: EditorReferenceData;
  initialVersions: PostVersionSummary[];
  initialWorkflowHistory: WorkflowHistoryEntry[];
  currentUserId: string;
  caps: WorkflowCapabilities;
}) {
  const router = useRouter();

  const [title, setTitle] = useState(initialPost.title);
  const [excerpt, setExcerpt] = useState(initialPost.excerpt ?? '');
  // `slugOverride` only holds a value once the author has directly edited
  // the slug field (slugTouched); until then the slug is a pure derived
  // value from the title (spec §19: "auto-suggestion from title") computed
  // during render, not via setState-in-effect — avoids an extra render pass
  // and the react-hooks/set-state-in-effect lint rule this codebase enforces.
  const [slugOverride, setSlugOverride] = useState(initialPost.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(initialPost.slug));
  const slug = slugTouched ? slugOverride : slugify(title);
  const [blocks, setBlocks] = useState<AnyBlock[]>((initialPost.content_blocks as AnyBlock[]) ?? []);
  const [meta, setMeta] = useState<MetadataFormState>(() => toMetadataForm(initialPost));

  const [status, setStatus] = useState<ResourceStatus>(initialPost.status);
  const [publishedAt, setPublishedAt] = useState(initialPost.published_at);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialPost.updated_at);
  const [versions, setVersions] = useState(initialVersions);
  const [workflowHistory, setWorkflowHistory] = useState(initialWorkflowHistory);

  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [changeSummary, setChangeSummary] = useState('');
  const [slugStatusMsg, setSlugStatusMsg] = useState<string | null>(null);

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  // Admin A0.2 Wave 5 (§28 "no misleading success remains"). Two linked
  // defects lived in the save path:
  //
  //  1. `doSave` began with `if (savingRef.current) return;` — a save
  //     requested while another was in flight was DROPPED silently, with no
  //     retry and no signal. The debounced autosave and a manual save race
  //     routinely, so this was reachable in normal use.
  //  2. On success it unconditionally called `setDirty(false)` and showed
  //     **Saved**, even when the operator had gone on typing while the
  //     request was in flight. Combined with (1), the editor could sit
  //     reading "Saved" with genuinely unsaved edits — the strongest form of
  //     misleading success in Admin, and a real risk of losing an author's
  //     work at the unsaved-changes guard.
  //
  // `queuedSaveRef` turns the dropped save into a queued one, and
  // `changeSeqRef` records a monotonic edit counter so completion can tell
  // whether the content changed while the request was in flight.
  const queuedSaveRef = useRef(false);
  const changeSeqRef = useRef(0);
  const doSaveRef = useRef<((createVersion: boolean) => Promise<void>) | null>(null);

  function markDirty() {
    changeSeqRef.current += 1;
    setDirty(true);
    setSaveState((s) => (s === 'error' ? s : 'dirty'));
  }

  const buildPatch = useCallback((): EditorSavePatch => {
    return {
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
      // Wave 5: the Featured checkbox was rendered and editable but never
      // sent — see EditorSavePatch in lib/resources/editor/types.ts.
      is_featured: meta.isFeatured,
      primary_cta_id: meta.primaryCtaId || null,
      secondary_cta_id: meta.secondaryCtaId || null,
      content_id: initialPost.content_id,
    };
  }, [title, slug, excerpt, blocks, meta, initialPost.content_id]);

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
      if (savingRef.current) {
        // Queue rather than drop: the caller's changes must still reach the
        // server once the in-flight request finishes.
        queuedSaveRef.current = true;
        return;
      }
      savingRef.current = true;
      const seqAtStart = changeSeqRef.current;
      setSaveState('saving');
      setSaveError(null);
      try {
        const res = await fetch(`/api/admin/resources/content/${initialPost.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patch: buildPatch(),
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
        // Only claim "Saved" if nothing changed while the request was in
        // flight. If it did, the content on screen is genuinely NOT what was
        // just persisted, so the editor stays dirty and queues another save.
        if (changeSeqRef.current === seqAtStart) {
          setDirty(false);
          setSaveState('saved');
        } else {
          setSaveState('dirty');
          queuedSaveRef.current = true;
        }
        if (createVersion) {
          setChangeSummary('');
          fetch(`/api/admin/resources/content/${initialPost.id}/versions`)
            .then((r) => r.json())
            .then((j) => j.data && setVersions(j.data))
            .catch(() => {});
        }
      } catch {
        setSaveState('error');
        setSaveError('Could not reach the server. Check your connection and try again.');
      } finally {
        savingRef.current = false;
        // Drain the queue. Always a non-version save: a queued follow-up is
        // catching the edits made during the previous request, not a second
        // deliberate "record a revision" action.
        if (queuedSaveRef.current) {
          queuedSaveRef.current = false;
          void doSaveRef.current?.(false);
        }
      }
    },
    [buildPatch, buildSnapshot, changeSummary, initialPost.id, lastUpdatedAt, meta.categoryIds, meta.tagIds]
  );

  // Keeps the queue-drain above pointing at the current closure, so a
  // follow-up save sends the LATEST content rather than a stale snapshot.
  // Assigned in an effect, not during render — writing a ref during render
  // is exactly what react-hooks/refs forbids.
  useEffect(() => {
    doSaveRef.current = doSave;
  }, [doSave]);

  // Debounced autosave — never on the very first render, only after a real
  // change (spec §38: "debounced autosave after meaningful changes").
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
  }, [dirty, title, excerpt, slug, blocks, meta]);

  const { promptOpen, confirmNavigate, cancelNavigate } = useUnsavedChangesGuard(dirty);

  async function handleTransition(toStatus: ResourceStatus, reason?: string, notes?: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/admin/resources/content/${initialPost.id}/workflow`, {
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
    setPublishedAt(json.data.published_at);
    setLastUpdatedAt(json.data.updated_at);
    router.refresh();
    fetch(`/api/admin/resources/content/${initialPost.id}/versions`)
      .then((r) => r.json())
      .then((j) => j.data && setVersions(j.data))
      .catch(() => {});
    // Refetch workflow history via the editor GET endpoint's sibling data —
    // simplest is a lightweight direct query through the content detail
    // route isn't available client-side, so re-derive from the response's
    // implied transition instead of an extra round trip.
    setWorkflowHistory((prev) => [
      { id: `local-${Date.now()}`, from_status: prev[0]?.to_status ?? null, to_status: toStatus, actor_role: null, action: 'status_transition', reason: reason ?? null, created_at: new Date().toISOString() },
      ...prev,
    ]);
    return { ok: true };
  }

  const reviewCheck = useMemo(
    () =>
      validateForReview({
        title,
        slug,
        excerpt,
        content_type: initialPost.content_type,
        jurisdiction: meta.jurisdiction,
        primary_category_id: meta.primaryCategoryId || null,
        author_id: meta.authorId || null,
        compliance_classification: meta.complianceClassification,
        content_blocks: blocks,
        seo_title: meta.seoTitle,
        seo_description: meta.seoDescription,
      }),
    [title, slug, excerpt, initialPost.content_type, meta, blocks]
  );

  const excerptPlain = toPlainText(excerpt);

  return (
    <div className="space-y-4 pb-24">
      <ConfirmDialog
        open={promptOpen}
        title="Leave without saving?"
        message="You have unsaved changes. If you leave now, they will be lost."
        confirmLabel="Leave Without Saving"
        cancelLabel="Stay on This Page"
        destructive
        onConfirm={confirmNavigate}
        onCancel={cancelNavigate}
      />
      <ConfirmDialog
        open={conflict}
        title="This Resource was updated elsewhere"
        message="Someone else saved changes to this Resource since you loaded it. Reload the page before saving your changes, or you will lose them."
        confirmLabel="Reload Now"
        cancelLabel="Not Yet"
        destructive
        onConfirm={() => window.location.reload()}
        onCancel={() => setConflict(false)}
      />

      {/* Bleed-to-edge sticky bar: the negative margin here must cancel
          exactly the horizontal padding AppShell's <main> applies (px-4
          below lg, px-8 at lg+ — see components/ui/AppShell.tsx), not an
          sm: breakpoint. The two must move together; an sm:-mx-6/sm:px-6
          pairing (fixed in the R1.3 closure pass, see
          docs/resources/R1.3-closure-pass-final-acceptance-report.md) went
          out of sync with <main>'s own lg: breakpoint and cost 8px of
          horizontal overflow for every viewport in [640, 1023]. */}
      <div className="sticky top-0 z-10 -mx-4 border-b border-line bg-app/95 px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8">
        <nav aria-label="Breadcrumb" className="text-xs text-muted">
          <Link href="/admin/resources" className="hover:text-trust hover:underline">
            Resources
          </Link>{' '}
          &gt;{' '}
          <Link href="/admin/resources/content" className="hover:text-trust hover:underline">
            All Content
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
          {/* §12: the header cluster could not wrap, so at ~360px the
              "Save failed / Your latest changes could not be saved. / Retry
              Save" combination overflowed horizontally. */}
          <div className="flex flex-wrap items-center gap-3">
            <SaveStatus state={saveState} onRetry={() => doSave(false)} />
            <Link href={`/admin/resources/content/${initialPost.id}/preview`} className="inline-flex min-h-11 items-center rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-gray-50">
              Preview
            </Link>
            {/* Admin A0.2 Wave 5 (§18): this button read "Save Draft" while
                the three sibling editors that use the identical save path
                read "Save", and the shared Revision History panel told every
                one of them that "the first Save Draft will create version 1".
                "Save Draft" is also inaccurate on published content, which
                this same button saves without changing its status. All four
                now use one label that describes what actually happens. */}
            <button type="button" onClick={() => doSave(true)} disabled={saveState === 'saving'} className="min-h-11 rounded-full bg-trust px-4 py-1.5 text-sm font-semibold text-white hover:bg-trust/90 disabled:opacity-50">
              {saveState === 'saving' ? 'Saving…' : 'Save Changes'}
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
            <TextField
              label="Title"
              value={title}
              onChange={(v) => {
                setTitle(v);
                markDirty();
              }}
              required
              maxLength={TITLE_MAX_LENGTH}
              error={fieldErrors.title || reviewCheck.errors.title}
              hint="Displayed as this content's H1 — do not add another H1 inside the body content."
            />
            <div className="mt-4">
              <TextField
                label="Slug"
                value={slug}
                onChange={(v) => {
                  setSlugOverride(slugify(v));
                  setSlugTouched(true);
                  setSlugStatusMsg(null);
                  markDirty();
                }}
                error={fieldErrors.slug || reviewCheck.errors.slug}
                hint={publishedAt ? 'This content is published — changing the slug changes its public URL.' : 'Auto-generated from the title. You can override it before publication.'}
              />
              {slugStatusMsg && <p className="mt-1 text-xs text-muted">{slugStatusMsg}</p>}
              <button
                type="button"
                className="mt-1 text-xs font-semibold text-trust hover:underline"
                onClick={async () => {
                  if (!slug) return;
                  setSlugStatusMsg('Checking…');
                  const res = await fetch(`/api/admin/resources/content/${initialPost.id}/slug-check?slug=${encodeURIComponent(slug)}`);
                  const json = await res.json();
                  if (!res.ok) {
                    setSlugStatusMsg('Could not check slug availability.');
                    return;
                  }
                  if (!json.data.validFormat) setSlugStatusMsg('Slug format is invalid — use lowercase letters, numbers and hyphens only.');
                  else setSlugStatusMsg(json.data.slugAvailable ? 'This slug is available.' : 'This slug is already taken.');
                }}
              >
                Check availability
              </button>
            </div>
            <div className="mt-4">
              <TextAreaField
                label="Excerpt / Summary"
                value={excerpt}
                onChange={(v) => {
                  setExcerpt(v);
                  markDirty();
                }}
                maxLength={EXCERPT_MAX_LENGTH}
                rows={3}
                hint="Briefly explain what the reader will learn."
                error={fieldErrors.excerpt || reviewCheck.errors.excerpt}
              />
              <p className="mt-1 text-xs text-muted">{excerptPlain.length}/{EXCERPT_MAX_LENGTH} characters</p>
            </div>
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Content</h2>
            {reviewCheck.errors.content_blocks && (
              <p role="alert" className="mb-3 text-xs font-medium text-risk">
                {reviewCheck.errors.content_blocks}
              </p>
            )}
            <BlockEditor
              blocks={blocks}
              onChange={(b) => {
                setBlocks(b);
                markDirty();
              }}
            />
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <label htmlFor="change-summary" className="block text-sm font-medium text-ink">
              Change Summary (optional)
            </label>
            <p className="mt-0.5 text-xs text-muted">Recorded with your next Save Changes — e.g. &quot;Added retirement example and updated ATO references.&quot;</p>
            <input
              id="change-summary"
              type="text"
              value={changeSummary}
              onChange={(e) => setChangeSummary(e.target.value)}
              maxLength={300}
              className="mt-1 block w-full rounded-compact border border-line px-3 py-2 text-sm"
            />
          </div>
        </div>

        <div className="space-y-4">
          <MetadataSidebar
            form={meta}
            onChange={(patch) => {
              setMeta((m) => ({ ...m, ...patch }));
              markDirty();
            }}
            categories={reference.categories}
            tags={reference.tags}
            authors={reference.authors}
            reviewers={reference.reviewers}
            complianceReviewers={reference.complianceReviewers}
            ctas={reference.ctas}
            errors={{ ...fieldErrors, ...reviewCheck.errors }}
            slugStatus={undefined}
            canManageUsers={caps.canManage}
            canManageCtas={caps.canManage}
          />
          <AdminTaskHelp taskId="ADM-09" />
          <WorkflowPanel status={status} compliance={meta.complianceClassification as ComplianceClassification} caps={caps} history={workflowHistory} hasUnsavedChanges={dirty} onTransition={handleTransition} />
          <RevisionHistoryPanel versions={versions} currentUserId={currentUserId} />
          <p className="text-xs text-muted">Content ID: {initialPost.content_id ?? 'Not assigned (set by import, not editable here).'}</p>
        </div>
      </div>
    </div>
  );
}
