import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff } from '@/lib/resources/permissions';
import { getGlossaryEditorPost } from '@/lib/resources/glossary/queries';
import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

// /admin/resources/glossary/[id]/preview — spec §31/§63/§96. Admin-only.
export default async function GlossaryPreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getGlossaryEditorPost(supabase, id);
  if (!post) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/glossary" className="hover:text-trust hover:underline">
          Glossary
        </Link>{' '}
        &gt; <span className="text-ink">Preview</span>
      </nav>

      <div className="rounded-card border border-attention/30 bg-attention/5 p-3 text-sm text-attention" role="note">
        This is an internal Admin preview, not a public page (the public glossary page is not built until R1.5).
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeBadge contentType={post.content_type} />
          <ResourceStatusBadge status={post.status} />
          <ResourceComplianceBadge compliance={post.compliance_classification} />
        </div>
        {isResourceStaff(current) && (
          <Link href={`/admin/resources/glossary/${id}/edit`} className="text-sm font-semibold text-trust hover:underline">
            Back to Editor
          </Link>
        )}
      </div>

      <article className="rounded-card border border-line bg-white p-6">
        <h1 className="text-2xl font-semibold text-ink">{post.title}</h1>
        {post.excerpt && <p className="mt-2 text-base font-medium text-ink">{post.excerpt}</p>}

        {post.aliases.length > 0 && (
          <p className="mt-2 text-sm text-muted">Also known as: {post.aliases.join(', ')}</p>
        )}

        <div className="mt-6">
          <BlockRenderer blocks={(post.content_blocks as AnyBlock[]) ?? []} />
        </div>

        {post.relatedTerms.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Related Terms</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {post.relatedTerms.map((t) => (
                <li key={t.id} className="rounded-full bg-gray-100 px-3 py-1 text-sm text-ink">
                  {t.name}
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>
    </div>
  );
}
