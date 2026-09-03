'use client';

// R1.4 @GKTC Video editor — spec §17-24. Reuses R1.3's shared editor
// primitives (MetadataSidebar/WorkflowPanel/RevisionHistoryPanel/SaveStatus/
// FormField/useUnsavedChangesGuard/ConfirmDialog/badges) unmodified — the
// only new UI here is video-specific: read-only YouTube identity, thumbnail,
// duration, YouTube publish date, transcript, chapters, and the safe embed
// preview link. No BlockEditor/content_blocks body — Video's spec §17 field
// list has no long-form structured body, only Excerpt/Description.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { TextField, TextAreaField, CheckboxField } from '@/components/resources/editor/FormField';
import { MetadataSidebar, type MetadataFormState } from '@/components/resources/editor/MetadataSidebar';
import { WorkflowPanel, type WorkflowCapabilities } from '@/components/resources/editor/WorkflowPanel';
import { RevisionHistoryPanel } from '@/components/resources/editor/RevisionHistoryPanel';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { SaveStatus, type SaveState } from '@/components/resources/editor/SaveStatus';
import { useUnsavedChangesGuard } from '@/components/resources/editor/useUnsavedChangesGuard';
import { ChapterEditor } from '@/components/resources/specialist/ChapterEditor';
import { slugify } from '@/lib/resources/editor/slug';
import { TITLE_MAX_LENGTH, EXCERPT_MAX_LENGTH } from '@/lib/resources/editor/validation';
import { validateVideoForReview } from '@/lib/resources/video/validation';
import { validateChapters, buildYouTubeWatchUrl, type VideoChapter } from '@/lib/resources/video/youtube';
import type { EditorSavePatch, PostVersionSnapshot, EditorReferenceData, PostVersionSummary } from '@/lib/resources/editor/types';
import type { VideoEditorPost } from '@/lib/resources/video/types';
import type { ResourceStatus, ComplianceClassification } from '@/lib/resources/types';
import type { WorkflowHistoryEntry } from '@/lib/resources/admin/queries';

const AUTOSAVE_DEBOUNCE_MS = 2500;

