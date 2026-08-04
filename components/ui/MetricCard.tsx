export function MetricCard({
  label,
  value,
  trend,
  tooltip,
  status = 'neutral',
}: {
  label: string;
  value: string;
  trend?: string;
  tooltip?: string;
  status?: 'good' | 'caution' | 'risk' | 'neutral';
}) {
  const ring = {
    good: 'ring-progress',
    caution: 'ring-caution',
    risk: 'ring-risk',
    neutral: 'ring-gray-200',
  }[status];
  return (
    <div className={`rounded-card border bg-white p-6 shadow-sm ring-1 ${ring}`} title={tooltip}>
      <p className="text-sm text-gray-500">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-gray-900">{value}</p>
      {trend && <p className="mt-1 text-sm text-gray-500">{trend}</p>}
    </div>
  );
}
