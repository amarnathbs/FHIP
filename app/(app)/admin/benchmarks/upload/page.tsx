// Planning Benchmarks staged upload - direct-URL entry (Admin Standard section 4, layer 3).
// A caller without the upload or activate capability is REDIRECTED, never shown an empty page. The same
// component is the Upload tab on /admin/benchmarks; the API enforces its own capability on every verb.
import { requirePlanningBenchmarkPage } from '@/lib/planning-benchmarks/guards';
import { PlanningBenchmarkUpload } from '@/components/admin/PlanningBenchmarkUpload';

export const dynamic = 'force-dynamic';

export default async function PlanningBenchmarkUploadPage() {
  await requirePlanningBenchmarkPage('view');
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-ink">Upload planning benchmarks</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Stage a filled template, check it against the live figures, then activate it. Nothing is served to users until an authorised administrator activates it.
        </p>
      </div>
      <PlanningBenchmarkUpload />
    </div>
  );
}
