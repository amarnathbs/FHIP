import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { getResourceContentById, getResourceWorkflowHistory } from '@/lib/resources/admin/queries';
import { ResourceStatusBadge, ResourceComplianceBadge, ResourceJurisdictionBadge, ResourceTypeBadge } from '@/components/resources/admin/ResourceBadges';
import { STATUS_LABELS, formatAdminDate, formatAdminDateTime } from '@/lib/resources/admin/labels';

// R1.4 (spec §67): specialist content types link to their own dedicated
// editor from this read-only detail page, rather than forcing the generic
// R1.3 editor (which never supported these content types to begin with).
// Article/Guide/FHIP Explainer intentionally still have no Edit link here —
// that gap pre-dates R1.4 (see the file header comment above) and is out of
// this phase's scope to fix; noted in the R1.4 completion report.
const SPECIALIST_EDIT_ROUTES: Record<string, (id: string) => { href: string; label: string }> = {
  video: (id) => ({ href: `/admin/resources/videos/${id}/edit`, label: 'Edit Video' }),
  glossary: (id) => ({ href: `/admin/resources/glossary/${id}/edit`, label: 'Edit Glossary Definition' }),
  money_update: (id) => ({ href: `/admin/resources/money-updates/${id}/edit`, label: 'Edit Money Update' }),
  money_update_template: (id) => ({ href: `/admin/resources/money-updates/${id}/edit`, label: 'Edit Money Update Template' }),
};

// Read-only content detail view — spec §22-23, §61-63. NOT an editor: no
// content_blocks are fetched or rendered here, and there is no Edit control
// (content editing is explicitly R1.3+ scope, spec §19/§23 — "if Edit
// belongs to R1.3, disable/hide it"; this build hides it entirely rather
// than shipping a disabled button with nothing behind it yet).
export default async function ResourceContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireResourceAdminAccess();
  const { id } = await params;
  const supabase = await createClient();

  const post = await getResourceContentById(supabase, id);
  // Spec §96: a genuinely-missing id and an RLS-denied id resolve to the
  // same generic not-found page — never "this draft exists but you don't
  // have permission."
  if (!post) notFound();

  const workflowHistory = await getResourceWorkflowHistory(supabase, id);

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{value ?? '—'}</dd>
    </div>
  );

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
        &gt; <span className="text-ink">{post.title}</span>
      </nav>

      <div>
        <div className="flex flex-wrap items-center gap-2">
          <ResourceStatusBadge status={post.status} />
          <ResourceComplianceBadge compliance={post.compliance_classification} />
        </div>
        <h1 className="mt-2 text-2xl font-semibold text-ink">{post.title}</h1>
        <p className="mt-1 text-sm text-muted">
          {post.content_id ?? 'No content ID'} · <ResourceTypeBadge contentType={post.content_type} /> ·{' '}
          <ResourceJurisdictionBadge jurisdiction={post.jurisdiction} />
        </p>
        {/* Content creation/editing is R1.3 scope — no Edit control here yet for Article/Guide/FHIP Explainer (spec §19/§23). */}
        {SPECIALIST_EDIT_ROUTES[post.content_type] && (
          <Link href={SPECIALIST_EDIT_ROUTES[post.content_type](post.id).href} className="mt-2 inline-block text-sm font-semibold text-trust hover:underline">
            {SPECIALIST_EDIT_ROUTES[post.content_type](post.id).label}
          </Link>
        )}
      </div>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Overview</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Title', post.title)}
          {field('Content ID', post.content_id)}
          {field('Type', <ResourceTypeBadge contentType={post.content_type} />)}
          {field('Status', <ResourceStatusBadge status={post.status} />)}
          {field('Compliance', <ResourceComplianceBadge compliance={post.compliance_classification} />)}
          {field('Jurisdiction', <ResourceJurisdictionBadge jurisdiction={post.jurisdiction} />)}
          {field('Difficulty', post.difficulty)}
          {field('Excerpt', post.excerpt)}
        </dl>
      </section>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Ownership</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Author', post.author?.name)}
          {field('Reviewer', post.reviewer?.name)}
          {field('Compliance Reviewer', post.compliance_reviewer?.name)}
        </dl>
      </section>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Publishing</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Scheduled At', formatAdminDateTime(post.scheduled_at))}
          {field('Published At', formatAdminDateTime(post.published_at))}
          {field('Expires At', formatAdminDateTime(post.expires_at))}
          {field('Last Reviewed', formatAdminDate(post.last_reviewed_at))}
          {field('Next Review', formatAdminDate(post.next_review_at))}
          {field('Editorial Approved', formatAdminDateTime(post.editorial_approved_at))}
          {field('Compliance Approved', formatAdminDateTime(post.compliance_approved_at))}
        </dl>
      </section>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Organisation</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Primary Category', post.primary_category?.name)}
          {field('Categories', post.categories.length > 0 ? post.categories.map((c) => c.name).join(', ') : null)}
          {field('Tags', post.tags.length > 0 ? post.tags.map((t) => t.name).join(', ') : null)}
        </dl>
      </section>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">SEO</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Slug', post.slug)}
          {field('SEO Title', post.seo_title)}
          {field('Meta Description', post.seo_description)}
          {field('Canonical URL', post.canonical_url)}
          {field('Indexable', post.is_indexable ? 'Yes' : 'No')}
        </dl>
      </section>

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Conversion</h2>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {field('Primary CTA', post.primary_cta?.label)}
          {field('Secondary CTA', post.secondary_cta?.label)}
        </dl>
      </section>

      {post.video && (
        <section className="rounded-card border border-line bg-white p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Video</h2>
          <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {field('YouTube Channel', post.video.youtube_channel_handle)}
            {field('YouTube Video ID', post.video.youtube_video_id)}
            {field('YouTube URL', post.video.youtube_url)}
            {field('Embed Enabled', post.video.embed_enabled ? 'Yes' : 'No')}
          </dl>
        </section>
      )}

      <section className="rounded-card border border-line bg-white p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Workflow History</h2>
        {/* Workflow transition controls are intentionally deferred to R1.3 —
            R1.2 provides queue visibility and this read-only history only
            (spec §25). Internal `metadata` JSON is deliberately never shown
            (spec §62). */}
        {workflowHistory.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No workflow transitions recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-3">
            {workflowHistory.map((entry) => (
              <li key={entry.id} className="border-l-2 border-line pl-3">
                <p className="text-sm font-medium text-ink">{STATUS_LABELS[entry.to_status as keyof typeof STATUS_LABELS] ?? entry.to_status}</p>
                <p className="text-xs text-muted">
                  {formatAdminDateTime(entry.created_at)} · by {entry.actor_role ?? 'unknown role'}
                </p>
                {entry.reason && <p className="mt-1 text-xs text-muted">Reason: {entry.reason}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
