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
    good: 'ring-positive',
    caution: 'ring-attention',
    risk: 'ring-risk',
    neutral: 'ring-line',
  }[status];
  return (
    <div className={`rounded-card border border-line bg-white p-6 shadow-sm ring-1 ${ring}`} title={tooltip}>
      <p className="text-sm text-muted">{label}</p>
      <p className="mt-2 text-3xl font-semibold tabular-nums text-ink">{value}</p>
      {trend && <p className="mt-1 text-sm text-muted">{trend}</p>}
    </div>
  );
}
