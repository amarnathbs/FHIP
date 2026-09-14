import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
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
      <div className="space-y-6">
        <div>
          {/* App Review 2026-09-14, item (nav audit): this drill-in page had
              NO way back at all — not to /financial-twin/history, not to
              /financial-twin — the only escape was the browser's own back
              button. Same "← Back to X" pattern as goals/[id]/page.tsx. */}
          <Link href="/financial-twin/history" className="text-xs text-muted hover:underline">
            ← Back to Twin History
          </Link>
          <h1 className="mt-2 text-2xl font-semibold text-trust">Financial Twin™ — {formatDateShort(twin.createdAt, currency)}</h1>
        </div>
        <TwinDetailView twin={twin} currency={currency} />
      </div>
  );
}
