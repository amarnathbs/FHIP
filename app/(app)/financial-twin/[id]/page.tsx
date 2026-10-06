import { PageBackLink } from '@/components/navigation/PageBackLink';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getTwinRunDetail } from '@/lib/services/financialTwinService';
import { TwinDetailView } from '@/components/financial-twin/TwinDetailView';
import { formatDateShort } from '@/lib/engines/date';

async function FinancialTwinRunPageContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', user.id).single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const twin = await getTwinRunDetail(user.id, id);
  if (!twin) notFound();

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Financial Twin™ — {formatDateShort(twin.createdAt, currency)}</h1>
        </div>
        <TwinDetailView twin={twin} currency={currency} />
      </div>
  );
}

// PO review 06-10-2026 F6: every page carries the shared back link to its parent (Twin History).
export default function FinancialTwinRunPage(props: Parameters<typeof FinancialTwinRunPageContent>[0]) {
  return (
    <>
      <PageBackLink href="/financial-twin/history" label="Twin History" />
      <FinancialTwinRunPageContent {...props} />
    </>
  );
}
