export function Methodology({ modelVersion, confidence }: { modelVersion: string; confidence: number }) {
  return (
    <details className="rounded-card border bg-white p-6">
      <summary className="cursor-pointer text-sm font-medium text-gray-800">How this was calculated</summary>
      <div className="mt-3 space-y-2 text-sm text-gray-600">
        <p>
          Financial Resilience is calculated deterministically across six weighted components: Emergency Fund
          Adequacy (25%), Liquidity Strength (15%), Income Resilience (15%), Insurance & Protection (20%), Debt &
          Commitment Pressure (15%) and Concentration & Exposure Risk (10%). Weights and score bands are
          admin-configurable and versioned — never hardcoded per calculation.
        </p>
        <p>
          Accessible emergency resources exclude cash already committed to known upcoming outflows recorded in your
          Future Financial Commitments register. Components with insufficient data are excluded from scoring (not
          scored as zero) and weights are re-distributed across the components that could be calculated.
        </p>
        <p>Model version: {modelVersion}</p>
        <p>Confidence in this calculation: {confidence.toFixed(0)}%</p>
        <p className="text-xs text-gray-400">
          This information is educational only and does not constitute personal financial product advice.
        </p>
      </div>
    </details>
  );
}
