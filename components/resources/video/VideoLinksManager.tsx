'use client';

// PO review F12 — "Link to content": see, add and remove the links between a
// video and the content that shows it. One component, two directions:
//
//   mode 'video'   (on a video's page)  — lists the CONTENT this video is
//                  linked to; the dropdown picks content to link it to.
//   mode 'content' (on a content page)  — lists the VIDEOS this content shows;
//                  the dropdown (restricted to videos) picks a video to link.
//
// Both write through /api/admin/resources/videos/[id]/links, which uses the
// existing related-content model (see lib/resources/video/links.ts). Adding is
// immediate (it is easily undone); removing asks for confirmation and says what
// will stop happening. The page re-renders from the server after each change
// (router.refresh), so the list on screen is always the stored one.

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ResourceCombobox } from '@/components/ui/ResourceCombobox';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { actionFailureMessage, readJsonSafely } from '@/lib/resources/admin/resultState';
import { formatContentTypeForPicker, formatStatusForPicker, RELATIONSHIP_TYPE_LABELS, type RelationshipType } from '@/lib/resources/discovery/relatedAdmin';

export interface VideoLinkItem {
  /** resource_related_content.id */
  linkId: string;
  relationshipType: RelationshipType;
  /** The item on the other end of the link (null if it was deleted). */
  other: { id: string; title: string; content_type: string; status: string } | null;
}

export interface VideoLinksManagerProps {
  mode: 'video' | 'content';
  /** The id of the post whose page this is. */
  anchorId: string;
  anchorTitle: string;
  canManage: boolean;
  links: VideoLinkItem[];
}

const PUBLIC_STATUSES = ['published', 'review_due'];

export function VideoLinksManager({ mode, anchorId, anchorTitle, canManage, links }: VideoLinksManagerProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<VideoLinkItem | null>(null);
  const { outcome, reportSuccess, reportFailure, clearOutcome } = useAdminActionStatus();

  const isVideoPage = mode === 'video';
  const otherNoun = isVideoPage ? 'content' : 'video';
  const linkedIds = links.flatMap((l) => (l.other?.id ? [l.other.id] : []));

  async function addLink(picked: { id: string; title: string }) {
    if (busy) return;
    setBusy(true);
    clearOutcome();
    const videoId = isVideoPage ? anchorId : picked.id;
    const contentId = isVideoPage ? picked.id : anchorId;
    try {
      const res = await fetch(`/api/admin/resources/videos/${videoId}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_post_id: contentId }),
      });
      const json = await readJsonSafely(res);
      if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'link this video to content'));
        return;
      }
      reportSuccess(isVideoPage ? `This video is now linked to "${picked.title}".` : `"${picked.title}" is now linked to this content.`);
      router.refresh();
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const row = pendingRemove;
    setPendingRemove(null);
    if (!row?.other) return;
    setBusy(true);
    clearOutcome();
    const videoId = isVideoPage ? anchorId : row.other.id;
    try {
      const res = await fetch(`/api/admin/resources/videos/${videoId}/links/${row.linkId}`, { method: 'DELETE' });
      const json = await readJsonSafely(res);
      if (res.status === 404) {
        reportSuccess(`"${row.other.title}" was already unlinked. The list has been refreshed.`);
      } else if (!res.ok) {
        reportFailure(actionFailureMessage(res.status, json, 'remove this link'));
        return;
      } else {
        reportSuccess(`The link to "${row.other.title}" has been removed. You can link it again at any time.`);
      }
      router.refresh();
    } catch {
      reportFailure('Could not reach the server, so nothing was changed. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const heading = isVideoPage ? 'Linked content' : 'Linked videos';
  const headingId = `video-links-heading-${mode}`;

  return (
    <section id="linked-content" aria-labelledby={headingId} className="rounded-card border border-line bg-white p-5">
      <ConfirmDialog
        open={!!pendingRemove}
        title={isVideoPage ? 'Remove this link to content?' : 'Remove this linked video?'}
        message={
          pendingRemove?.other
            ? isVideoPage
              ? `"${anchorTitle}" will stop being shown on "${pendingRemove.other.title}". Neither item is deleted, and you can link them again at any time.`
              : `"${pendingRemove.other.title}" will stop being shown on "${anchorTitle}". The video itself is not deleted, and you can link it again at any time.`
            : ''
        }
        confirmLabel="Remove Link"
        cancelLabel="Cancel"
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setPendingRemove(null)}
      />

      <h2 id={headingId} className="text-sm font-semibold uppercase tracking-wide text-muted">
        {heading}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {isVideoPage
          ? 'The content that shows this video alongside it. A video appears to readers on a linked page only once the video itself is published.'
          : 'The videos this content shows alongside it. A video appears to readers only once the video itself is published.'}
      </p>

      <AdminActionStatus outcome={outcome} className="mt-3" />

      {links.length === 0 ? (
        <p className="mt-3 text-sm text-muted">{isVideoPage ? 'This video is not linked to any content yet.' : 'No videos are linked to this content yet.'}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {links.map((l) => (
            <li key={l.linkId} className="flex flex-wrap items-center justify-between gap-3 rounded-compact border border-line p-2.5">
              <div className="min-w-0 flex-1">
                {l.other ? (
                  <Link href={`/admin/resources/content/${l.other.id}`} className="break-words text-sm font-medium text-ink hover:text-trust hover:underline">
                    {l.other.title}
                  </Link>
                ) : (
                  <p className="text-sm font-medium text-ink">(deleted content)</p>
                )}
                <p className="mt-0.5 text-xs text-muted">
                  {l.other && (
                    <>
                      {formatContentTypeForPicker(l.other.content_type)} · {formatStatusForPicker(l.other.status)}
                      {!PUBLIC_STATUSES.includes(l.other.status) && <span className="ml-1 font-semibold text-attention">(not currently public)</span>}
                      {' · '}
                    </>
                  )}
                  Link type: {RELATIONSHIP_TYPE_LABELS[l.relationshipType] ?? l.relationshipType}
                </p>
              </div>
              {canManage && l.other && (
                <button
                  type="button"
                  onClick={() => setPendingRemove(l)}
                  disabled={busy}
                  aria-label={`Remove the link to ${l.other.title}`}
                  className="inline-flex min-h-11 items-center justify-center rounded border border-line px-3 text-xs font-semibold text-risk hover:bg-risk/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-risk disabled:opacity-30"
                >
                  Remove link
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage ? (
        <div className="mt-4 max-w-lg border-t border-line pt-4">
          <ResourceCombobox
            label={isVideoPage ? 'Link this video to content' : 'Link a video to this content'}
            helpText={
              isVideoPage
                ? 'Pick from the list of all current content, or type to filter it. Content already linked is not offered.'
                : 'Pick from the list of all current videos, or type to filter it. Videos already linked are not offered.'
            }
            onSelect={addLink}
            disabled={busy}
            contentType={isVideoPage ? undefined : 'video'}
            excludeId={anchorId}
            excludeIds={linkedIds}
            excludeContentTypes={isVideoPage ? ['video'] : undefined}
          />
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">You can see these links, but linking and unlinking {otherNoun} is available to Resource Administrators and Editors.</p>
      )}
    </section>
  );
}
