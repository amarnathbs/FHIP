import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getPublicResourceBySlug } from '@/lib/resources/public/queries';
import { isExpired } from '@/lib/resources/public/visibility';
import { buildResourceMetadata, buildBreadcrumbJsonLd, buildArticleJsonLd, buildVideoJsonLd, buildFaqJsonLd, buildResourceCanonicalUrl, getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { Breadcrumbs } from '@/components/resources/public/Breadcrumbs';
import { ResourceDetailHeader } from '@/components/resources/public/ResourceDetailHeader';
import { BlockRenderer } from '@/components/resources/blocks/BlockRenderer';
import { GuideTocDesktop, GuideTocMobile, deriveTocFromBlocks } from '@/components/resources/public/GuideTOC';
import { VideoDetailBody } from '@/components/resources/public/VideoDetailBody';
import { GlossaryDetailBody } from '@/components/resources/public/GlossaryDetailBody';
import { MoneyUpdateDetailBody } from '@/components/resources/public/MoneyUpdateDetailBody';
import { FreshnessWarning } from '@/components/resources/public/FreshnessWarning';
import { SourceList } from '@/components/resources/public/SourceList';
import { FaqAccordion } from '@/components/resources/public/FaqAccordion';
import { CentralDisclaimer } from '@/components/resources/public/CentralDisclaimer';
import { RelatedResources } from '@/components/resources/public/RelatedResources';
import { ResourceCTAs } from '@/components/resources/public/ResourceCTAs';
import { getRelatedResourcesForPost } from '@/lib/resources/discovery/related';
import { getUseInFhipActionsForPost } from '@/lib/resources/context/queries';
import type { ResourceContentType, ResourceJurisdiction } from '@/lib/resources/types';
import type { AnyBlock } from '@/lib/resources/editor/blocks';

type Params = { slug: string };

// Spec §63-66: title/description/canonical/robots derived per-post, with
// documented seo_title->title and seo_description->excerpt fallbacks
// (buildResourceMetadata). Spec §71/§86: a hidden/unpublished/nonexistent
// slug produces the exact same outcome here — no distinguishing signal
// leaks through a page <title>/description either.
//
// KNOWN DEFECT (documented in the R1.5 completion report, not silently
// accepted): calling notFound() here as well as in the page component below
// was tried specifically to fix the HTTP status code, on the theory that
// generateMetadata resolves before the body starts streaming. Verified live
// via `curl -D-` that it does NOT fix it in this Next.js version (16.2.12)
// — both a hidden fixture and a genuinely nonexistent slug still return
// HTTP 200 even though the rendered page content is the correct generic
// 404 page with a noindex meta tag. Left in place anyway (harmless, still
// the more idiomatic pattern) since removing it would not change the
// outcome. The security-relevant property still holds: rendered content is
// byte-for-byte identical for "hidden" vs "never existed" (spec §71's
// actual concern), and the noindex meta tag is present on both regardless
// of the wrong status line, so a JS-rendering crawler still will not index
// it — see the completion report's Public Security Tests section for the
// full analysis.
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const supabase = await createClient();
  const post = await getPublicResourceBySlug(supabase, slug);
  if (!post) notFound();
  return buildResourceMetadata(post);
}

