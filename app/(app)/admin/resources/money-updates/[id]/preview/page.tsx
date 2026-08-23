import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff } from '@/lib/resources/permissions';
import { getMoneyUpdateEditorPost } from '@/lib/resources/money-update/queries';
import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { formatAdminDate } from '@/lib/resources/admin/labels';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

// /admin/resources/money-updates/[id]/preview — spec §42-43/§63/§81/§96.
// Structured headings inside BlockRenderer never introduce a second H1
// (block heading levels are capped at H2-H4 by the R1.3 block model) — the
// page's own <h1> (the title) remains the only H1 (spec §81).
export default async function MoneyUpdatePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const current = await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getMoneyUpdateEditorPost(supabase, id);
  if (!post) notFound();

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <Link href="/admin/resources" className="hover:text-trust hover:underline">
          Resources
        </Link>{' '}
        &gt;{' '}
        <Link href="/admin/resources/money-updates" className="hover:text-trust hover:underline">
          Money Updates
        </Link>{' '}
        &gt; <span className="text-ink">Preview</span>
      </nav>

      <div className="rounded-card border border-attention/30 bg-attention/5 p-3 text-sm text-attention" role="note">
        This is an internal Admin preview, not a public page (the public Money Updates page is not built until R1.5).
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <ResourceTypeBadge contentType={post.content_type} />
          <ResourceStatusBadge status={post.status} />
          <ResourceComplianceBadge compliance={post.compliance_classification} />
        </div>
        {isResourceStaff(current) && (
          <Link href={`/admin/resources/money-updates/${id}/edit`} className="text-sm font-semibold text-trust hover:underline">
            Back to Editor
          </Link>
        )}
      </div>

      <article className="rounded-card border border-line bg-white p-6">
        <h1 className="text-2xl font-semibold text-ink">{post.title}</h1>
        <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-sm text-muted">
          {post.event_date && (
            <div>
              <dt className="inline font-medium">Event Date:</dt> <dd className="inline">{formatAdminDate(post.event_date)}</dd>
            </div>
          )}
          {post.affected_audience && (
            <div>
              <dt className="inline font-medium">Affected Audience:</dt> <dd className="inline">{post.affected_audience}</dd>
            </div>
          )}
        </dl>
        {post.excerpt && <p className="mt-3 text-base text-ink">{post.excerpt}</p>}

        <div className="mt-6">
          <BlockRenderer blocks={(post.content_blocks as AnyBlock[]) ?? []} />
        </div>

        {post.sources.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Official Sources</h2>
            <ul className="mt-2 space-y-1 text-sm text-ink">
              {post.sources.map((s) => (
                <li key={s.id}>
                  {s.url ? (
                    <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-trust hover:underline">
                      {s.source_name}
                    </a>
                  ) : (
                    s.source_name
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>
    </div>
  );
}
