'use client';

// Module 11.4 — the consumer-facing standard question library UI (spec
// sections 35-46, 67-69). No free-text input anywhere: the only inputs are
// clicking a catalogue question button and, for SQ-AI-021 only, clicking one
// of the caller's OWN eligible off-track goals returned by the server.

import { useCallback, useEffect, useState } from 'react';
import { LockedFeatureCard } from '@/components/ui/LockedFeatureCard';

interface CatalogueQuestion {
  standard_question_code: string;
  question: string;
  category: string;
  status: string;
  related_module: string;
  action_route: string;
  requires_target: 'goal' | null;
}

interface AnswerResponse {
  standard_question_code: string;
  question: string;
  status: string;
  answer: { headline: string; summary: string; key_points: string[]; limitations: string[] } | null;
  answer_origin_labels: string[];
  data_as_of: string | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null;
  related_module: string;
  action_route: string;
  provider_called: false;
  custom_quota_consumed: false;
  eligible_targets?: { id: string; label: string }[];
}

const CATEGORY_LABELS: Record<string, string> = {
  FINANCIAL_OVERVIEW: 'Financial overview',
  SCORE_AND_BEHAVIOUR: 'Score & financial behaviour',
  CASH_FLOW: 'Cash flow',
  BALANCE_SHEET_AND_LIQUIDITY: 'Balance sheet & liquidity',
  INVESTMENTS_AND_RETIREMENT: 'Investments & retirement',
  PROTECTION: 'Protection',
  GOALS_AND_FORECAST: 'Goals & forecast',
  BENCHMARK_AND_CROSS_BORDER: 'Benchmark & cross-border',
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

// Section 39 — restrained, no-internal-enum-names status wording.
const STATUS_LABELS: Record<string, string> = {
  AVAILABLE: 'Available',
  PREMIUM_REQUIRED: 'Premium feature',
  INSUFFICIENT_DATA: 'Needs more information',
  DOMAIN_UNAVAILABLE: 'Not available for your financial setup',
  STALE: 'Based on older data',
  NOT_APPLICABLE: 'Not applicable',
  COUNTRY_NOT_APPLICABLE: 'Not applicable',
  PACK_NOT_READY: 'Personalised insight is being prepared',
  DEFERRED_CAPABILITY: 'Scenario feature coming later',
  FEATURE_DISABLED: 'Temporarily unavailable',
  TARGET_REQUIRED: 'Select a goal',
  TARGET_NOT_FOUND: 'Not available',
};

function StatusBadge({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status;
  const dim = status !== 'AVAILABLE';
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs ${dim ? 'bg-gray-100 text-gray-600' : 'bg-green-50 text-green-700'}`}>
      {label}
    </span>
  );
}

export function StandardQuestionLibrary() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entitled, setEntitled] = useState(true);
  const [questions, setQuestions] = useState<CatalogueQuestion[]>([]);
  const [selected, setSelected] = useState<CatalogueQuestion | null>(null);
  const [answer, setAnswer] = useState<AnswerResponse | null>(null);
  const [answerLoading, setAnswerLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/ai/standard-questions');
        const body = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? 'Could not load your insights right now.');
        } else {
          setEntitled(Boolean(body.data.entitled));
          setQuestions(body.data.questions ?? []);
        }
      } catch {
        if (!cancelled) setError('Could not load your insights right now.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const askQuestion = useCallback(async (question: CatalogueQuestion, goalId?: string) => {
    setSelected(question);
    setAnswer(null);
    setAnswerLoading(true);
    try {
      const res = await fetch(`/api/ai/standard-questions/${question.standard_question_code}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(goalId ? { goal_id: goalId } : {}),
      });
      const body = await res.json();
      if (res.ok) setAnswer(body.data as AnswerResponse);
    } finally {
      setAnswerLoading(false);
    }
  }, []);

  if (loading) {
    return <p className="text-sm text-muted" role="status">Loading your insights…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-600" role="alert">{error}</p>;
  }
  if (!entitled) {
    return (
      <LockedFeatureCard
        title="Your Financial Insights is a Premium feature"
        description="Upgrade to Premium to get instant, personalised answers to common questions about your finances — at no extra cost per question."
      />
    );
  }

  const byCategory = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat],
    items: questions.filter((q) => q.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
      <div className="space-y-6">
        <p className="text-xs text-muted">These standard insights do not use your custom AI question allowance.</p>
        {byCategory.map((group) => (
          <section key={group.category} aria-labelledby={`group-${group.category}`}>
            <h2 id={`group-${group.category}`} className="mb-2 text-sm font-semibold text-ink">
              {group.label}
            </h2>
            <ul className="flex flex-wrap gap-2">
              {group.items.map((question) => {
                const available = question.status === 'AVAILABLE';
                return (
                  <li key={question.standard_question_code}>
                    <button
                      type="button"
                      onClick={() => askQuestion(question)}
                      aria-current={selected?.standard_question_code === question.standard_question_code}
                      className={`min-h-[44px] rounded-card border px-3 py-2 text-left text-sm ${
                        available ? 'border-line bg-white hover:bg-gray-50' : 'border-dashed border-gray-200 bg-gray-50 text-gray-500'
                      }`}
                    >
                      <span className="block">{question.question}</span>
                      <StatusBadge status={question.status} />
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <div className="rounded-card border border-line bg-white p-6" aria-live="polite">
        {!selected && <p className="text-sm text-muted">Select a question to see your answer.</p>}
        {selected && answerLoading && <p className="text-sm text-muted" role="status">Loading your insight…</p>}
        {selected && !answerLoading && answer && (
          <div>
            <h2 className="text-lg font-semibold text-ink">{answer.question}</h2>
            {answer.status !== 'AVAILABLE' && !answer.eligible_targets && (
              <p className="mt-2 text-sm text-muted">{STATUS_LABELS[answer.status] ?? answer.status}</p>
            )}
            {answer.eligible_targets && answer.eligible_targets.length > 0 && (
              <div className="mt-3">
                <p className="text-sm text-muted">Which goal?</p>
                <ul className="mt-2 flex flex-wrap gap-2">
                  {answer.eligible_targets.map((t) => (
                    <li key={t.id}>
                      <button
                        type="button"
                        className="min-h-[44px] rounded-card border border-line bg-white px-3 py-2 text-sm hover:bg-gray-50"
                        onClick={() => selected && askQuestion(selected, t.id)}
                      >
                        {t.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {answer.answer && (
              <div className="mt-3 space-y-3">
                <p className="font-medium text-ink">{answer.answer.headline}</p>
                <p className="text-sm text-muted">{answer.answer.summary}</p>
                {answer.answer.key_points.length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                    {answer.answer.key_points.map((point, i) => (
                      <li key={i}>{point}</li>
                    ))}
                  </ul>
                )}
                {answer.answer.limitations.length > 0 && (
                  <ul className="space-y-1 text-xs text-gray-500">
                    {answer.answer.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  {answer.answer_origin_labels.map((label, i) => (
                    <span key={i} className="rounded-full bg-gray-100 px-2 py-0.5">{label}</span>
                  ))}
                  {answer.data_as_of && <span>Data as of {answer.data_as_of}</span>}
                  {answer.confidence && <span>Confidence: {answer.confidence.toLowerCase()}</span>}
                </div>
                <a href={answer.action_route} className="inline-block text-sm font-medium text-brand hover:underline">
                  View in {answer.related_module.replace(/_/g, ' ')} →
                </a>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
