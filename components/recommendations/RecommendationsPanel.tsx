'use client';

import { useEffect, useState } from 'react';
import { SectionCard } from '@/components/dashboard/SectionCard';

interface Recommendation {
  id: string;
  recommendationCode: string;
  forecastCategory: string;
  subCategory: string;
  actionTitleTemplate: string;
  actionContentTemplate: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  isPremium: boolean;
}
interface Match {
  id: string;
  recommendation: Recommendation;
  evaluatedImpactText: string | null;
  dismissed: boolean;
}

const CATEGORY_LABEL: Record<string, string> = {
  net_worth: 'Net Worth',
  retirement: 'Retirement',
  goal: 'Goals',
  debt: 'Debt',
  investment_growth: 'Investments',
  cross_border: 'Cross-Border',
  resilience: 'Resilience',
  data_quality: 'Data Quality',
};

const SEVERITY_CLASS: Record<string, string> = {
  low: 'bg-gray-100 text-gray-600',
  medium: 'bg-caution/10 text-caution',
  high: 'bg-risk/10 text-risk',
  critical: 'bg-risk/20 text-risk',
};

export function RecommendationsPanel({ isPremiumUser }: { isPremiumUser: boolean }) {
  const [matches, setMatches] = useState<Match[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recommendations');
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not load recommendations');
      setMatches(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
     
  }, []);

  async function regenerate() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not refresh recommendations');
      setMatches(json.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function dismiss(matchId: string) {
    setMatches((prev) => prev?.map((m) => (m.id === matchId ? { ...m, dismissed: true } : m)) ?? null);
    try {
      await fetch(`/api/recommendations/${matchId}/dismiss`, { method: 'POST' });
    } catch {
      // best-effort — a failed dismiss just reappears on next refresh
    }
  }

  const visible = matches?.filter((m) => !m.dismissed) ?? [];

  return (
    <SectionCard
      title="Recommended Actions"
      description="Deterministic, rule-based suggestions generated from your forecast performance — not personalised financial advice."
    >
      <div className="mb-4 flex items-center gap-3">
        <button onClick={regenerate} disabled={loading} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-60">
          {loading ? 'Checking...' : 'Refresh recommendations'}
        </button>
      </div>

      {error && <p className="text-sm text-risk">{error}</p>}

      {!loading && visible.length === 0 && !error && (
        <p className="text-sm text-gray-500">No recommendations apply to your current forecasts — check back after your next forecast update.</p>
      )}

      <div className="space-y-3">
        {visible.map((m) => {
          const locked = m.recommendation.isPremium && !isPremiumUser;
          return (
            <div key={m.id} className="rounded border p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                    {CATEGORY_LABEL[m.recommendation.forecastCategory] ?? m.recommendation.forecastCategory}
                  </span>
                  <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${SEVERITY_CLASS[m.recommendation.severity]}`}>{m.recommendation.severity}</span>
                  {m.recommendation.isPremium && (
                    <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Premium</span>
                  )}
                  <p className="mt-1 font-semibold text-gray-900">{m.recommendation.actionTitleTemplate}</p>
                </div>
                <button onClick={() => dismiss(m.id)} className="text-xs text-gray-400 hover:text-risk">
                  Dismiss
                </button>
              </div>
              {locked ? (
                <div className="mt-3 rounded border border-dashed border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                  Upgrade to Premium to see the full recommended action and its estimated impact.
                </div>
              ) : (
                <>
                  <p className="mt-3 text-sm font-medium text-gray-800">{m.recommendation.actionContentTemplate}</p>
                  {m.evaluatedImpactText && <p className="mt-1 text-xs text-gray-500">{m.evaluatedImpactText}</p>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}
