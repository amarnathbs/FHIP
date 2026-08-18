import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getResourcesLandingData } from '@/lib/resources/public/queries';
import { getPublicSiteBaseUrl } from '@/lib/resources/public/metadata';
import { ResourcePublicCard } from '@/components/resources/public/ResourcePublicCard';
import { PublicEmptyState } from '@/components/resources/public/PublicStates';

// Spec §17/§18: brand + hero copy taken verbatim from the approved
// positioning; canonical + OG per spec §63-66.
export const metadata: Metadata = {
  title: 'Financial Knowledge & Insights | FHIP Resources',
  description: 'Understand your money and improve your financial health — guides, explainers, videos, glossary and money updates from FHIP.',
  alternates: { canonical: `${getPublicSiteBaseUrl()}/resources` },
  openGraph: {
    title: 'Financial Knowledge & Insights',
    description: 'We don’t just give you financial numbers. We help you understand what those numbers mean.',
    url: `${getPublicSiteBaseUrl()}/resources`,
    type: 'website',
  },
};

const LEARNING_JOURNEY = ['Learn', 'Understand', 'Measure', 'Improve', 'Monitor'];

export default async function ResourcesLandingPage() {
  const supabase = await createClient();
  const data = await getResourcesLandingData(supabase);

  return (
    <div>
      {/* Hero */}
      <section className="border-b border-line bg-white">
        <div className="mx-auto max-w-4xl px-4 py-14 text-center sm:px-6">
          <p className="text-sm font-semibold uppercase tracking-wide text-trust">Financial Knowledge &amp; Insights</p>
          <h1 className="mt-3 text-3xl font-bold text-ink sm:text-4xl">Understand your money. Improve your financial health.</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-muted">
            We don&rsquo;t just give you financial numbers. We help you understand what those numbers mean.
          </p>

          <ol className="mt-8 flex flex-wrap items-center justify-center gap-2 text-sm font-medium text-ink" aria-label="Learning journey">
            {LEARNING_JOURNEY.map((step, i) => (
              <li key={step} className="flex items-center gap-2">
                <span className="rounded-full border border-trust/30 bg-trust/5 px-3 py-1">{step}</span>
                {i < LEARNING_JOURNEY.length - 1 && (
                  <span aria-hidden="true" className="text-muted">
                    &rarr;
                  </span>
                )}
              </li>
            ))}
          </ol>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a href="#start-here" className="rounded-compact bg-trust px-5 py-2.5 font-semibold text-white hover:bg-trust-700">
              Start Here
            </a>
            <Link href="/signup" className="rounded-compact border border-line px-5 py-2.5 font-semibold text-ink hover:border-trust hover:text-trust">
              Check Your Financial Health
            </Link>
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-6xl space-y-16 px-4 py-12 sm:px-6">
        {/* A. Start Here — spec §20/§62: hide gracefully if nothing qualifies yet. */}
        {data.startHere.length > 0 && (
          <section id="start-here" aria-labelledby="start-here-heading" className="scroll-mt-8">
            <h2 id="start-here-heading" className="text-2xl font-semibold text-ink">
              Start Here
            </h2>
            <p className="mt-1 text-muted">New to FHIP? Begin with these foundational Resources.</p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.startHere.map((r) => (
                <ResourcePublicCard key={r.id} resource={r} />
              ))}
            </div>
          </section>
        )}

        {/* B. Browse by Topic */}
        {data.topics.length > 0 && (
          <section aria-labelledby="topics-heading">
            <h2 id="topics-heading" className="text-2xl font-semibold text-ink">
              Browse by Topic
            </h2>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.topics.map((topic) => (
                <Link key={topic.id} href={`/resources/topic/${topic.slug}`} className="rounded-card border border-line bg-white p-5 transition hover:border-trust/40 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust">
                  <h3 className="font-semibold text-ink">{topic.name}</h3>
                  {topic.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{topic.description}</p>}
                  <p className="mt-3 text-xs font-medium text-trust">
                    {topic.publicCount} {topic.publicCount === 1 ? 'resource' : 'resources'}
                  </p>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* C. FHIP Explained */}
        {data.explainers.length > 0 && (
          <section aria-labelledby="explainers-heading">
            <h2 id="explainers-heading" className="text-2xl font-semibold text-ink">
              FHIP Explained
            </h2>
            <p className="mt-1 text-muted">How FHIP&rsquo;s scores, forecasts and features work.</p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.explainers.map((r) => (
                <ResourcePublicCard key={r.id} resource={r} />
              ))}
            </div>
          </section>
        )}

        {/* D. Latest Money Updates */}
        {data.latestMoneyUpdates.length > 0 && (
          <section aria-labelledby="money-updates-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="money-updates-heading" className="text-2xl font-semibold text-ink">
                Latest Money Updates
              </h2>
              <Link href="/resources/money-updates" className="text-sm font-semibold text-trust hover:underline">
                View all
              </Link>
            </div>
            <p className="mt-1 text-muted">Important financial developments, explained in plain English and connected to financial health.</p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.latestMoneyUpdates.map((r) => (
                <ResourcePublicCard key={r.id} resource={r} />
              ))}
            </div>
          </section>
        )}

        {/* E. Watch @GKTC */}
        {data.latestVideos.length > 0 && (
          <section aria-labelledby="videos-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="videos-heading" className="text-2xl font-semibold text-ink">
                Watch @GKTC
              </h2>
              <Link href="/resources/videos" className="text-sm font-semibold text-trust hover:underline">
                View all
              </Link>
            </div>
            <p className="mt-1 text-muted">Financial education videos, part of FHIP&rsquo;s Resources and hosted on @GKTC YouTube.</p>
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.latestVideos.map((r) => (
                <ResourcePublicCard key={r.id} resource={r} />
              ))}
            </div>
          </section>
        )}

        {/* F. Glossary gateway */}
        {data.glossaryPreview.length > 0 && (
          <section aria-labelledby="glossary-heading">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 id="glossary-heading" className="text-2xl font-semibold text-ink">
                Glossary
              </h2>
              <Link href="/resources/glossary" className="text-sm font-semibold text-trust hover:underline">
                Browse the glossary
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-2">
              {data.glossaryPreview.map((term) =>
                term.slug ? (
                  <Link key={term.id} href={`/resources/${term.slug}`} className="rounded-full border border-line bg-white px-3 py-1.5 text-sm text-ink hover:border-trust hover:text-trust">
                    {term.title}
                  </Link>
                ) : null
              )}
            </div>
          </section>
        )}

        {/* G. Continue With FHIP — generic, static acquisition panel (spec §19.G/§58). No personalised/contextual logic. */}
        <section className="rounded-card border border-line bg-nav p-8 text-center text-white sm:p-12">
          <h2 className="text-2xl font-semibold">Continue with FHIP</h2>
          <p className="mx-auto mt-2 max-w-xl text-white/80">Turn what you&rsquo;ve learned into a clear view of your own financial health.</p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="rounded-compact bg-white px-5 py-2.5 font-semibold text-nav hover:bg-gray-100">
              Check Your Financial Health
            </Link>
            <Link href="/login" className="rounded-compact border border-white/40 px-5 py-2.5 font-semibold text-white hover:bg-white/10">
              Log In
            </Link>
          </div>
        </section>

        {data.startHere.length === 0 && data.topics.length === 0 && data.explainers.length === 0 && data.latestMoneyUpdates.length === 0 && data.latestVideos.length === 0 && data.glossaryPreview.length === 0 && (
          <PublicEmptyState title="Resources content is coming soon." message="Check back shortly — we're building out FHIP's Financial Knowledge & Insights library." />
        )}
      </div>
    </div>
  );
}
