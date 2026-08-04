import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { AppShell } from '@/components/ui/AppShell';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { listTwinRuns } from '@/lib/services/financialTwinService';

export default async function FinancialTwinHistoryPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const runs = await listTwinRuns(user.id);

  return (
    <AppShell>
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-trust">Financial Twin History</h1>
        <SectionCard title="Past runs">
          <div className="divide-y">
            {runs.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium text-gray-800">{new Date(r.createdAt).toLocaleDateString('en-AU')}</p>
                  <p className="text-xs text-gray-500">
                    {r.metricsCompared} metrics compared · {r.aheadCount} ahead · {r.behindCount} below · Confidence{' '}
                    {r.overallConfidence?.toFixed(0) ?? '—'}%
                  </p>
                </div>
                <Link href={`/financial-twin/${r.id}`} className="rounded border px-3 py-1.5 text-trust hover:border-trust">
                  View
                </Link>
              </div>
            ))}
            {runs.length === 0 && <p className="py-4 text-gray-400">No Financial Twin runs yet.</p>}
          </div>
        </SectionCard>
      </div>
    </AppShell>
  );
}
