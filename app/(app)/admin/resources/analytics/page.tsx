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

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header>
        <h1 className="text-2xl font-semibold text-slate-900">Analytics Intelligence Centre</h1>
        <p className="mt-2 text-sm text-slate-600">
          A read-only Admin analytics area. Nothing here creates, edits, approves, schedules or publishes content, and
          nothing here reads an individual person&rsquo;s records.
        </p>
      </header>

      <section aria-labelledby="analytics-status-heading" className="mt-8 rounded-lg border border-slate-200 bg-slate-50 p-6">
        <h2 id="analytics-status-heading" className="text-base font-semibold text-slate-900">
          No analytics surfaces are available yet
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          This area has been created ahead of the reporting it will hold. Its analytics surfaces are being introduced in
          subsequent authorised waves, and no figures of any kind are shown until then. Nothing on this page is a
          placeholder for a real value.
        </p>
      </section>
    </div>
  );
}
