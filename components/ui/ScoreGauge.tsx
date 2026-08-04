const BANDS = [
  { min: 90, label: 'Excellent', color: '#0E9F8E' },
  { min: 80, label: 'Very Good', color: '#3AA76D' },
  { min: 70, label: 'Good', color: '#8AB917' },
  { min: 60, label: 'Fair', color: '#D98A00' },
  { min: 50, label: 'Needs Improvement', color: '#E06A1B' },
  { min: 0, label: 'High Risk', color: '#C0392B' },
];

export function ScoreGauge({ score }: { score: number }) {
  const band = BANDS.find((b) => score >= b.min)!;
  return (
    <div className="flex flex-col items-center rounded-card border bg-white p-6">
      <div className="text-5xl font-bold" style={{ color: band.color }}>
        {Math.round(score)}
      </div>
      <div className="mt-1 text-sm font-medium" style={{ color: band.color }}>
        {band.label}
      </div>
      <div className="mt-3 h-2 w-full rounded-full bg-gray-100">
        <div className="h-2 rounded-full" style={{ width: `${score}%`, background: band.color }} />
      </div>
    </div>
  );
}
