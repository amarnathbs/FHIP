import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isFdhDocumentUploadEnabled } from '@/lib/financial-data-hub/constants/featureFlags';
import { FdhDocumentUploadClient } from '@/components/financial-data-hub/FdhDocumentUploadClient';

// The FDH-3 standalone upload experience (spec section 36). Deliberately
// NOT linked from the main app navigation yet — document upload remains
// disabled in production (spec sections 61-62/110) and this page is for
// local/DEV use and certification. Direct-navigation only.
export default async function FinancialDataHubPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-trust">Financial Data Hub</h1>
        <p className="mt-1 text-muted">
          Upload a bank, credit card, loan, payslip, investment or superannuation statement to help FHIP
          prepare structured financial information for your review.
        </p>
      </div>

      <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
        <p className="font-medium">What happens to your document</p>
        <p className="mt-1">
          Upload &rarr; secure processing &rarr; your review &rarr; your approval &rarr; the raw document is
          then scheduled for deletion.
        </p>
        <p className="mt-2">
          Your uploaded financial document is private and is not available for routine admin viewing. Once
          the relevant information has been processed and approved, the raw document is scheduled for
          deletion according to FHIP&apos;s retention policy — it is not kept as a permanent record.
        </p>
      </div>

      <FdhDocumentUploadClient uploadEnabled={isFdhDocumentUploadEnabled()} />
    </div>
  );
}
