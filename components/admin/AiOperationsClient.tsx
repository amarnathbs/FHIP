'use client';

import { useCallback, useEffect, useState } from 'react';

// Module 11 remediation R4 — Admin AI Operations (brief sections 34-39).
//
// EVERY value on this screen comes from GET /api/admin/ai/operations, which
// composes the pre-existing Module 11.1/11.3 data layer and the R3
// scheduler ledger. There is no sample data, no chart library, no client-
// side derivation of a number the server did not send (section 39).
//
// ADMIN STANDARD §8. Every panel renders exactly one of ok / unavailable /
// suppressed. An unavailable panel says WHY (typically "migration 017x not
// applied"); a suppressed panel shows the fixed label. A genuine zero is
// shown as 0.
//
// ADMIN STANDARD §9. Nothing rendered here identifies a subject: the per-
// subject view is a suppressed distribution, safety events omit user ids.
//
// CONTROLS (section 38). Shown only to callers who hold BOTH
// aiOperationsManage (0177) and isAdmin, because every write goes through
// the pre-existing requireAdmin() routes (kill-switch, models/[id]/enable|
// disable, prompts/[id], providers/[provider], insight-packs/scheduler/run)
// — this screen adds no write pathway of its own. High-impact actions
// require a typed reason and an explicit confirmation; every change is
// audited server-side (ai_config_audit trigger / scheduler runs ledger).

interface Panel<T> { state: 'ok' | 'unavailable' | 'suppressed'; data: T | null; reason: string | null }

interface Overview {
  generated_at: string;
  billing_period: string;
  configuration: Panel<{ provider: string; model: string; timeout_ms: number; max_transient_retries: number; credential_configured: boolean; batch_mode: string; scheduler_max_households_per_run: number }>;
  controls: Panel<Record<string, unknown> & { ai_globally_enabled: boolean; custom_ai_enabled: boolean; live_provider_enabled: boolean; batch_generation_enabled: boolean; contextual_explanations_enabled: boolean; scenario_ai_enabled: boolean; scheduler_enabled?: boolean; next_best_action_enabled?: boolean; kill_switch_reason: string | null; per_user_monthly_cost_ceiling_usd: number; platform_monthly_cost_ceiling_usd: number; max_cost_per_request_usd: number; platform_soft_cost_threshold_usd: number | null; per_user_soft_cost_threshold_usd: number | null; daily_live_ai_cost_limit_usd: number | null; monthly_custom_question_allowance: number; rate_limit_max_requests: number; rate_limit_window_seconds: number; max_context_tokens: number; max_user_input_tokens: number; max_output_tokens: number }>;
  providers: Panel<{ provider: string; enabled: boolean; disabled_reason: string | null; monthly_cost_limit_usd: number | null }[]>;
  models: Panel<{ id: string; provider: string; model_identifier: string; internal_tier: string; active: boolean; approved: boolean; task_types: string[]; cost_input_per_1k_usd: number | null; cost_output_per_1k_usd: number | null; effective_from: string | null; supports_batch: boolean }[]>;
  prompts: Panel<{ id: string; prompt_code: string; prompt_name: string; version: number; task_type: string; status: string; output_schema_version: string }[]>;
  usage: Panel<{ entitled_subjects: number; subjects_with_usage: number; subjects_at_quota: number; custom_questions_used: number; custom_questions_refunded: number; cached_answers_served: number; live_calls: number; input_tokens: number; cached_input_tokens: number; output_tokens: number; estimated_cost_usd: number; actual_cost_usd: number | null; average_cost_per_entitled_subject_usd: number; projected_period_end_cost_usd: number; denials_by_reason: Record<string, number>; events_by_severity: Record<string, number>; provider_executions: number; provider_failures: number }>;
  spend_distribution: Panel<{ subjects_with_spend: number; bands: { label: string; count: number }[]; median_subject_spend_usd: number }>;
  task_cost_limits: Panel<{ id: string; task_type: string; max_cost_per_request_usd: number; max_internal_tier: string; max_monthly_cost_usd: number | null; active: boolean }[]>;
  insight_packs: Panel<{ by_status: Record<string, number>; total: number; ready: number; partial: number; failed: number; stale: number; grounding_failures: number; safety_failures: number; queued_or_generating: number; last_generated_at: string | null }>;
  scheduler: Panel<{ scheduler_enabled: boolean; billing_period: string; jobs_by_status: Record<string, number>; open_batches: number; recent_runs: { id: string; phase: string; triggered_by: string; status: string; dry_run: boolean; started_at: string; finished_at: string | null; discovered_count: number; skipped_count: number; submitted_count: number; reconciled_count: number; failed_count: number; error_summary: string | null }[] }>;
  safety: Panel<{ events_by_severity: Record<string, number>; recent_high: { event_type: string; severity: string; task_type: string | null; provider: string | null; created_at: string; detail: string | null }[]; provider_failures_by_status: Record<string, number> }>;
  config_audit: Panel<{ config_table: string; field: string; previous_value: string | null; new_value: string | null; operation: string; changed_at: string; reason: string | null }[]>;
}

