'use client';

import { useEffect, useMemo, useState } from 'react';

interface Condition {
  id?: string;
  condition_group: number;
  field_name: string;
  operator: string;
  comparison_value: string;
}
interface Recommendation {
  id: string;
  recommendation_code: string;
  trigger_type: 'forecast_variance' | 'score_pillar';
  // Null exactly when trigger_type is the other kind (migration 0025's
  // action_recommendation_master_trigger_fields_check).
  forecast_category: string | null;
  forecast_status: string | null;
  pillar_code: string | null;
  score_band: string | null;
  sub_category: string;
  scenario_name: string;
  scenario_description: string | null;
  variance_result: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical';
  action_type: string;
  action_title_template: string;
  action_content_template: string;
  financial_impact_template: string | null;
  calculation_method_code: string | null;
  priority_score: number;
  is_premium: boolean;
  is_active: boolean;
  include_in_forecasting: boolean;
  include_in_monthly_report: boolean;
  conditions: { id: string; condition_group: number; field_name: string; operator: string; comparison_value: string | null }[];
}
interface ConditionsImportRowError {
  row: number;
  recommendation_code: string | null;
  field: string | null;
  code: string;
  message: string;
}
interface ConditionsImportOutcome {
  importType: string;
  status: 'success' | 'validation_failed';
  rowsReceived: number;
  rowsValidated: number;
  recommendationsAffected: number;
  conditionsInserted: number;
  conditionsReplaced: number;
  codes?: string[];
  errors?: ConditionsImportRowError[];
}
interface GapRun {
  id: string;
  user_id: string;
  run_at: string;
  matched_count: number;
  context_snapshot: Record<string, unknown>;
}

