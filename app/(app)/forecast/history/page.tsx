import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { getOrCreateForecastProfile, listForecastRuns } from '@/lib/services/forecastData';
import { ForecastHistoryList } from '@/components/forecast/ForecastHistoryList';

export default async function ForecastHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: profileRow } = await supabase.from('user_profiles').select('preferred_currency').eq('user_id', user.id).single();
  const currency = (profileRow?.preferred_currency as 'AUD' | 'INR') ?? 'AUD';

  const profile = await getOrCreateForecastProfile(user.id, supabase);
  const runs = await listForecastRuns(user.id, profile.id, supabase);

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Forecast History</h1>
          <p className="mt-1 text-muted">Every forecast run is kept so you can compare how projections have changed over time.</p>
        </div>
        <SectionCard title="Runs">
          <ForecastHistoryList initialRuns={runs} currency={currency} />
        </SectionCard>
      </div>
  );
}
