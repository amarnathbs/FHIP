import { createClient } from '@/lib/supabase/server';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { isResourceStaff } from '@/lib/resources/permissions';
import { gatherHomeQueues } from '@/lib/admin/homeQueues';

// Admin A2 — Admin Home (docs/admin/A1_09_ADMIN_HOME_SPEC.md, PO-3 APPROVED
// as designed: a role-aware operational work queue, never a metrics
// dashboard).
//
// Access: reuses requireResourceAdminAccess() verbatim (redirects a
// logged-out caller to /login, a caller with no Resources role and no
// admin_users row to /dashboard) — the same gate admin/resources/analytics
// already uses, so a role-less "Role-less authenticated user" persona
// (A1_07 §3) never sees an Admin entry point, exactly as specified.
//
// This page never replaces or duplicates admin/resources/page.tsx's own
// dashboard (A1_08 §8, PO-3): every item here answers who it's for (via
// gating in lib/admin/homeQueues.ts), what needs doing, by when, the
// consequence of inaction, and which page completes it (A1_09 §1) — it is
// not a page of "interesting" counts.
export default async function AdminHomePage() {
  const current = await requireResourceAdminAccess();
  const supabase = await createClient();
  const { items, recentActivity, recentActivityError } = await gatherHomeQueues(supabase, current);

  const showsNoContentContext = !isResourceStaff(current) && !current.isSuperAdmin;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Admin Home</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          A role-aware work queue — every item below names what needs doing, by when, what happens if it isn&rsquo;t done, and
          where to complete it. This page never shows vanity metrics, individual users&rsquo; financial information, or
          summaries you aren&rsquo;t authorised to see.
        </p>
      </header>

      <section aria-labelledby="home-attention-heading" className="space-y-3">
        <h2 id="home-attention-heading" className="text-base font-semibold text-ink">
          What needs your attention
        </h2>
        {items.length === 0 ? (
          <div className="rounded-card border border-line bg-white p-4">
            <p className="text-sm text-muted">Nothing needs your attention right now.</p>
            {showsNoContentContext && (
              <p className="mt-2 text-sm text-muted">
                Analytics summaries for your account are not available yet — no Analytics surface has real data to show
                (see the Analytics area once it is built).
              </p>
            )}
          </div>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-card border border-line bg-white p-4">
                <p className="text-sm font-semibold text-ink">{item.title}</p>
                {item.state === 'error' ? (
                  <p className="mt-2 text-sm text-risk">{item.errorMessage ?? 'Something went wrong. Please try again.'}</p>
                ) : item.count === 0 ? (
                  <p className="mt-2 text-sm text-muted">{item.emptyMessage}</p>
                ) : (
                  <>
                    <p className="mt-2 text-2xl font-semibold text-trust">{item.count}</p>
                    <dl className="mt-2 space-y-1 text-xs text-muted">
                      <div className="flex gap-1">
                        <dt className="font-medium text-ink">By when:</dt>
                        <dd>{item.byWhen}</dd>
                      </div>
                      <div className="flex gap-1">
                        <dt className="font-medium text-ink">If not done:</dt>
                        <dd>{item.consequence}</dd>
                      </div>
                    </dl>
                  </>
                )}
                <a href={item.completesHref} className="mt-3 inline-block text-sm font-medium text-trust hover:underline">
                  Go to {item.completesLabel} &rsaquo;
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(recentActivity || recentActivityError) && (
        <section aria-labelledby="home-recent-heading" className="space-y-3">
          <h2 id="home-recent-heading" className="text-base font-semibold text-ink">
            Recently updated content
          </h2>
          <div className="rounded-card border border-line bg-white p-4">
            {recentActivityError ? (
              <p className="text-sm text-risk">{recentActivityError}</p>
            ) : recentActivity && recentActivity.length > 0 ? (
              <ul className="divide-y divide-line">
                {recentActivity.map((post) => (
                  <li key={post.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate text-ink">{post.title}</span>
                    <span className="shrink-0 text-xs text-muted">{post.status}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No recent content activity.</p>
            )}
          </div>
        </section>
      )}

      <section aria-labelledby="home-notices-heading" className="space-y-3">
        <h2 id="home-notices-heading" className="text-base font-semibold text-ink">
          System, security and privacy notices
        </h2>
        <div className="rounded-card border border-line bg-white p-4">
          <p className="text-sm text-muted">
            No security or privacy alerting exists yet — the canonical audit sink and security-event stream are a later,
            separately authorised stage (A4). This section will show unresolved high/critical security events and
            active support-access grants once that stage ships. Nothing is fabricated here in the meantime.
          </p>
        </div>
      </section>

      <section aria-labelledby="home-help-heading" className="space-y-2">
        <h2 id="home-help-heading" className="text-base font-semibold text-ink">
          Need help with a task?
        </h2>
        <p className="max-w-2xl text-sm text-muted">
          Open any task&rsquo;s own page — every operational Admin page carries a &ldquo;How to use this page&rdquo;
          disclosure with the exact steps, who can perform it, and how to undo it.
        </p>
      </section>
    </div>
  );
}