// Spec §14/§29-32/§35/§42/§46: the single canonical public detail URL,
// dispatching rendering by content_type. Spec §71/§86: getPublicResourceBySlug
// returns null identically for "never existed" and "exists but not
// currently public" — notFound() below can't distinguish them, which is
// the point.
export default async function ResourceDetailPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const supabase = await createClient();
  const post = await getPublicResourceBySlug(supabase, slug);
  if (!post) notFound();

  // R1.6 (spec §50/§63): session-state (not financial-data) adaptation for
  // the generic fallback CTA, and the "Use this in FHIP" bidirectional
  // action list — both reuse the same request-scoped client, still under
  // normal RLS, never service-role.
  const [
    {
      data: { user },
    },
    relatedResources,
    useInFhipActions,
  ] = await Promise.all([
    supabase.auth.getUser(),
    getRelatedResourcesForPost(supabase, { id: post.id, primary_category_id: post.primary_category?.id ?? null, jurisdiction: post.jurisdiction, content_type: post.content_type }),
    getUseInFhipActionsForPost(supabase, post.id),
  ]);

  const canonicalUrl = buildResourceCanonicalUrl(slug);
  const breadcrumbItems = [
    { label: 'Home', href: '/' },
    { label: 'Resources', href: '/resources' },
    ...(post.primary_category ? [{ label: post.primary_category.name, href: `/resources/topic/${post.primary_category.slug}` }] : []),
    { label: post.title },
  ];

  const siteBaseUrl = getPublicSiteBaseUrl();
  const breadcrumbJsonLd = buildBreadcrumbJsonLd([
    { name: 'Home', url: `${siteBaseUrl}/` },
    { name: 'Resources', url: `${siteBaseUrl}/resources` },
    { name: post.title, url: canonicalUrl },
  ]);
  const articleJsonLd = post.content_type !== 'video' ? buildArticleJsonLd({ title: post.title, excerpt: post.excerpt, slug: post.slug, published_at: post.published_at, updated_at: post.updated_at, authorName: post.author?.display_name ?? null }) : null;
  const videoJsonLd =
    post.content_type === 'video' && post.video
      ? buildVideoJsonLd({
          title: post.title,
          excerpt: post.excerpt,
          slug: post.slug,
          published_at: post.published_at,
          thumbnailUrl: post.video.thumbnail_url,
          durationSeconds: post.video.duration_seconds,
          embedUrl: `https://www.youtube.com/embed/${post.video.youtube_video_id}`,
        })
      : null;
  const faqJsonLd = buildFaqJsonLd(post.faqs.filter((f) => f.short_answer).map((f) => ({ question: f.question, shortAnswer: f.short_answer as string })));

  const showGenericFreshnessWarning = post.content_type !== 'money_update' && post.freshness_type === 'time_sensitive' && isExpired(post.expires_at);
  const toc = post.content_type === 'guide' ? deriveTocFromBlocks(post.content_blocks as AnyBlock[]) : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {/* Structured data (spec §67/§68) — built only from real stored fields, omitted entirely when required fields are missing. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }} />
      {articleJsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(articleJsonLd) }} />}
      {videoJsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(videoJsonLd) }} />}
      {faqJsonLd && <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />}

      <Breadcrumbs items={breadcrumbItems} />

      <div className={`mt-4 grid grid-cols-1 gap-8 ${toc.length > 0 ? 'lg:grid-cols-[1fr_260px]' : ''}`}>
        <article
          className={`min-w-0 space-y-6 rounded-card border bg-white p-6 sm:p-8 ${post.content_type === 'fhip_explainer' ? 'border-ai/30 border-t-4' : 'border-line'}`}
        >
          <ResourceDetailHeader
            contentType={post.content_type as ResourceContentType}
            title={post.title}
            excerpt={post.excerpt}
            jurisdiction={post.jurisdiction as ResourceJurisdiction}
            difficulty={post.difficulty}
            publishedAt={post.published_at}
            updatedAt={post.updated_at}
            authorName={post.author?.display_name ?? null}
            shareUrl={canonicalUrl}
          />

          {/* Mobile/tablet "On this page" disclosure (spec §31) only — the
              matching desktop nav is rendered once, separately, in the
              <aside> below (see GuideTOC.tsx's header for why these are two
              distinct components rather than one rendered twice). */}
          <GuideTocMobile entries={toc} />

          {showGenericFreshnessWarning && <FreshnessWarning expiresAt={post.expires_at} lastReviewedAt={post.last_reviewed_at} />}

          {post.content_type === 'video' && post.video ? (
            <VideoDetailBody video={post.video} title={`@GKTC video: ${post.title}`} />
          ) : post.content_type === 'glossary' ? (
            <GlossaryDetailBody aliases={post.aliases} contentBlocks={post.content_blocks} relatedTerms={post.relatedGlossaryTerms} />
          ) : post.content_type === 'money_update' ? (
            <MoneyUpdateDetailBody eventDate={post.event_date} affectedAudience={post.affected_audience} contentBlocks={post.content_blocks} expiresAt={post.expires_at} lastReviewedAt={post.last_reviewed_at} />
          ) : (
            <BlockRenderer blocks={post.content_blocks as AnyBlock[]} />
          )}

          {post.author?.bio && (
            <div className="border-t border-line pt-4 text-sm text-muted">
              <p className="font-semibold text-ink">{post.author.display_name}</p>
              {post.author.role_title && <p>{post.author.role_title}</p>}
              <p className="mt-1">{post.author.bio}</p>
            </div>
          )}

          <SourceList sources={post.sources} />
          <FaqAccordion faqs={post.faqs} />

          {/* R1.6 order per spec §71: content -> FAQs -> Sources -> Related
              Resources -> CTA -> Disclaimer. */}
          <RelatedResources items={relatedResources} />

          <div className="border-t border-line pt-6">
            <ResourceCTAs primaryCta={post.primaryCta} secondaryCta={post.secondaryCta} isAuthenticated={!!user} />
          </div>

          {useInFhipActions.length > 0 && (
            <div className="border-t border-line pt-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Use this in FHIP</h2>
              <div className="mt-2 flex flex-wrap gap-3">
                {useInFhipActions.map((action) => (
                  <Link key={action.route} href={action.route} className="rounded-compact border border-line px-4 py-2 text-sm font-semibold text-trust hover:border-trust">
                    {action.label.replace('Use this in FHIP: ', '')}
                  </Link>
                ))}
              </div>
            </div>
          )}

          <div className="border-t border-line pt-4">
            <CentralDisclaimer supabase={supabase} prominent={post.content_type === 'money_update'} />
          </div>
        </article>

        {toc.length > 0 && (
          <aside className="hidden lg:block">
            <div className="sticky top-6 rounded-card border border-line bg-white p-4">
              <GuideTocDesktop entries={toc} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
