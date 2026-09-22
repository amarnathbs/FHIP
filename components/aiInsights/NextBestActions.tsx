'use client';

// Module 11.6 — the consumer-facing Next Best Action panel (brief sections
// 40-48). Read-only: it renders whatever GET /api/ai/next-best-actions
// returns for the signed-in household. No input of any kind reaches the
// server from this component (no body, no query), so there is nothing a
// client can tamper with. 0 actions is a real, honest state ("nothing
// stands out right now"), never padded.

import { useEffect, useState } from 'react';

interface NbaAction {
  rank: number;
  action_code: string;
  title: string;
  tier: string;
  severity: string;
  explanation: string;
  evidence: { label: string; value: string; source_path: string }[];
  source_ref: string;
  related_module: string;
  action_route: string;
}

interface NbaPayload {
  status: 'AVAILABLE' | 'NO_ACTIONS' | 'PREMIUM_REQUIRED' | 'FEATURE_DISABLED' | 'INSUFFICIENT_DATA';
  note: string;
  provider_called: false;
  custom_quota_consumed: false;
  rules_version: string | null;
  ranking_policy_version: string | null;
  actions: NbaAction[];
}

const STATUS_TEXT: Record<NbaPayload['status'], string> = {
  AVAILABLE: '',
  NO_ACTIONS: 'Nothing stands out right now. FHIP found no certified status that calls for an action this month.',
  PREMIUM_REQUIRED: 'Next Best Action is a Premium feature.',
  FEATURE_DISABLED: 'Next Best Action is temporarily unavailable.',
  INSUFFICIENT_DATA: 'FHIP needs more of your financial information before it can suggest an action.',
};

export function NextBestActions() {
  const [payload, setPayload] = useState<NbaPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/api/ai/next-best-actions');
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) { setError(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`); return; }
        setPayload(j.data as NbaPayload);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load next best actions');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-4" aria-labelledby="nba-heading">
      <h2 id="nba-heading" className="text-lg font-semibold text-trust">Next Best Action</h2>
      <p className="mt-1 text-sm text-muted">Up to three things to look at first, chosen and ordered by FHIP&apos;s own rules from your certified data. No AI model picks or orders these.</p>
      {error && <p className="mt-3 text-sm"><strong>Unavailable.</strong> {error}</p>}
      {!error && !payload && <p className="mt-3 text-sm text-muted">Loading…</p>}
      {payload && payload.status !== 'AVAILABLE' && <p className="mt-3 text-sm">{STATUS_TEXT[payload.status]}</p>}
      {payload && payload.status === 'AVAILABLE' && (
        <ol className="mt-3 space-y-3">
          {payload.actions.map((a) => (
            <li key={a.action_code} className="rounded-md border border-gray-100 p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-ink">{a.rank}. {a.title}</div>
                  <div className="text-xs text-muted">{a.tier.toLowerCase().replace('_', ' ')} · {a.severity}</div>
                </div>
                <button type="button" className="text-xs font-semibold text-trust hover:underline" aria-expanded={open === a.rank} onClick={() => setOpen(open === a.rank ? null : a.rank)}>
                  {open === a.rank ? 'Hide why' : 'Why this?'}
                </button>
              </div>
              {open === a.rank && (
                <div className="mt-2 text-sm">
                  <p>{a.explanation}</p>
                  <ul className="mt-2 list-disc pl-5 text-xs text-muted">
                    {a.evidence.map((e, i) => <li key={i}>{e.label}: {e.value}</li>)}
                  </ul>
                  <a href={a.action_route} className="mt-2 inline-block text-xs font-semibold text-trust hover:underline">Open {a.related_module.replace('_', ' ')}</a>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {payload && <p className="mt-3 text-xs text-muted">{payload.note}{payload.rules_version ? ` (${payload.rules_version}, ${payload.ranking_policy_version})` : ''}</p>}
    </section>
  );
}
