import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff } from '@/lib/resources/permissions';
import { getVideoEditorPost } from '@/lib/resources/video/queries';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { YouTubeEmbed } from '@/components/resources/specialist/YouTubeEmbed';

// /admin/resources/videos/[id]/preview — spec §21-24/§63/§78/§96. Admin-only
// (requireResourceAdminAccess), never a public draft URL. The embed itself
// is always derived from the validated video ID via YouTubeEmbed — never an
// arbitrary iframe.
export default async function VideoPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getVideoEditorPost(supabase, id);
  if (!post) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/videos" className="hover:text-trust hover:underline">
          Videos
        </Link>{' '}
        &gt; <span className="text-ink">Preview</span>
      </nav>

      <div className="rounded-card border border-attention/30 bg-attention/5 p-3 text-sm text-attention" role="note">
        This is an internal Admin preview, not a public page. It is never publicly accessible or indexable regardless of this video&apos;s current settings.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeBadge contentType={post.content_type} />
          <ResourceStatusBadge status={post.status} />
          <ResourceComplianceBadge compliance={post.compliance_classification} />
        </div>
        {isResourceStaff(current) && (
          <Link href={`/admin/resources/videos/${id}/edit`} className="text-sm font-semibold text-trust hover:underline">
            Back to Editor
          </Link>
        )}
      </div>

      <article className="rounded-card border border-line bg-white p-6">
        <h1 className="text-2xl font-semibold text-ink">{post.title}</h1>
        {post.excerpt && <p className="mt-2 text-base text-muted">{post.excerpt}</p>}

        <div className="mt-6">
          {post.video?.embed_enabled === false ? (
            <p className="text-sm text-muted">
              Embed is disabled for this video.{' '}
              <a href={post.video.youtube_url} target="_blank" rel="noopener noreferrer" className="font-semibold text-trust hover:underline">
                Watch on YouTube
              </a>
            </p>
          ) : post.video ? (
            <YouTubeEmbed videoId={post.video.youtube_video_id} title={`@GKTC video preview: ${post.title}`} />
          ) : (
            <p className="text-sm text-risk">This YouTube video cannot be previewed. Check the Video ID or URL.</p>
          )}
        </div>

        {post.video?.chapters && post.video.chapters.length > 0 && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Chapters</h2>
            <ul className="mt-2 space-y-1 text-sm text-ink">
              {post.video.chapters.map((c) => (
                <li key={c.id}>
                  <span className="font-mono text-muted">{c.timestamp}</span> {c.title}
                </li>
              ))}
            </ul>
          </div>
        )}

        {post.video?.transcript && (
          <div className="mt-6">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Transcript</h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{post.video.transcript}</p>
          </div>
        )}
      </article>
    </div>
  );
}
