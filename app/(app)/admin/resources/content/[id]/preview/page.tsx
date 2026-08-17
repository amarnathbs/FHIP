import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff } from '@/lib/resources/permissions';
import { getResourceEditorPost } from '@/lib/resources/editor/queries';
import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

// /admin/resources/content/[id]/preview — spec §62-64. Authenticated,
// role-protected Admin aid only — NOT the R1.5 public page. Reuses
// requireResourceAdminAccess() (redirects unauthenticated -> /login,
// no-Resources-role -> /dashboard) plus the same RLS-scoped read as the
// editor (a non-staff viewer simply gets a 404 for a private draft, same as
// every other Resources Admin surface — spec §63/§96/§118: "anonymous
// access denied... customer access denied... no public indexing").
export default async function ResourcePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getResourceEditorPost(supabase, id);
  if (!post) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/content" className="hover:text-trust hover:underline">
          All Content
        </Link>{' '}
        &gt; <span className="text-ink">Preview</span>
      </nav>

      <div className="rounded-card border border-attention/30 bg-attention/5 p-3 text-sm text-attention" role="note">
        This is an internal Admin preview, not the public Resources page (not built until R1.5). It is never publicly accessible or indexable regardless of this content&apos;s current settings.
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeBadge contentType={post.content_type} />
          <ResourceStatusBadge status={post.status} />
          <ResourceComplianceBadge compliance={post.compliance_classification} />
        </div>
        {isResourceStaff(current) && (
          <Link href={`/admin/resources/content/${id}/edit`} className="text-sm font-semibold text-trust hover:underline">
            Back to Editor
          </Link>
        )}
      </div>

      <article className="rounded-card border border-line bg-white p-6">
        <h1 className="text-2xl font-semibold text-ink">{post.title}</h1>
        {post.excerpt && <p className="mt-2 text-base text-muted">{post.excerpt}</p>}
        <div className="mt-6">
          <BlockRenderer blocks={(post.content_blocks as AnyBlock[]) ?? []} />
        </div>
      </article>
    </div>
  );
}
