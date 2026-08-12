import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { buildForecastReportData, type ForecastReportData } from '@/lib/services/forecastReportData';
import { ForecastReportActions } from '@/components/forecast/ForecastReportActions';
import { ForecastReportContent } from '@/components/forecast/ForecastReportContent';

export default async function ConsolidatedForecastingReportPage({ searchParams }: { searchParams: Promise<{ scenario?: string }> }) {
  const { scenario } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const data: ForecastReportData = await buildForecastReportData(user.id, scenario, supabase);

  return (
      <div className="space-y-6">
        <div className="no-print flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-semibold text-trust">Consolidated Forecasting Report</h1>
          <ForecastReportActions scenario={scenario} />
        </div>
        <ForecastReportContent data={data} />
      </div>
  );
}
