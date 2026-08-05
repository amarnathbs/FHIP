import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { listTwinRuns, getTwinRunDetail } from '@/lib/services/financialTwinService';
import { GenerateTwinButton } from '@/components/financial-twin/GenerateTwinButton';
import { TwinDetailView } from '@/components/financial-twin/TwinDetailView';

export default async function FinancialTwinPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profile } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', user.id).single();
  const currency = (profile?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const runs = await listTwinRuns(user.id);
  const latest = runs.length > 0 ? await getTwinRunDetail(user.id, runs[0].id) : null;

  return (
    <AppShell>
      <div className="space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-trust">Financial Twin™</h1>
            <p className="mt-1 text-muted">
              See how your household compares with a similar synthetic peer profile, an indicative healthy planning range, and your
              own projected future position.
            </p>
          </div>
          <GenerateTwinButton label={latest ? 'Regenerate' : 'Generate Financial Twin'} />
        </div>

        {latest ? (
          <TwinDetailView twin={latest} currency={currency} />
        ) : (
          <div className="rounded-card border border-dashed bg-gray-50 p-8 text-center">
            <p className="text-gray-700">
              No Financial Twin has been generated yet. Complete your country, age, household and financial information, then
              generate your first comparison.
            </p>
          </div>
        )}

        {runs.length > 1 && (
          <SectionCard title="History">
            <p className="text-sm text-muted">
              {runs.length} Financial Twin runs recorded.{' '}
              <Link href="/financial-twin/history" className="text-trust hover:underline">
                View history
              </Link>
            </p>
          </SectionCard>
        )}
      </div>
    </AppShell>
  );
}
