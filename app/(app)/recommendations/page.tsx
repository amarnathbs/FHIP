import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RecommendationsPanel } from '@/components/recommendations/RecommendationsPanel';
import { getPlanTier } from '@/lib/services/entitlements';

export default async function RecommendationsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const planTier = await getPlanTier(user.id);

  return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-trust">Recommended Actions</h1>
          <p className="mt-1 text-muted">Rule-based suggestions generated from your recorded data, forecasts and variance history.</p>
        </div>
        <RecommendationsPanel isPremiumUser={planTier === 'premium'} />
      </div>
  );
}
