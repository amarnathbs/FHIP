import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { IMPORT_DESTINATIONS, NOT_SUPPORTED_FOR_IMPORT, importDestinationFor } from './importDestinations';

/**
 * RETIRED (PO decision D-13, WP-08 / UPL-03 / GAP-11 hub part).
 *
 * This used to be the generic FDH-3 upload page: it accepted bank, card,
 * loan, payslip, investment, super, EPF, NPS, tax and "other" documents, but
 * had no process or Apply path behind it -- every upload sat in `queued`
 * forever with no explanation, and a payslip uploaded here was never read.
 * Every supported document type now has a real import on its own tab, so
 * this page no longer accepts uploads anywhere. `?type=<document_type>`
 * redirects straight to the right tab (old links); otherwise it lists where
 * each type is imported and says plainly which types cannot be imported yet.
 */
export default async function FinancialDataHubPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { type } = await searchParams;
  const destination = importDestinationFor(type);
  if (destination) redirect(destination);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Import a financial document</h1>
        <p className="mt-1 text-muted">
          Documents are imported on the page they belong to, where you review what was read and approve it. Choose where to go:
        </p>
      </div>
      <ul className="space-y-2">
        {IMPORT_DESTINATIONS.map((d) => (
          <li key={d.href} className="rounded border border-gray-200 px-4 py-3 text-sm">
            <Link href={d.href} className="font-semibold text-trust hover:underline">Go to {d.label}</Link>
            <span className="block text-muted">{d.what}</span>
          </li>
        ))}
      </ul>
      <div className="rounded border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        <p className="font-medium">Not supported for import yet</p>
        <p className="mt-1">
          {NOT_SUPPORTED_FOR_IMPORT.map((n) => n.label).join(', ')} cannot be imported. You can still enter these figures yourself
          on the matching page.
        </p>
      </div>
      <p className="text-sm">
        <Link href="/financial-data-hub/activity" className="text-trust hover:underline">See your approved financial activity</Link>
      </p>
    </div>
  );
}
