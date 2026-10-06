// PO review F12 — standalone, SERVER-rendered "Linked videos" panel for a
// content page, and its mirror "Linked content" panel for a video page.
//
// Server components on purpose: the list is read on the server with the
// caller's own request-scoped client (RLS applies), so it can be mounted on
// any server page — the read-only detail page today and the content editor's
// page — without that page needing to know anything about links. Only the
// small add/remove island (VideoLinksManager) is a client component.
//
// Failure is explicit: if the links cannot be read, an error panel says so
// (Admin standard §13) rather than rendering a misleading "no links yet".

import type { SupabaseClient } from '@supabase/supabase-js';
import { listContentLinkedToVideo, listVideosLinkedToContent } from '@/lib/resources/video/links';
import { VideoLinksManager, type VideoLinkItem } from './VideoLinksManager';

function LoadFailed({ what }: { what: string }) {
  return (
    <section className="rounded-card border border-risk/30 bg-risk/5 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-risk">{what}</h2>
      <p role="alert" className="mt-2 text-sm text-risk">
        The links could not be loaded just now, so none are shown. Reload the page to try again.
      </p>
    </section>
  );
}

/** On a CONTENT page (any non-video type): the videos this content shows. */
export async function LinkedVideosPanel({ supabase, contentPostId, contentTitle, canManage }: { supabase: SupabaseClient; contentPostId: string; contentTitle: string; canManage: boolean }) {
  let links: VideoLinkItem[];
  try {
    const rows = await listVideosLinkedToContent(supabase, contentPostId);
    links = rows.map((r) => ({ linkId: r.id, relationshipType: r.relationship_type, other: r.video }));
  } catch (err) {
    console.error('Resources linked-videos panel load error:', err);
    return <LoadFailed what="Linked videos" />;
  }
  return <VideoLinksManager mode="content" anchorId={contentPostId} anchorTitle={contentTitle} canManage={canManage} links={links} />;
}

/** On a VIDEO page: the content this video is linked to. */
export async function LinkedContentPanel({ supabase, videoPostId, videoTitle, canManage }: { supabase: SupabaseClient; videoPostId: string; videoTitle: string; canManage: boolean }) {
  let links: VideoLinkItem[];
  try {
    const rows = await listContentLinkedToVideo(supabase, videoPostId);
    links = rows.map((r) => ({ linkId: r.id, relationshipType: r.relationship_type, other: r.content }));
  } catch (err) {
    console.error('Resources linked-content panel load error:', err);
    return <LoadFailed what="Linked content" />;
  }
  return <VideoLinksManager mode="video" anchorId={videoPostId} anchorTitle={videoTitle} canManage={canManage} links={links} />;
}
