'use client';

// Resources Dashboard — spec §12-17. Deliberately not overloaded (§13):
// summary cards, a focused Needs Attention section, a short recent-content
// list, and role-aware quick links — no charts, no analytics (§84).

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ResourceStatusBadge } from './ResourceBadges';
import { ResourceLoadingSkeleton, ResourceFailureState, ResourceUnavailableState } from './ResourceStates';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { failureFromResponse, failureFromThrown, readJsonSafely, type AdminFailure } from '@/lib/resources/admin/resultState';
import { formatAdminDate } from '@/lib/resources/admin/labels';
import type { DashboardSummary, ContentListItem } from '@/lib/resources/admin/queries';

const SUMMARY_CARDS: { key: keyof DashboardSummary['counts']; label: string }[] = [
  { key: 'published', label: 'Published' },
  { key: 'drafts', label: 'Draft' },
  { key: 'inReview', label: 'In Review' },
  { key: 'approved', label: 'Approved' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'reviewDue', label: 'Review Due' },
  { key: 'archived', label: 'Archived' },
];

function ContentMiniList({ items, emptyLabel }: { items: ContentListItem[]; emptyLabel: string }) {
  if (items.length === 0) return <p className="text-sm text-muted">{emptyLabel}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item.id} className="flex items-center justify-between gap-2 text-sm">
          <Link href={`/admin/resources/content/${item.id}`} className="truncate text-ink hover:text-trust hover:underline">
            {item.title}
          </Link>
          <span className="shrink-0 text-xs text-muted">{formatAdminDate(item.updated_at)}</span>
        </li>
      ))}
    </ul>
  );
}