const CATEGORIES = ['net_worth', 'retirement', 'goal', 'debt', 'investment_growth', 'cross_border', 'resilience', 'data_quality'];
const STATUSES = ['ahead_of_plan', 'on_track', 'slightly_behind', 'at_risk', 'significantly_off_track', 'review_required'];
const RESULTS = ['favourable', 'unfavourable', 'neutral'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const TRIGGER_TYPES: { value: Recommendation['trigger_type']; label: string }[] = [
  { value: 'forecast_variance', label: 'Forecast variance (Recommendations page)' },
  { value: 'score_pillar', label: 'Health Score pillar (Free/Paid report)' },
];
// Matches healthScore.ts's ComponentCode — the 10 Financial Health Score pillars.
const PILLAR_CODES = ['cash_flow', 'savings', 'emergency_fund', 'debt', 'net_worth', 'investment', 'retirement', 'insurance', 'resilience', 'behaviour'];
// Matches health_score_config's scoreBands — shared by every pillar.
const SCORE_BANDS = ['excellent', 'good', 'fair', 'needs_attention', 'critical'];
const UPLOAD_TYPES: { value: string; label: string }[] = [
  { value: 'master', label: 'Master (recommendations)' },
  { value: 'conditions', label: 'Conditions' },
  { value: 'calculation_methods', label: 'Calculation Methods' },
  { value: 'placeholders', label: 'Template Placeholders' },
];

const emptyForm = () => ({
  recommendation_code: '',
  trigger_type: 'forecast_variance' as Recommendation['trigger_type'],
  forecast_category: 'net_worth',
  forecast_status: 'on_track',
  pillar_code: 'cash_flow',
  score_band: 'needs_attention',
  sub_category: 'overall_variance',
  scenario_name: '',
  scenario_description: '',
  variance_result: '',
  severity: 'medium' as Recommendation['severity'],
  action_type: '',
  action_title_template: '',
  action_content_template: '',
  financial_impact_template: '',
  calculation_method_code: '',
  priority_score: 0,
  is_premium: false,
  is_active: true,
  include_in_forecasting: true,
  include_in_monthly_report: false,
  conditions: [{ condition_group: 1, field_name: 'forecast_category', operator: 'equals', comparison_value: '' }] as Condition[],
});

export function AdminRecommendationsClient() {
  const [list, setList] = useState<Recommendation[]>([]);
  const [gaps, setGaps] = useState<GapRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [expandedGap, setExpandedGap] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [uploadType, setUploadType] = useState('master');
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conditionsOutcome, setConditionsOutcome] = useState<ConditionsImportOutcome | null>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [recRes, gapRes] = await Promise.all([fetch('/api/admin/recommendations'), fetch('/api/admin/recommendations/gaps')]);
      const recJson = await recRes.json();
      const gapJson = await gapRes.json();
      if (!recRes.ok) throw new Error(recJson.error ?? 'Could not load recommendations');
      if (!gapRes.ok) throw new Error(gapJson.error ?? 'Could not load gap review');
      setList(recJson.data);
      setGaps(gapJson.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
     
  }, []);

  const filtered = useMemo(() => {
    return list.filter((r) => {
      if (categoryFilter !== 'all' && r.forecast_category !== categoryFilter) return false;
      if (search.trim() !== '') {
        const q = search.trim().toLowerCase();
        return r.recommendation_code.toLowerCase().includes(q) || r.action_title_template.toLowerCase().includes(q) || r.sub_category.toLowerCase().includes(q);
      }
      return true;
    });
  }, [list, categoryFilter, search]);

  function startEdit(rec: Recommendation) {
    setEditingId(rec.id);
    setForm({
      recommendation_code: rec.recommendation_code,
      trigger_type: rec.trigger_type,
      forecast_category: rec.forecast_category ?? 'net_worth',
      forecast_status: rec.forecast_status ?? 'on_track',
      pillar_code: rec.pillar_code ?? 'cash_flow',
      score_band: rec.score_band ?? 'needs_attention',
      sub_category: rec.sub_category,
      scenario_name: rec.scenario_name,
      scenario_description: rec.scenario_description ?? '',
      variance_result: rec.variance_result ?? '',
      severity: rec.severity,
      action_type: rec.action_type,
      action_title_template: rec.action_title_template,
      action_content_template: rec.action_content_template,
      financial_impact_template: rec.financial_impact_template ?? '',
      calculation_method_code: rec.calculation_method_code ?? '',
      priority_score: rec.priority_score,
      is_premium: rec.is_premium,
      is_active: rec.is_active,
      include_in_forecasting: rec.include_in_forecasting,
      include_in_monthly_report: rec.include_in_monthly_report,
      conditions: rec.conditions.map((c) => ({
        condition_group: c.condition_group,
        field_name: c.field_name,
        operator: c.operator,
        comparison_value: c.comparison_value ?? '',
      })),
    });
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm());
  }

  function updateCondition(i: number, patch: Partial<Condition>) {
    setForm((f) => ({ ...f, conditions: f.conditions.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));
  }
  function addCondition() {
    setForm((f) => ({ ...f, conditions: [...f.conditions, { condition_group: 1, field_name: '', operator: 'equals', comparison_value: '' }] }));
  }
  function removeCondition(i: number) {
    setForm((f) => ({ ...f, conditions: f.conditions.filter((_, idx) => idx !== i) }));
  }

  async function submitForm() {
    setError(null);
    const conditions = form.conditions
      .filter((c) => c.field_name.trim() !== '')
      .map((c) => ({ condition_group: c.condition_group, field_name: c.field_name.trim(), operator: c.operator, comparison_value: c.comparison_value.trim() === '' ? null : c.comparison_value.trim() }));
    const isPillar = form.trigger_type === 'score_pillar';
    const payload = {
      recommendation_code: form.recommendation_code,
      trigger_type: form.trigger_type,
      // Only the fields for the selected trigger_type are sent — the other
      // pair goes null, matching migration 0025's mutually-exclusive check.
      forecast_category: isPillar ? null : form.forecast_category,
      forecast_status: isPillar ? null : form.forecast_status,
      pillar_code: isPillar ? form.pillar_code : null,
      score_band: isPillar ? form.score_band : null,
      sub_category: form.sub_category,
      scenario_name: form.scenario_name,
      scenario_description: form.scenario_description || null,
      variance_result: form.variance_result || null,
      severity: form.severity,
      action_type: form.action_type,
      action_title_template: form.action_title_template,
      action_content_template: form.action_content_template,
      financial_impact_template: form.financial_impact_template || null,
      calculation_method_code: form.calculation_method_code || null,
      priority_score: Number(form.priority_score) || 0,
      is_premium: form.is_premium,
      is_active: form.is_active,
      include_in_forecasting: form.include_in_forecasting,
      include_in_monthly_report: form.include_in_monthly_report,
      conditions,
    };
    try {
      const res = editingId
        ? await fetch(`/api/admin/recommendations/${editingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/admin/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save recommendation');
      resetForm();
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  async function toggleActive(rec: Recommendation) {
    try {
      const res = await fetch(`/api/admin/recommendations/${rec.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !rec.is_active }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not update status');
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  }

  async function handleUpload(file: File | null, inputEl: HTMLInputElement | null) {
    if (!file || uploading) return;
    setUploading(true);
    setConditionsOutcome(null);
    setUploadStatus(`Validating "${file.name}"…`);
    try {
      const csvText = await file.text();
      const res = await fetch('/api/admin/recommendations/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileType: uploadType, csvText }),
      });
      const json = await res.json();
      if (uploadType === 'conditions' && json.data && (json.data.status === 'success' || json.data.status === 'validation_failed')) {
        const outcome = json.data as ConditionsImportOutcome;
        setConditionsOutcome(outcome);
        if (outcome.status === 'validation_failed') {
          setUploadStatus(`Import failed validation — no existing conditions were changed. ${outcome.errors?.length ?? 0} row error(s) found out of ${outcome.rowsReceived} row(s).`);
        } else {
          setUploadStatus(`Success: ${outcome.recommendationsAffected} recommendation(s) updated, ${outcome.conditionsInserted} condition(s) inserted (${outcome.conditionsReplaced} replaced). All other recommendations were left unchanged.`);
          await loadAll();
        }
        return;
      }
      if (!res.ok) throw new Error(json.error ?? 'Upload failed');
      setUploadStatus(`Success: ${JSON.stringify(json.data)}`);
      await loadAll();
    } catch (e) {
      setUploadStatus(`Error: ${e instanceof Error ? e.message : 'Upload failed'}. No changes were made.`);
    } finally {
      setUploading(false);
      if (inputEl) inputEl.value = '';
    }
  }

  return (
    <div className="space-y-6 p-6">
      <h1 className="text-2xl font-semibold text-trust">Recommendations Admin</h1>
      {error && <p className="text-sm text-risk">{error}</p>}

      <section className="rounded-card border bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Bulk update via CSV upload</h2>
        <p className="mt-1 text-sm text-gray-500">
          Upload a CSV in the same column format as the Master / Conditions / Calculation Methods / Placeholders files. Matching codes are
          updated in place; new codes are added; codes not in the file are left untouched. No deployment required.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <select
            className="rounded border px-2 py-1.5 text-sm disabled:opacity-50"
            value={uploadType}
            disabled={uploading}
            onChange={(e) => {
              setUploadType(e.target.value);
              setUploadStatus(null);
              setConditionsOutcome(null);
            }}
          >
            {UPLOAD_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            type="file"
            accept=".csv"
            disabled={uploading}
            aria-disabled={uploading}
            onChange={(e) => handleUpload(e.target.files?.[0] ?? null, e.target)}
            className="text-sm disabled:opacity-50"
          />
          {uploading && (
            <span className="text-xs font-semibold text-trust" role="status">
              Working…
            </span>
          )}
        </div>
        {/* Accessible status region — success/failure/validating text is
            announced to screen readers as it changes, matching how the rest
            of this page's async work (loadAll) is otherwise silent. */}
        <p role="status" aria-live="polite" className="mt-2 text-xs text-gray-600">
          {uploadStatus}
        </p>
        {conditionsOutcome?.status === 'validation_failed' && conditionsOutcome.errors && conditionsOutcome.errors.length > 0 && (
          <div className="mt-2 max-h-64 overflow-y-auto rounded border border-risk/30 bg-risk/5 p-3">
            <p className="text-xs font-semibold text-risk">
              No existing conditions were changed. Fix the following row(s) and re-upload:
            </p>
            <ul className="mt-2 space-y-1 text-xs text-gray-700">
              {conditionsOutcome.errors.map((err, i) => (
                <li key={i}>
                  <span className="font-semibold">Row {err.row}</span>
                  {err.recommendation_code && <> · {err.recommendation_code}</>}
                  {err.field && <> · {err.field}</>} · <span className="text-gray-500">{err.code}</span> — {err.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {conditionsOutcome?.status === 'success' && (
          <p className="mt-2 text-xs text-progress">
            {conditionsOutcome.recommendationsAffected} of {conditionsOutcome.rowsReceived} row(s) validated and applied. Recommendation codes not in this file were not touched.
          </p>
        )}
      </section>

      <section className="rounded-card border bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">{editingId ? 'Edit recommendation' : 'New recommendation'}</h2>
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <input
            className="rounded border px-2 py-1.5 text-sm"
            placeholder="recommendation_code (stable key)"
            value={form.recommendation_code}
            disabled={Boolean(editingId)}
            onChange={(e) => setForm((f) => ({ ...f, recommendation_code: e.target.value }))}
          />
          <input className="rounded border px-2 py-1.5 text-sm" placeholder="Scenario name" value={form.scenario_name} onChange={(e) => setForm((f) => ({ ...f, scenario_name: e.target.value }))} />
          <select
            className="rounded border px-2 py-1.5 text-sm sm:col-span-2"
            value={form.trigger_type}
            onChange={(e) => setForm((f) => ({ ...f, trigger_type: e.target.value as Recommendation['trigger_type'] }))}
          >
            {TRIGGER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          {form.trigger_type === 'score_pillar' ? (
            <>
              <select className="rounded border px-2 py-1.5 text-sm" value={form.pillar_code} onChange={(e) => setForm((f) => ({ ...f, pillar_code: e.target.value }))}>
                {PILLAR_CODES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select className="rounded border px-2 py-1.5 text-sm" value={form.score_band} onChange={(e) => setForm((f) => ({ ...f, score_band: e.target.value }))}>
                {SCORE_BANDS.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <select className="rounded border px-2 py-1.5 text-sm" value={form.forecast_category} onChange={(e) => setForm((f) => ({ ...f, forecast_category: e.target.value }))}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <select className="rounded border px-2 py-1.5 text-sm" value={form.forecast_status} onChange={(e) => setForm((f) => ({ ...f, forecast_status: e.target.value }))}>
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </>
          )}
          <input className="rounded border px-2 py-1.5 text-sm" placeholder="sub_category / signal" value={form.sub_category} onChange={(e) => setForm((f) => ({ ...f, sub_category: e.target.value }))} />
          <select className="rounded border px-2 py-1.5 text-sm" value={form.variance_result} onChange={(e) => setForm((f) => ({ ...f, variance_result: e.target.value }))}>
            <option value="">(no variance_result condition)</option>
            {RESULTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select className="rounded border px-2 py-1.5 text-sm" value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Recommendation['severity'] }))}>
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input className="rounded border px-2 py-1.5 text-sm" placeholder="action_type" value={form.action_type} onChange={(e) => setForm((f) => ({ ...f, action_type: e.target.value }))} />
          <input
            className="rounded border px-2 py-1.5 text-sm"
            placeholder="calculation_method_code"
            value={form.calculation_method_code}
            onChange={(e) => setForm((f) => ({ ...f, calculation_method_code: e.target.value }))}
          />
          <input
            type="number"
            className="rounded border px-2 py-1.5 text-sm"
            placeholder="Priority score"
            value={form.priority_score}
            onChange={(e) => setForm((f) => ({ ...f, priority_score: Number(e.target.value) }))}
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.is_premium} onChange={(e) => setForm((f) => ({ ...f, is_premium: e.target.checked }))} />
            Premium only
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.include_in_forecasting} onChange={(e) => setForm((f) => ({ ...f, include_in_forecasting: e.target.checked }))} />
            Show in Recommendations page
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.include_in_monthly_report} onChange={(e) => setForm((f) => ({ ...f, include_in_monthly_report: e.target.checked }))} />
            Show in Monthly Report
          </label>
        </div>
        <textarea
          className="mt-3 w-full rounded border px-2 py-1.5 text-sm"
          placeholder="Scenario description (why this applies)"
          value={form.scenario_description}
          onChange={(e) => setForm((f) => ({ ...f, scenario_description: e.target.value }))}
        />
        <input
          className="mt-3 w-full rounded border px-2 py-1.5 text-sm"
          placeholder="Action title"
          value={form.action_title_template}
          onChange={(e) => setForm((f) => ({ ...f, action_title_template: e.target.value }))}
        />
        <textarea
          className="mt-3 w-full rounded border px-2 py-1.5 text-sm"
          placeholder="Action content (the recommended action)"
          value={form.action_content_template}
          onChange={(e) => setForm((f) => ({ ...f, action_content_template: e.target.value }))}
        />
        <input
          className="mt-3 w-full rounded border px-2 py-1.5 text-sm"
          placeholder="Financial impact template — use {{field_name}} to interpolate, e.g. {{variance_amount}}"
          value={form.financial_impact_template}
          onChange={(e) => setForm((f) => ({ ...f, financial_impact_template: e.target.value }))}
        />

        <p className="mt-4 text-sm font-semibold text-gray-700">Conditions (same group = OR, different groups = AND)</p>
        <div className="mt-2 space-y-2">
          {form.conditions.map((c, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input
                type="number"
                className="w-16 rounded border px-2 py-1 text-sm"
                value={c.condition_group}
                onChange={(e) => updateCondition(i, { condition_group: Number(e.target.value) || 1 })}
                title="Condition group"
              />
              <input
                className="w-56 rounded border px-2 py-1 text-sm"
                placeholder="field_name e.g. forecast_status"
                value={c.field_name}
                onChange={(e) => updateCondition(i, { field_name: e.target.value })}
              />
              <input className="w-28 rounded border px-2 py-1 text-sm" placeholder="operator" value={c.operator} onChange={(e) => updateCondition(i, { operator: e.target.value })} />
              <input
                className="w-40 rounded border px-2 py-1 text-sm"
                placeholder="comparison value"
                value={c.comparison_value}
                onChange={(e) => updateCondition(i, { comparison_value: e.target.value })}
              />
              <button onClick={() => removeCondition(i)} className="text-xs text-risk">
                Remove
              </button>
            </div>
          ))}
          <button onClick={addCondition} className="text-xs font-semibold text-trust">
            + Add condition
          </button>
        </div>

        <div className="mt-4 flex gap-2">
          <button onClick={submitForm} className="rounded bg-trust px-4 py-2 text-sm text-white">
            {editingId ? 'Save changes' : 'Create recommendation'}
          </button>
          {editingId && (
            <button onClick={resetForm} className="rounded border px-4 py-2 text-sm text-gray-600">
              Cancel
            </button>
          )}
        </div>
      </section>

      <section className="rounded-card border bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-gray-900">
            Library ({filtered.length} of {list.length})
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <select className="rounded border px-2 py-1 text-sm" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input className="rounded border px-2 py-1 text-sm" placeholder="Search code / title / signal" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        </div>
        {loading ? (
          <p className="mt-3 text-sm text-gray-500">Loading...</p>
        ) : (
          <div className="mt-3 max-h-[600px] space-y-2 overflow-y-auto">
            {filtered.slice(0, 300).map((rec) => (
              <div key={rec.id} className="rounded border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-gray-600">
                      {rec.trigger_type === 'score_pillar' ? `pillar: ${rec.pillar_code}` : rec.forecast_category}
                    </span>
                    <span className="ml-2 rounded-full bg-gray-50 px-2 py-0.5 text-xs text-gray-500">{rec.sub_category}</span>
                    <span
                      className={`ml-2 rounded-full px-2 py-0.5 text-xs font-semibold ${rec.is_active ? 'bg-progress/10 text-progress' : 'bg-gray-100 text-gray-500'}`}
                    >
                      {rec.is_active ? 'active' : 'inactive'}
                    </span>
                    {rec.is_premium && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Premium</span>}
                    <p className="mt-1 font-semibold text-gray-900">{rec.action_title_template}</p>
                    <p className="text-xs text-gray-400">
                      {rec.recommendation_code} · {rec.trigger_type === 'score_pillar' ? rec.score_band : rec.forecast_status} · priority {rec.priority_score} ·{' '}
                      {rec.conditions.length} condition(s)
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => startEdit(rec)} className="text-xs font-semibold text-trust">
                      Edit
                    </button>
                    <button onClick={() => toggleActive(rec)} className={`text-xs font-semibold ${rec.is_active ? 'text-risk' : 'text-progress'}`}>
                      {rec.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {filtered.length > 300 && <p className="text-xs text-gray-400">Showing first 300 of {filtered.length} — narrow with the filters above to see more.</p>}
          </div>
        )}
      </section>

      <section className="rounded-card border bg-white p-6">
        <h2 className="text-lg font-semibold text-gray-900">Gap Review — evaluations with no match ({gaps.length})</h2>
        <p className="mt-1 text-sm text-gray-500">
          Each row is a real user evaluation where nothing in the library matched. Expand to see the exact data evaluated, to decide whether a
          new recommendation is needed.
        </p>
        <div className="mt-3 space-y-2">
          {gaps.map((g) => (
            <div key={g.id} className="rounded border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700">
                  User {g.user_id.slice(0, 8)}… · {new Date(g.run_at).toLocaleString()}
                </p>
                <button onClick={() => setExpandedGap((cur) => (cur === g.id ? null : g.id))} className="text-xs font-semibold text-trust">
                  {expandedGap === g.id ? 'Hide context' : 'Show context'}
                </button>
              </div>
              {expandedGap === g.id && (
                <pre className="mt-2 max-h-64 overflow-auto rounded bg-gray-50 p-2 text-xs text-gray-600">{JSON.stringify(g.context_snapshot, null, 2)}</pre>
              )}
            </div>
          ))}
          {gaps.length === 0 && !loading && <p className="text-sm text-gray-500">No gaps recorded yet.</p>}
        </div>
      </section>
    </div>
  );
}
