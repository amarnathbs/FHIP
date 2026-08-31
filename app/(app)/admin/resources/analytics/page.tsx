import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canViewResourceAnalytics } from '@/lib/resources/permissions';

// /admin/resources/analytics — Analytics Intelligence Centre route shell
// (Analyst Analytics Phase A, Wave 1, task T1.3).
//
// WAVE 1 CONTAINS NO ANALYTICS. There is no metric, no aggregate, no count,
// no sample figure, no chart, no export control and no telemetry on this
// page, and it makes no analytics API or database call of any kind. Every
// analytics surface (A3-A8) belongs to a later, separately authorised wave.
//
// Access is re-derived on the server here, independently of navigation
// visibility (Admin Architecture Standard §4: hiding a link is never a
// security control, and every capability must be enforced at the route
// layer as well as the nav layer):
//
//   - logged out                     -> requireResourceAdminAccess() redirects to /login
//   - authenticated, no Resources    -> requireResourceAdminAccess() redirects to /dashboard
//     role
//   - holds a Resources role but not -> redirected to /admin/resources below
//     the Analytics capability
//     (Author / Editor / Compliance
//     Reviewer / Publisher only)
//   - Analyst, Resource Admin,       -> permitted
//     Super Admin, or any multi-role
//     combination including one of
//     those
//
// The redirect convention is the same one /admin/resources/users already
// uses for its own stricter-than-the-shell gate (canManageResources): a
// graceful redirect rather than a rendered-but-empty page, so a denied
// caller is never shown a surface that looks like it holds no data.
export default async function ResourceAnalyticsPage() {
  const current = await requireResourceAdminAccess();
  if (!canViewResourceAnalytics(current)) redirect('/admin/resources');

  // Layout follows the sibling Resources Admin screens exactly (a plain
  // `space-y-6` stack using the design-system ink/muted/line/card tokens):
  // AppShell's own <main> already supplies the page padding and the sole
  // `main` landmark, so this page adds neither.
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Analytics Intelligence Centre</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          A read-only Admin analytics area. Nothing here creates, edits, approves, schedules or publishes content, and
          nothing here reads an individual person&rsquo;s records.
        </p>
      </header>

      <section aria-labelledby="analytics-status-heading" className="max-w-2xl rounded-card border border-line bg-white p-4">
        <h2 id="analytics-status-heading" className="text-base font-semibold text-ink">
          No analytics surfaces are available yet
        </h2>
        <p className="mt-1 text-sm text-muted">
          This area has been created ahead of the reporting it will hold. Its analytics surfaces are being introduced in
          subsequent authorised waves, and no figures of any kind are shown until then. Nothing on this page is a
          placeholder for a real value.
        </p>
      </section>
    </div>
  );
}