const SWITCHES: { name: string; column: string; label: string; impact: string }[] = [
  { name: 'AI_GLOBAL_ENABLED', column: 'ai_globally_enabled', label: 'Global AI', impact: 'Disabling stops EVERY AI feature for every user immediately.' },
  { name: 'AI_LIVE_PROVIDER_ENABLED', column: 'live_provider_enabled', label: 'Live provider', impact: 'Disabling stops all provider-backed generation (Insight Packs); zero-cost features keep working.' },
  { name: 'AI_BATCH_GENERATION_ENABLED', column: 'batch_generation_enabled', label: 'Batch generation', impact: 'Disabling refuses every Insight Pack admission, manual or scheduled.' },
  { name: 'AI_SCHEDULER_ENABLED', column: 'scheduler_enabled', label: 'Monthly scheduler', impact: 'Enabling lets the unattended cron submit real provider batches and spend money.' },
  { name: 'AI_CUSTOM_QUESTIONS_ENABLED', column: 'custom_ai_enabled', label: 'Custom AI questions', impact: 'Gates user-initiated custom questions (Module 11.7, not yet shipped).' },
  { name: 'AI_CONTEXTUAL_EXPLANATIONS_ENABLED', column: 'contextual_explanations_enabled', label: 'Contextual Explain', impact: 'Disabling removes every Explain control from the product.' },
  { name: 'AI_NEXT_BEST_ACTION_ENABLED', column: 'next_best_action_enabled', label: 'Next Best Action', impact: 'Disabling hides Next Best Action and makes SQ-AI-003/025 unavailable.' },
  { name: 'AI_SCENARIO_ENABLED', column: 'scenario_ai_enabled', label: 'Scenario Coach (11.9)', impact: 'Deferred capability — must stay OFF until Module 11.9 is certified.' },
];

const box: React.CSSProperties = { border: '1px solid rgba(0,0,0,0.12)', borderRadius: 8, padding: '0.9rem 1rem', marginBottom: '1.25rem', background: 'var(--surface, #fff)' };
const grid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '0.6rem' };
const stat: React.CSSProperties = { padding: '0.5rem 0.65rem', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 6 };
const muted: React.CSSProperties = { opacity: 0.7, fontSize: '0.8rem' };
const th: React.CSSProperties = { textAlign: 'left', padding: '0.3rem 0.5rem', borderBottom: '1px solid rgba(0,0,0,0.12)', fontSize: '0.8rem' };
const td: React.CSSProperties = { padding: '0.3rem 0.5rem', borderBottom: '1px solid rgba(0,0,0,0.06)', fontSize: '0.85rem' };
const btn: React.CSSProperties = { padding: '0.3rem 0.65rem', borderRadius: 6, border: '1px solid rgba(0,0,0,0.2)', background: 'transparent', cursor: 'pointer', fontSize: '0.8rem' };

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return <div style={stat}><div style={muted}>{label}</div><div style={{ fontWeight: 600 }}>{value}</div>{note && <div style={muted}>{note}</div>}</div>;
}