export function ResourcesDashboardClient() {
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<AdminFailure | null>(null);
  const [analystPlaceholder, setAnalystPlaceholder] = useState(false);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setFailure(null);
      try {
        const res = await fetch('/api/admin/resources/dashboard');
        // Admin A0.2 Wave 5 (§19): `await res.json()` was unguarded here, so
        // an HTML error page from the edge surfaced a raw
        // `SyntaxError: Unexpected token '<'` as the operator's message.
        const json = await readJsonSafely(res);
        if (cancelled) return;
        if (!res.ok) {
          setFailure(failureFromResponse(res.status, json, 'the Resources dashboard'));
          setSummary(null);
          return;
        }
        const data = json?.data as { analystPlaceholder?: boolean; summary?: DashboardSummary } | undefined;
        setAnalystPlaceholder(Boolean(data?.analystPlaceholder));
        setSummary(data?.summary ?? null);
      } catch (e) {
        if (!cancelled) {
          setFailure(failureFromThrown(e, 'the Resources dashboard'));
          setSummary(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink">Resources</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">Manage FHIP financial education, videos, explainers and publishing workflows.</p>
        </div>
        {/* §8.2 — shown only to a caller who can actually create content.
            It was previously rendered for every Resources role, including
            Publisher, Compliance Reviewer and Analyst, whose create request
            the API rejects: a primary call to action that dead-ends. The
            server tells us who may create via the same payload that drives
            the rest of this page. */}
        {!analystPlaceholder && (
          <Link href="/admin/resources/content/new" className="inline-flex min-h-11 items-center rounded-full bg-trust px-4 py-2 text-sm font-semibold text-white hover:bg-trust/90">
            + New Content
          </Link>
        )}
      </div>

      <AdminTaskHelp taskId="ADM-07" />

      {loading && <ResourceLoadingSkeleton rows={4} label="Loading the Resources dashboard" />}
      {!loading && failure && <ResourceFailureState failure={failure} onRetry={() => setReloadToken((t) => t + 1)} />}

      {!loading && !failure && analystPlaceholder && (
        /* §9 `unavailable` — this is neither an error nor an empty result:
           the capability itself is not operational for this caller. It was
           previously an unlabelled white card indistinguishable from an
           ordinary content card. */
        <ResourceUnavailableState
          title="No content-management access on this account"
          message="Your Analyst role is read-only and does not include content management. Resources analytics are not available yet either — there is nothing here for you to act on today."
        />
      )}

      {!loading && !failure && !analystPlaceholder && summary && (
        <>
          <section aria-labelledby="content-overview-heading">
            <h2 id="content-overview-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Content Overview
            </h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {SUMMARY_CARDS.map((card) => (
                <div key={card.key} className="rounded-card border border-line bg-white p-4">
                  <p className="text-2xl font-semibold tabular-nums text-ink">{summary.counts[card.key]}</p>
                  <p className="mt-1 text-xs text-muted">{card.label}</p>
                </div>
              ))}
            </div>
          </section>

          <section aria-labelledby="needs-attention-heading">
            <h2 id="needs-attention-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Needs Attention
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-card border border-line bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <ResourceStatusBadge status="editorial_review" />
                  <span className="text-sm font-semibold text-ink">{summary.needsAttention.editorialReview.count}</span>
                </div>
                <ContentMiniList items={summary.needsAttention.editorialReview.items} emptyLabel="Nothing in editorial review." />
              </div>
              <div className="rounded-card border border-line bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <ResourceStatusBadge status="compliance_review" />
                  <span className="text-sm font-semibold text-ink">{summary.needsAttention.complianceReview.count}</span>
                </div>
                <ContentMiniList items={summary.needsAttention.complianceReview.items} emptyLabel="Nothing in compliance review." />
              </div>
              <div className="rounded-card border border-line bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <ResourceStatusBadge status="review_due" />
                  <span className="text-sm font-semibold text-ink">{summary.needsAttention.reviewDue.count}</span>
                </div>
                <ContentMiniList items={summary.needsAttention.reviewDue.items} emptyLabel="Nothing due for review." />
              </div>
              <div className="rounded-card border border-line bg-white p-4">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-ink">Scheduled Soon</p>
                  <span className="text-sm font-semibold text-ink">{summary.needsAttention.scheduledSoon.count}</span>
                </div>
                <ContentMiniList items={summary.needsAttention.scheduledSoon.items} emptyLabel="Nothing scheduled in the next 7 days." />
              </div>
            </div>
          </section>

          <section aria-labelledby="recent-content-heading">
            <div className="flex items-center justify-between">
              <h2 id="recent-content-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                Recent Content
              </h2>
              <Link href="/admin/resources/content" className="text-sm font-semibold text-trust hover:underline">
                View All Content
              </Link>
            </div>
            <div className="rounded-card border border-line bg-white p-4">
              <ContentMiniList items={summary.recent} emptyLabel="No Resources content has been created yet." />
            </div>
          </section>

          <section aria-labelledby="quick-links-heading">
            <h2 id="quick-links-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
              Quick Links
            </h2>
            <div className="flex flex-wrap gap-2">
              {[
                { href: '/admin/resources/content', label: 'All Content' },
                { href: '/admin/resources/content/drafts', label: 'Drafts' },
                { href: '/admin/resources/content/review', label: 'Review Queue' },
                { href: '/admin/resources/content/published', label: 'Published' },
                { href: '/admin/resources/content/review-due', label: 'Review Due' },
                // R1.4 (spec §65): quick links to the four specialist
                // modules, kept in the same uncluttered row rather than a
                // redesigned dashboard.
                { href: '/admin/resources/videos', label: 'Videos' },
                { href: '/admin/resources/glossary', label: 'Glossary' },
                { href: '/admin/resources/faqs', label: 'FAQs' },
                { href: '/admin/resources/money-updates', label: 'Money Updates' },
                // R1.6 (spec §75): discovery/context management quick links.
                { href: '/admin/resources/related', label: 'Related Content' },
                { href: '/admin/resources/ctas', label: 'CTAs' },
                { href: '/admin/resources/context', label: 'Context Mapping' },
                // Hotfix (post-closure): role/CTA management admin —
                // navigation link is UX-only, the actual security gate is
                // canManageResources() on /admin/resources/users itself, so
                // showing this link to a non-manager would only 404/redirect,
                // never leak data.
                { href: '/admin/resources/users', label: 'Users & Roles' },
              ].map((link) => (
                <Link key={link.href} href={link.href} className="rounded-full border border-line px-3 py-1.5 text-sm text-ink hover:bg-gray-50">
                  {link.label}
                </Link>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