function toMetadataForm(post: VideoEditorPost): MetadataFormState {
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

export function VideoEditor({
  post: initialPost,
  reference,
  initialVersions,
  initialWorkflowHistory,
  currentUserId,
  caps,
}: {
  post: VideoEditorPost;
  reference: EditorReferenceData;
  initialVersions: PostVersionSummary[];
  initialWorkflowHistory: WorkflowHistoryEntry[];
  currentUserId: string;
  caps: WorkflowCapabilities;
}) {
  const router = useRouter();
  const video = initialPost.video;

  const [title, setTitle] = useState(initialPost.title);
  const [excerpt, setExcerpt] = useState(initialPost.excerpt ?? '');
  const [slugOverride, setSlugOverride] = useState(initialPost.slug ?? '');
  const [slugTouched, setSlugTouched] = useState(Boolean(initialPost.slug));
  const slug = slugTouched ? slugOverride : slugify(title);
  const [meta, setMeta] = useState<MetadataFormState>(() => toMetadataForm(initialPost));

  const [durationSeconds, setDurationSeconds] = useState(video?.duration_seconds != null ? String(video.duration_seconds) : '');
  const [thumbnailUrl, setThumbnailUrl] = useState(video?.thumbnail_url ?? '');
  const [youtubePublishedAt, setYoutubePublishedAt] = useState(video?.youtube_published_at ? video.youtube_published_at.slice(0, 10) : '');
  const [transcript, setTranscript] = useState(video?.transcript ?? '');
  const [chapters, setChapters] = useState<VideoChapter[]>(video?.chapters ?? []);
  const [embedEnabled, setEmbedEnabled] = useState(video?.embed_enabled ?? true);
  const [channelHandle, setChannelHandle] = useState(video?.youtube_channel_handle ?? '@GKTC');
  const [channelUrl, setChannelUrl] = useState(video?.youtube_channel_url ?? '');

  const [status, setStatus] = useState<ResourceStatus>(initialPost.status);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(initialPost.updated_at);
  const [versions, setVersions] = useState(initialVersions);
  const [workflowHistory, setWorkflowHistory] = useState(initialWorkflowHistory);

  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [chapterErrors, setChapterErrors] = useState<Record<string, string>>({});
  const [changeSummary, setChangeSummary] = useState('');

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  // Wave 5 (§28): queue a save requested during an in-flight one instead of
  // dropping it, and only claim "Saved" if nothing changed while the request
  // was in flight. See ResourceEditor for the full explanation.
  const queuedSaveRef = useRef(false);
  const changeSeqRef = useRef(0);
  const doSaveRef = useRef<((createVersion: boolean) => Promise<void>) | null>(null);

  function markDirty() {
    changeSeqRef.current += 1;
    setDirty(true);
    setSaveState((s) => (s === 'error' ? s : 'dirty'));
  }

  const buildPatch = useCallback(
    (): EditorSavePatch => ({
      title,
      slug: slug || null,
      excerpt: excerpt || null,
      content_blocks: [],
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
      // Wave 5: see EditorSavePatch in lib/resources/editor/types.ts.
      is_featured: meta.isFeatured,
      primary_cta_id: meta.primaryCtaId || null,
      secondary_cta_id: meta.secondaryCtaId || null,
      content_id: initialPost.content_id,
    }),
    [title, slug, excerpt, meta, initialPost.content_id]
  );

  const buildSnapshot = useCallback((): PostVersionSnapshot => {
    const patch = buildPatch();
    return {
      title: patch.title,
      slug: patch.slug,
      excerpt: patch.excerpt,
      content_type: initialPost.content_type,
      content_blocks: [],
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
        queuedSaveRef.current = true;
        return;
      }
      const chapterCheck = validateChapters(chapters);
      savingRef.current = true;
      const seqAtStart = changeSeqRef.current;
      setSaveState('saving');
      setSaveError(null);
      setChapterErrors(chapterCheck.errors);
      try {
        const res = await fetch(`/api/admin/resources/videos/${initialPost.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            patch: buildPatch(),
            video: {
              duration_seconds: durationSeconds ? Number.parseInt(durationSeconds, 10) : null,
              thumbnail_url: thumbnailUrl || null,
              youtube_published_at: youtubePublishedAt || null,
              transcript,
              chapters,
              embed_enabled: embedEnabled,
              youtube_channel_handle: channelHandle,
              youtube_channel_url: channelUrl || null,
            },
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
          if (json.chapterErrors) setChapterErrors(json.chapterErrors);
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
        if (changeSeqRef.current === seqAtStart) {
          setDirty(false);
          setSaveState('saved');
        } else {
          setSaveState('dirty');
          queuedSaveRef.current = true;
        }
        if (createVersion) {
          setChangeSummary('');
          fetch(`/api/admin/resources/videos/${initialPost.id}/versions`)
            .then((r) => r.json())
            .then((j) => j.data && setVersions(j.data))
            .catch(() => {});
        }
      } catch {
        setSaveState('error');
        setSaveError('Could not reach the server. Check your connection and try again.');
      } finally {
        savingRef.current = false;
        if (queuedSaveRef.current) {
          queuedSaveRef.current = false;
          void doSaveRef.current?.(false);
        }
      }
    },
    [buildPatch, buildSnapshot, changeSummary, chapters, channelHandle, channelUrl, durationSeconds, embedEnabled, initialPost.id, lastUpdatedAt, meta.categoryIds, meta.tagIds, thumbnailUrl, transcript, youtubePublishedAt]
  );

  // Assigned in an effect, not during render (react-hooks/refs).
  useEffect(() => {
    doSaveRef.current = doSave;
  }, [doSave]);

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
  }, [dirty, title, excerpt, slug, meta, durationSeconds, thumbnailUrl, youtubePublishedAt, transcript, chapters, embedEnabled, channelHandle, channelUrl]);

  const { promptOpen, confirmNavigate, cancelNavigate } = useUnsavedChangesGuard(dirty);

  async function handleTransition(toStatus: ResourceStatus, reason?: string, notes?: string): Promise<{ ok: boolean; error?: string }> {
    const res = await fetch(`/api/admin/resources/videos/${initialPost.id}/workflow`, {
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
    fetch(`/api/admin/resources/videos/${initialPost.id}/versions`)
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
      validateVideoForReview({
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

  if (!video) {
    return (
      <div role="alert" className="rounded-card border border-risk/30 bg-risk/5 p-6 text-center text-sm text-risk">
        This video record is missing its YouTube details and cannot be edited safely. Contact a Resource Administrator.
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-24">
      <ConfirmDialog open={promptOpen} title="Leave without saving?" message="You have unsaved changes. If you leave now, they will be lost." confirmLabel="Leave Without Saving" cancelLabel="Stay on This Page" destructive onConfirm={confirmNavigate} onCancel={cancelNavigate} />
      <ConfirmDialog
        open={conflict}
        title="This video was updated elsewhere"
        message="Someone else saved changes to this video since you loaded it. Reload the page before saving your changes, or you will lose them."
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
          <Link href="/admin/resources/videos" className="hover:text-trust hover:underline">
            Videos
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
          {/* Wave 5 (§12, §18): the cluster now wraps, and the save label
              matches every other content editor. */}
          <div className="flex flex-wrap items-center gap-3">
            <SaveStatus state={saveState} onRetry={() => doSave(false)} />
            <Link href={`/admin/resources/videos/${initialPost.id}/preview`} className="inline-flex min-h-11 items-center rounded-full border border-line px-3 py-1.5 text-sm font-semibold text-ink hover:bg-gray-50">
              Preview
            </Link>
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
            <p className="mb-3 rounded-compact border border-line bg-gray-50 px-3 py-2 text-xs text-muted">
              Hosted on <span className="font-semibold text-ink">@GKTC</span> YouTube — FHIP stores metadata and embeds this video; it does not host the underlying file.{' '}
              <a href={buildYouTubeWatchUrl(video.youtube_video_id)} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust hover:underline">
                Watch on YouTube
              </a>
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <span className="block text-sm font-medium text-ink">YouTube Video ID</span>
                <p className="mt-1 rounded-compact border border-line bg-gray-50 px-3 py-2 text-sm text-muted">{video.youtube_video_id}</p>
              </div>
              <div>
                <span className="block text-sm font-medium text-ink">YouTube URL</span>
                <p className="mt-1 truncate rounded-compact border border-line bg-gray-50 px-3 py-2 text-sm text-muted">{video.youtube_url}</p>
              </div>
            </div>

            <div className="mt-4">
              <TextField label="Title" value={title} onChange={(v) => { setTitle(v); markDirty(); }} required maxLength={TITLE_MAX_LENGTH} error={fieldErrors.title || reviewCheck.errors.title} />
            </div>
            <div className="mt-4">
              <TextField
                label="Slug"
                value={slug}
                onChange={(v) => { setSlugOverride(slugify(v)); setSlugTouched(true); markDirty(); }}
                error={fieldErrors.slug || reviewCheck.errors.slug}
                hint="Auto-generated from the title. You can override it before publication."
              />
            </div>
            <div className="mt-4">
              <TextAreaField label="Excerpt / Description" value={excerpt} onChange={(v) => { setExcerpt(v); markDirty(); }} maxLength={EXCERPT_MAX_LENGTH} rows={3} error={fieldErrors.excerpt || reviewCheck.errors.excerpt} />
            </div>
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink">Video Details</h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label="Duration (seconds)" value={durationSeconds} onChange={(v) => { setDurationSeconds(v.replace(/[^0-9]/g, '')); markDirty(); }} placeholder="e.g. 425" />
              <TextField label="YouTube Publish Date" value={youtubePublishedAt} onChange={(v) => { setYoutubePublishedAt(v); markDirty(); }} placeholder="YYYY-MM-DD" />
              <TextField label="Thumbnail URL" value={thumbnailUrl} onChange={(v) => { setThumbnailUrl(v); markDirty(); }} hint="Defaults to the YouTube-derived thumbnail; override if needed." />
              <TextField label="@GKTC Channel Handle" value={channelHandle} onChange={(v) => { setChannelHandle(v); markDirty(); }} />
              <TextField label="@GKTC Channel URL" value={channelUrl} onChange={(v) => { setChannelUrl(v); markDirty(); }} placeholder="https://www.youtube.com/@GKTC" />
            </div>
            <div className="mt-3">
              <CheckboxField label="Embed enabled" checked={embedEnabled} onChange={(v) => { setEmbedEnabled(v); markDirty(); }} hint="When off, the Admin preview and any future public page show a link to watch on YouTube instead of an inline embed." />
            </div>
            {thumbnailUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={thumbnailUrl} alt="" className="mt-3 max-w-xs rounded-compact border border-line" />
            )}
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-ink">Transcript</h2>
            <p className="mb-3 text-xs text-muted">Paste the transcript manually. FHIP does not automatically scrape YouTube or generate transcripts with AI.</p>
            <TextAreaField label="Transcript" value={transcript} onChange={(v) => { setTranscript(v); markDirty(); }} rows={10} />
          </div>

          <div className="rounded-card border border-line bg-white p-4">
            <h2 className="mb-1 text-sm font-semibold text-ink">Chapters</h2>
            <p className="mb-3 text-xs text-muted">e.g. 00:00 Introduction · 02:15 Why emergency funds matter · 06:42 How much to keep</p>
            <ChapterEditor chapters={chapters} onChange={(c) => { setChapters(c); markDirty(); }} errors={chapterErrors} />
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
            reviewers={reference.reviewers}
            complianceReviewers={reference.complianceReviewers}
            ctas={reference.ctas}
            canManageUsers={caps.canManage}
            canManageCtas={caps.canManage}
            errors={{ ...fieldErrors, ...reviewCheck.errors }}
          />
          <AdminTaskHelp taskId="ADM-11" />
          <WorkflowPanel status={status} compliance={meta.complianceClassification as ComplianceClassification} caps={caps} history={workflowHistory} hasUnsavedChanges={dirty} onTransition={handleTransition} />
          <RevisionHistoryPanel versions={versions} currentUserId={currentUserId} />
        </div>
      </div>
    </div>
  );
}