function Section<T>({ title, panel, children }: { title: string; panel: Panel<T> | undefined; children: (data: T) => React.ReactNode }) {
  return (
    <section style={box}>
      <h2 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.6rem' }}>{title}</h2>
      {!panel ? <p style={muted}>Not loaded.</p>
        : panel.state === 'unavailable' ? <p><strong>Unavailable.</strong> <span style={muted}>{panel.reason}</span></p>
        : panel.state === 'suppressed' ? <p><strong>Insufficient data to display safely.</strong> <span style={muted}>{panel.reason?.replace('Insufficient data to display safely. ', '')}</span></p>
        : panel.data === null ? <p><strong>Unavailable.</strong></p>
        : children(panel.data)}
    </section>
  );
}

const usd = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `$${Number(v).toFixed(4)}`);
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : 'never');

export default function AiOperationsClient() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [caps, setCaps] = useState<{ manage: boolean; isAdmin: boolean }>({ manage: false, isAdmin: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/ai/operations');
      const j = await r.json();
      if (!r.ok) { setError(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`); return; }
      setOverview(j.data as Overview);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load AI operations');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!cancelled) await load();
      try {
        const j = await (await fetch('/api/admin/me')).json();
        const c = (j?.data?.capabilities ?? {}) as Record<string, unknown>;
        if (!cancelled) setCaps({ manage: c.aiOperationsManage === true, isAdmin: j?.data?.isAdmin === true });
      } catch {
        if (!cancelled) setCaps({ manage: false, isAdmin: false }); // fail closed: no controls
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  async function guarded(label: string, impact: string, run: (reason: string) => Promise<Response>) {
    // Section 38: confirmation + a typed reason for every high-impact action.
    const reason = window.prompt(`${label}\n\n${impact}\n\nType a reason for the audit trail to continue:`);
    if (!reason || !reason.trim()) return;
    if (!window.confirm(`Confirm: ${label}?`)) return;
    setBusy(label); setNotice(null);
    try {
      const r = await run(reason.trim());
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : `Request failed (${r.status})`);
      setNotice(`${label}: done.`);
      await load();
    } catch (e) {
      setNotice(`${label}: ${e instanceof Error ? e.message : 'failed'}`);
    } finally {
      setBusy(null);
    }
  }

  const canManage = caps.manage && caps.isAdmin;

  if (error) return <main style={{ padding: '1.5rem' }}><h1>AI Operations</h1><p><strong>Unavailable.</strong> {error}</p></main>;
  if (!overview) return <main style={{ padding: '1.5rem' }}><h1>AI Operations</h1><p>Loading…</p></main>;

  return (
    <main style={{ padding: '1.5rem', maxWidth: 1200 }}>
      <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>AI Operations</h1>
      <p style={muted}>Module 11 governance — billing period {overview.billing_period}, generated {when(overview.generated_at)}. {canManage ? 'Controls enabled (you hold manage + Super Admin).' : caps.manage ? 'You hold manage but not Super Admin — controls are read-only because every AI write route requires Super Admin.' : 'Read-only view.'}</p>
      {notice && <p style={{ ...box, borderColor: 'rgba(0,0,0,0.3)' }}>{notice}</p>}

      <Section title="Overview — provider, model, switches" panel={overview.configuration}>
        {(cfg) => (
          <>
            <div style={grid}>
              <Stat label="Configured provider" value={cfg.provider} note={cfg.provider === 'openai' ? (cfg.credential_configured ? 'credential configured' : 'CREDENTIAL MISSING (fails closed)') : 'zero-cost mock'} />
              <Stat label="Configured model" value={cfg.model} />
              <Stat label="Batch transport" value={cfg.batch_mode} note={`${cfg.scheduler_max_households_per_run} households / tick`} />
              <Stat label="Timeout / retries" value={`${cfg.timeout_ms} ms / ${cfg.max_transient_retries}`} />
            </div>
            <Section title="Switches (DB, read fresh — no cache)" panel={overview.controls}>
              {(c) => (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr><th style={th}>Switch</th><th style={th}>State</th><th style={th}>Impact</th>{canManage && <th style={th}>Action</th>}</tr></thead>
                  <tbody>
                    {SWITCHES.map((s) => {
                      const v = (c as Record<string, unknown>)[s.column];
                      const state = v === true ? 'ON' : v === false ? 'OFF' : 'unavailable (migration not applied)';
                      return (
                        <tr key={s.name}>
                          <td style={td}>{s.label}<div style={muted}>{s.column}</div></td>
                          <td style={td}><strong>{state}</strong></td>
                          <td style={td}><span style={muted}>{s.impact}</span></td>
                          {canManage && (
                            <td style={td}>
                              {typeof v === 'boolean' && (
                                <button style={btn} disabled={busy !== null} onClick={() => guarded(`${v ? 'Disable' : 'Enable'} ${s.label}`, s.impact, (reason) =>
                                  fetch('/api/admin/ai/kill-switch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ switch: s.name, enabled: !v, reason }) }))}>
                                  {v ? 'Disable' : 'Enable'}
                                </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
            {overview.controls.data?.kill_switch_reason && <p style={muted}>Current kill-switch reason: {overview.controls.data.kill_switch_reason}</p>}
          </>
        )}
      </Section>

      <Section title="Providers" panel={overview.providers}>
        {(rows) => (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Provider</th><th style={th}>Enabled</th><th style={th}>Monthly limit</th><th style={th}>Reason</th>{canManage && <th style={th}>Action</th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.provider}><td style={td}>{p.provider}</td><td style={td}><strong>{p.enabled ? 'ON' : 'OFF'}</strong></td><td style={td}>{p.monthly_cost_limit_usd === null ? 'none' : usd(p.monthly_cost_limit_usd)}</td><td style={td}><span style={muted}>{p.disabled_reason ?? ''}</span></td>
                {canManage && <td style={td}><button style={btn} disabled={busy !== null} onClick={() => guarded(`${p.enabled ? 'Disable' : 'Enable'} provider ${p.provider}`, 'A disabled provider refuses every request routed to it; there is no fallback provider.', (reason) =>
                  fetch(`/api/admin/ai/providers/${encodeURIComponent(p.provider)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !p.enabled, disabled_reason: p.enabled ? reason : null }) }))}>{p.enabled ? 'Disable' : 'Enable'}</button></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>

      <Section title="Models (registry)" panel={overview.models}>
        {(rows) => (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Provider / model</th><th style={th}>Tier</th><th style={th}>Active</th><th style={th}>Approved</th><th style={th}>Tasks</th><th style={th}>Price / 1K (in / out)</th><th style={th}>Batch</th>{canManage && <th style={th}>Action</th>}</tr></thead>
            <tbody>{rows.map((m) => (
              <tr key={m.id}><td style={td}>{m.provider} / {m.model_identifier}</td><td style={td}>{m.internal_tier}</td><td style={td}><strong>{m.active ? 'yes' : 'no'}</strong></td><td style={td}>{m.approved ? 'yes' : 'no'}</td><td style={td}><span style={muted}>{m.task_types.join(', ')}</span></td><td style={td}>{m.cost_input_per_1k_usd === null ? 'unpriced' : `${usd(m.cost_input_per_1k_usd)} / ${usd(m.cost_output_per_1k_usd)}`}<div style={muted}>{m.effective_from ? `from ${m.effective_from.slice(0, 10)}` : ''}</div></td><td style={td}>{m.supports_batch ? 'yes' : 'no'}</td>
                {canManage && <td style={td}><button style={btn} disabled={busy !== null} onClick={() => guarded(`${m.active ? 'Disable' : 'Enable'} model ${m.model_identifier}`, m.active ? 'Requests bound to this model will be refused (model_inactive).' : 'An active + approved model can be executed by real requests and incur cost.', (reason) =>
                  fetch(`/api/admin/ai/models/${m.id}/${m.active ? 'disable' : 'enable'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }))}>{m.active ? 'Disable' : 'Enable'}</button></td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>

      <Section title="Prompts (registry)" panel={overview.prompts}>
        {(rows) => (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>Code</th><th style={th}>v</th><th style={th}>Task</th><th style={th}>Status</th><th style={th}>Output schema</th>{canManage && <th style={th}>Action</th>}</tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}><td style={td}>{p.prompt_code} <span style={muted}>{p.prompt_name}</span></td><td style={td}>{p.version}</td><td style={td}>{p.task_type}</td><td style={td}><strong>{p.status}</strong></td><td style={td}>{p.output_schema_version}</td>
                {canManage && <td style={td}>{p.status === 'ACTIVE'
                  ? <button style={btn} disabled={busy !== null} onClick={() => guarded(`Retire ${p.prompt_code} v${p.version}`, 'Retiring the only ACTIVE prompt for a task makes that task fail closed (no_active_prompt).', () => fetch(`/api/admin/ai/prompts/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'RETIRED' }) }))}>Retire</button>
                  : <button style={btn} disabled={busy !== null} onClick={() => guarded(`Activate ${p.prompt_code} v${p.version}`, 'Activating retires any other ACTIVE version of this code; real requests will use this text.', () => fetch(`/api/admin/ai/prompts/${p.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'ACTIVE' }) }))}>Activate</button>}
                </td>}
              </tr>
            ))}</tbody>
          </table>
        )}
      </Section>

      <Section title="Usage (this billing period)" panel={overview.usage}>
        {(u) => (
          <div style={grid}>
            <Stat label="Entitled subjects" value={u.entitled_subjects} />
            <Stat label="Subjects with usage" value={u.subjects_with_usage} />
            <Stat label="Quota exhausted" value={u.subjects_at_quota} note="subjects at allowance" />
            <Stat label="Live provider calls" value={u.live_calls} />
            <Stat label="Cached / zero-cost answers" value={u.cached_answers_served} />
            <Stat label="Custom questions used" value={u.custom_questions_used} note={`${u.custom_questions_refunded} refunded`} />
            <Stat label="Input tokens" value={u.input_tokens.toLocaleString()} note={`${u.cached_input_tokens.toLocaleString()} cached`} />
            <Stat label="Output tokens" value={u.output_tokens.toLocaleString()} />
            <Stat label="Provider executions" value={u.provider_executions} note={`${u.provider_failures} failed`} />
            <Stat label="Rate-limit denials" value={u.denials_by_reason.rate_limited ?? 0} />
            <Stat label="All denials" value={Object.values(u.denials_by_reason).reduce((a, b) => a + b, 0)} note={Object.entries(u.denials_by_reason).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'} />
          </div>
        )}
      </Section>

      <Section title="Cost" panel={overview.usage}>
        {(u) => (
          <>
            <div style={grid}>
              <Stat label="Estimated spend (period)" value={usd(u.estimated_cost_usd)} />
              <Stat label="Actual spend (reconciled)" value={u.actual_cost_usd === null ? 'not reconciled' : usd(u.actual_cost_usd)} note="null until provider reconciliation exists" />
              <Stat label="Avg per entitled subject" value={usd(u.average_cost_per_entitled_subject_usd)} />
              <Stat label="PROJECTION — period end" value={usd(u.projected_period_end_cost_usd)} note="linear extrapolation of spend so far; not a forecast" />
              {overview.controls.data && <>
                <Stat label="Platform ceiling (hard)" value={usd(overview.controls.data.platform_monthly_cost_ceiling_usd)} note={`soft ${usd(overview.controls.data.platform_soft_cost_threshold_usd)}`} />
                <Stat label="Per-user ceiling (hard)" value={usd(overview.controls.data.per_user_monthly_cost_ceiling_usd)} note={`soft ${usd(overview.controls.data.per_user_soft_cost_threshold_usd)}`} />
                <Stat label="Per-request limit" value={usd(overview.controls.data.max_cost_per_request_usd)} note={`daily live ${usd(overview.controls.data.daily_live_ai_cost_limit_usd)}`} />
              </>}
            </div>
            <Section title="Provider / model breakdown" panel={overview.models}>
              {(models) => <p style={muted}>Priced models: {models.filter((m) => m.cost_input_per_1k_usd !== null).map((m) => `${m.provider}/${m.model_identifier} ${usd(m.cost_input_per_1k_usd)}/${usd(m.cost_output_per_1k_usd)} per 1K`).join('; ') || 'none'}. Per-model spend attribution is on each pack / ai_run row; the ledger rolls up by (subject, task, provider, model).</p>}
            </Section>
            <Section title="Per-subject aggregation (distribution, suppressed below 10 subjects / 5 per band)" panel={overview.spend_distribution}>
              {(d) => d.subjects_with_spend === 0 ? <p>0 subjects with spend this period.</p> : (
                <table style={{ borderCollapse: 'collapse' }}><thead><tr><th style={th}>Band</th><th style={th}>Subjects</th></tr></thead>
                  <tbody>{d.bands.map((b) => <tr key={b.label}><td style={td}>{b.label}</td><td style={td}>{b.count}</td></tr>)}<tr><td style={td}><span style={muted}>median</span></td><td style={td}>{usd(d.median_subject_spend_usd)}</td></tr></tbody></table>
              )}
            </Section>
            <Section title="Task cost limits" panel={overview.task_cost_limits}>
              {(rows) => <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>Task</th><th style={th}>Max / request</th><th style={th}>Max tier</th><th style={th}>Monthly</th><th style={th}>Active</th></tr></thead>
                <tbody>{rows.map((t) => <tr key={t.id}><td style={td}>{t.task_type}</td><td style={td}>{usd(t.max_cost_per_request_usd)}</td><td style={td}>{t.max_internal_tier}</td><td style={td}>{t.max_monthly_cost_usd === null ? 'none' : usd(t.max_monthly_cost_usd)}</td><td style={td}>{t.active ? 'yes' : 'no'}</td></tr>)}</tbody></table>}
            </Section>
          </>
        )}
      </Section>

      <Section title="Insight Packs" panel={overview.insight_packs}>
        {(p) => (
          <div style={grid}>
            <Stat label="Queued / generating" value={p.queued_or_generating} />
            <Stat label="Ready" value={p.ready} />
            <Stat label="Partial" value={p.partial} />
            <Stat label="Failed" value={p.failed} />
            <Stat label="Stale / superseded" value={p.stale} />
            <Stat label="Grounding failures" value={p.grounding_failures} />
            <Stat label="Safety failures" value={p.safety_failures} />
            <Stat label="Last generated" value={when(p.last_generated_at)} />
          </div>
        )}
      </Section>

      <Section title="Monthly scheduler (R3)" panel={overview.scheduler}>
        {(s) => (
          <>
            <div style={grid}>
              <Stat label="Scheduler switch" value={s.scheduler_enabled ? 'ON' : 'OFF'} />
              <Stat label="Open provider batches" value={s.open_batches} />
              {Object.entries(s.jobs_by_status).map(([k, v]) => <Stat key={k} label={`Jobs ${k}`} value={v} note={s.billing_period} />)}
              {Object.keys(s.jobs_by_status).length === 0 && <Stat label="Jobs this period" value={0} />}
            </div>
            {canManage && (
              <p style={{ marginTop: '0.6rem' }}>
                <button style={btn} disabled={busy !== null} onClick={() => guarded('Scheduler DRY RUN (submit)', 'Discovers and classifies eligible households. Writes no job rows and submits nothing.', (reason) => fetch('/api/admin/ai/insight-packs/scheduler/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'submit', dryRun: true, reason }) }))}>Dry run</button>{' '}
                <button style={btn} disabled={busy !== null} onClick={() => guarded('Scheduler SUBMIT (real)', 'Admits eligible households and submits a REAL provider batch — this incurs cost within the configured ceilings.', (reason) => fetch('/api/admin/ai/insight-packs/scheduler/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'submit', dryRun: false, reason }) }))}>Submit now</button>{' '}
                <button style={btn} disabled={busy !== null} onClick={() => guarded('Scheduler RECONCILE', 'Polls open provider batches and persists their results.', (reason) => fetch('/api/admin/ai/insight-packs/scheduler/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phase: 'reconcile', reason }) }))}>Reconcile now</button>
              </p>
            )}
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.6rem' }}>
              <thead><tr><th style={th}>Started</th><th style={th}>Phase</th><th style={th}>By</th><th style={th}>Status</th><th style={th}>Disc / skip / subm / recon / fail</th><th style={th}>Error</th></tr></thead>
              <tbody>{s.recent_runs.map((r) => <tr key={r.id}><td style={td}>{when(r.started_at)}</td><td style={td}>{r.phase}{r.dry_run ? ' (dry)' : ''}</td><td style={td}>{r.triggered_by}</td><td style={td}>{r.status}</td><td style={td}>{r.discovered_count} / {r.skipped_count} / {r.submitted_count} / {r.reconciled_count} / {r.failed_count}</td><td style={td}><span style={muted}>{r.error_summary ?? ''}</span></td></tr>)}
                {s.recent_runs.length === 0 && <tr><td style={td} colSpan={6}>No scheduler runs recorded yet.</td></tr>}</tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="Safety" panel={overview.safety}>
        {(s) => (
          <>
            <div style={grid}>
              {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].map((sev) => <Stat key={sev} label={`Events ${sev}`} value={s.events_by_severity[sev] ?? 0} />)}
              {Object.entries(s.provider_failures_by_status).map(([k, v]) => <Stat key={k} label={`Provider ${k}`} value={v} />)}
              {overview.insight_packs.data && <Stat label="Pack grounding failures" value={overview.insight_packs.data.grounding_failures} />}
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '0.6rem' }}>
              <thead><tr><th style={th}>When</th><th style={th}>Severity</th><th style={th}>Event</th><th style={th}>Task / provider</th><th style={th}>Detail</th></tr></thead>
              <tbody>{s.recent_high.map((e, i) => <tr key={i}><td style={td}>{when(e.created_at)}</td><td style={td}>{e.severity}</td><td style={td}>{e.event_type}</td><td style={td}>{e.task_type ?? ''} {e.provider ?? ''}</td><td style={td}><span style={muted}>{e.detail ?? ''}</span></td></tr>)}
                {s.recent_high.length === 0 && <tr><td style={td} colSpan={5}>No HIGH/CRITICAL operational events.</td></tr>}</tbody>
            </table>
          </>
        )}
      </Section>

      <Section title="Configuration audit (latest 25)" panel={overview.config_audit}>
        {(rows) => (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr><th style={th}>When</th><th style={th}>Table</th><th style={th}>Field</th><th style={th}>From</th><th style={th}>To</th><th style={th}>Reason</th></tr></thead>
            <tbody>{rows.map((r, i) => <tr key={i}><td style={td}>{when(r.changed_at)}</td><td style={td}>{r.config_table}</td><td style={td}>{r.field}</td><td style={td}><span style={muted}>{r.previous_value ?? ''}</span></td><td style={td}>{r.new_value ?? ''}</td><td style={td}><span style={muted}>{r.reason ?? ''}</span></td></tr>)}
              {rows.length === 0 && <tr><td style={td} colSpan={6}>No configuration changes recorded.</td></tr>}</tbody>
          </table>
        )}
      </Section>
    </main>
  );
}
