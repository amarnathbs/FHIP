import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { getTwinRunDetail } from '@/lib/services/financialTwinService';
import { TwinDetailView } from '@/components/financial-twin/TwinDetailView';
import { formatDateShort } from '@/lib/engines/date';

export default async function FinancialTwinRunPage({ params }: { params: Promise<{ id: string }> }) {
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
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-trust">Financial Twin™ — {formatDateShort(twin.createdAt, currency)}</h1>
        <TwinDetailView twin={twin} currency={currency} />
      </div>
    </AppShell>
  );
}
