'use client';

import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { AdminTaskHelp } from '@/components/admin/AdminTaskHelp';
import { AdminActionStatus, type AdminActionOutcome } from '@/components/admin/AdminActionStatus';
import { actionFailureMessage, failureFromResponse, failureFromThrown, readJsonSafely } from '@/lib/resources/admin/resultState';

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
  // A0.2 Wave 1B: must be true for this recommendation to legitimately be
  // active with zero conditions (see migration 0109's named invariant — a
  // recommendation with zero conditions otherwise matches every user
  // unconditionally). Defaults false for every pre-existing row.
  matches_unconditionally: boolean;
  include_in_forecasting: boolean;
  include_in_monthly_report: boolean;
  conditions: { id: string; condition_group: number; field_name: string; operator: string; comparison_value: string | null }[];
}
interface EditRowError {
  index: number;
  field: string | null;
  code: string;
  message: string;
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
// The `GapRun` shape that used to live here — id, user_id, run_at,
// matched_count and the raw `context_snapshot` — was deliberately DELETED,
// not merely unused, as part of the Wave 5 privacy closure. Keeping a type
// that describes one identified person's exact financial figures would
// invite a future contributor to re-wire the fetch that populated it. The
// endpoint no longer returns that payload; see
// app/api/admin/recommendations/gaps/route.ts.

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
  matches_unconditionally: false,
  include_in_forecasting: true,
  include_in_monthly_report: false,
  conditions: [{ condition_group: 1, field_name: 'forecast_category', operator: 'equals', comparison_value: '' }] as Condition[],
});

export function AdminRecommendationsClient() {
  const [list, setList] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm());
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [uploadType, setUploadType] = useState('master');
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [conditionsOutcome, setConditionsOutcome] = useState<ConditionsImportOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<EditRowError[] | null>(null);
  const [confirmClearConditions, setConfirmClearConditions] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<Recommendation | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [toggleOutcome, setToggleOutcome] = useState<AdminActionOutcome>(null);

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      // Wave 5 privacy closure: the gap-review request is GONE, not merely
      // ignored. This screen no longer asks the server for individual-level
      // evaluation data at all, so there is no response to cache, no payload
      // in memory, and nothing for a devtools Network tab to reveal.
      const recRes = await fetch('/api/admin/recommendations');
      // Admin A0.2 Wave 5 (§9, §19): this previously threw the raw server
      // string and rendered it, and an HTML error page from the edge
      // surfaced a `SyntaxError` as the operator's message. The response is
      // now read safely and classified.
      const recJson = await readJsonSafely(recRes);
      if (!recRes.ok) {
        setError(failureFromResponse(recRes.status, recJson, 'the recommendation library').message);
        return;
      }
      setList((recJson?.data as Recommendation[]) ?? []);
    } catch {
      setError(failureFromThrown(null, 'the recommendation library').message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Deferred a tick, matching the convention the sibling Resources admin
    // screens already use: `loadAll` begins its own setState calls before
    // its first `await`, which react-hooks/set-state-in-effect flags as a
    // cascading-render risk. Behaviour is unchanged.
    const timer = setTimeout(() => void loadAll(), 0);
    return () => clearTimeout(timer);

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
      matches_unconditionally: rec.matches_unconditionally,
      include_in_forecasting: rec.include_in_forecasting,
      include_in_monthly_report: rec.include_in_monthly_report,
      conditions: rec.conditions.map((c) => ({
        condition_group: c.condition_group,
        field_name: c.field_name,
        operator: c.operator,
        comparison_value: c.comparison_value ?? '',
      })),
    });
    setConfirmClearConditions(false);
    setSaveErrors(null);
    setSaveStatus(null);
  }

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm());
    setConfirmClearConditions(false);
    setSaveErrors(null);
    setSaveStatus(null);
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
    if (saving) return;
    setError(null);
    setSaveErrors(null);
    const conditions = form.conditions
      .filter((c) => c.field_name.trim() !== '')
      .map((c) => ({ condition_group: c.condition_group, field_name: c.field_name.trim(), operator: c.operator, comparison_value: c.comparison_value.trim() === '' ? null : c.comparison_value.trim() }));

    // A0.2 Wave 1B: a recommendation is never left with zero conditions as
    // a side effect of the form simply having none filled in — saving with
    // zero requires the admin to explicitly confirm that below. Checked
    // client-side first for a fast, specific message; the server (migration
    // 0109's RPC) enforces this authoritatively regardless.
    if (conditions.length === 0 && !confirmClearConditions) {
      setSaveErrors([{ index: 0, field: null, code: 'CONFIRM_REQUIRED', message: 'This form has zero conditions. Check "Save with zero conditions, deliberately" below to confirm, or add at least one condition.' }]);
      setSaveStatus('Not saved — zero conditions needs explicit confirmation.');
      return;
    }

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
      matches_unconditionally: form.matches_unconditionally,
      include_in_forecasting: form.include_in_forecasting,
      include_in_monthly_report: form.include_in_monthly_report,
      conditions,
      clearConditions: conditions.length === 0 && confirmClearConditions,
    };
    setSaving(true);
    setSaveStatus(editingId ? 'Saving changes…' : 'Creating…');
    try {
      const res = editingId
        ? await fetch(`/api/admin/recommendations/${editingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        : await fetch('/api/admin/recommendations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const json = (await readJsonSafely(res)) as { data?: { status?: string; errors?: EditRowError[] } } | null;
      if (!res.ok) {
        if (json?.data?.status === 'validation_failed' && Array.isArray(json.data.errors)) {
          setSaveErrors(json.data.errors);
          setSaveStatus('Not saved — see the errors below. Nothing was changed.');
          return;
        }
        // Wave 5 (§19): the raw server string was interpolated straight into
        // the operator's status line.
        setSaveStatus(`${actionFailureMessage(res.status, json as Record<string, unknown> | null, 'save this recommendation')} Nothing was changed.`);
        return;
      }
      // Admin A0.2 Wave 5 (§9): this previously set 'Saved.'/'Created.' and
      // then immediately called resetForm(), which sets saveStatus back to
      // null in the same tick — so a successful save produced NO visible
      // confirmation at all, ever. Reset first, then report the outcome.
      const confirmation = editingId
        ? 'Saved. The library below has been reloaded from the server and shows the committed values.'
        : 'Created. The new recommendation appears in the library below.';
      resetForm();
      setSaveStatus(confirmation);
      await loadAll();
    } catch {
      setSaveStatus('Not saved: the server could not be reached. Nothing was changed. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  // Admin A0.2 Wave 5 (§9, §10): deactivating a recommendation stops it
  // being served to every user it currently matches, and this was a single
  // unconfirmed click with no busy guard (rapid clicks raced N PATCHes) and
  // no success confirmation. It now confirms, blocks re-entry, reports the
  // committed outcome, and never forwards a raw server string.
  async function applyToggleActive(rec: Recommendation) {
    setTogglingId(rec.id);
    setToggleOutcome(null);
    try {
      const res = await fetch(`/api/admin/recommendations/${rec.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !rec.is_active }),
      });
      if (!res.ok) {
        const json = await readJsonSafely(res);
        setToggleOutcome({
          kind: 'failure',
          message: actionFailureMessage(res.status, json, rec.is_active ? 'deactivate this recommendation' : 'activate this recommendation'),
        });
        return;
      }
      setToggleOutcome({
        kind: 'success',
        message: rec.is_active
          ? `${rec.recommendation_code} is now inactive and will not be served to anyone.`
          : `${rec.recommendation_code} is now active and will be served to everyone it matches.`,
      });
      await loadAll();
    } catch {
      setToggleOutcome({ kind: 'failure', message: 'Could not reach the server, so nothing was changed. Check your connection and try again.' });
    } finally {
      setTogglingId(null);
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
      const json = (await readJsonSafely(res)) as { data?: { status?: string } } | null;
      if (uploadType === 'conditions' && json?.data && (json.data.status === 'success' || json.data.status === 'validation_failed')) {
        const outcome = json.data as unknown as ConditionsImportOutcome;
        setConditionsOutcome(outcome);
        if (outcome.status === 'validation_failed') {
          setUploadStatus(`Import failed validation — no existing conditions were changed. ${outcome.errors?.length ?? 0} row error(s) found out of ${outcome.rowsReceived} row(s).`);
        } else {
          setUploadStatus(`Success: ${outcome.recommendationsAffected} recommendation(s) updated, ${outcome.conditionsInserted} condition(s) inserted (${outcome.conditionsReplaced} replaced). All other recommendations were left unchanged.`);
          await loadAll();
        }
        return;
      }
      if (!res.ok) {
        // Wave 5 (§19): the raw server string was thrown and then rendered.
        setUploadStatus(`${actionFailureMessage(res.status, json as Record<string, unknown> | null, 'apply this file')} No changes were made.`);
        return;
      }
      // Admin A0.2 Wave 5 (§8.5, §19): this previously reported success as
      // `Success: ${JSON.stringify(json.data)}` — a raw JSON blob rendered
      // as the operator's confirmation message. State what changed instead.
      const summary = json?.data as { rowsReceived?: number; upserted?: number; rowsUpserted?: number } | undefined;
      const applied = summary?.upserted ?? summary?.rowsUpserted;
      const received = summary?.rowsReceived;
      setUploadStatus(
        applied !== undefined || received !== undefined
          ? `Success: ${applied ?? received} row(s) applied${received !== undefined && applied !== undefined && applied !== received ? ` out of ${received} received` : ''}. Codes not present in this file were left unchanged.`
          : 'Success: the file was applied. Codes not present in this file were left unchanged.'
      );
      await loadAll();
    } catch {
      setUploadStatus('The server could not be reached, so the file was not applied. No changes were made. Check your connection and try again.');
    } finally {
      setUploading(false);
      if (inputEl) inputEl.value = '';
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <ConfirmDialog
        open={!!pendingToggle}
        title={pendingToggle?.is_active ? 'Deactivate this recommendation?' : 'Activate this recommendation?'}
        message={
          pendingToggle
            ? pendingToggle.is_active
              ? `${pendingToggle.recommendation_code} — "${pendingToggle.action_title_template}" — will stop being served to every user it currently matches. Nothing is deleted; you can activate it again at any time.`
              : `${pendingToggle.recommendation_code} — "${pendingToggle.action_title_template}" — will start being served to every user it matches. Check its conditions first if you are not certain who that is.`
            : ''
        }
        confirmLabel={pendingToggle?.is_active ? 'Deactivate' : 'Activate'}
        cancelLabel="Cancel"
        destructive={!!pendingToggle?.is_active}
        onConfirm={() => {
          const rec = pendingToggle;
          setPendingToggle(null);
          if (rec) void applyToggleActive(rec);
        }}
        onCancel={() => setPendingToggle(null)}
      />

      <div>
        <h1 className="text-2xl font-semibold text-ink">Recommendations</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The library of guidance FHIP serves to a person based on their own results. A recommendation is only shown when
          every one of its conditions matches, and only while it is active.
        </p>
      </div>

      <AdminTaskHelp taskId="ADM-04" />

      {error && (
        <p role="alert" className="rounded-compact border border-risk/30 bg-risk/5 px-3 py-2 text-sm font-medium text-risk">
          {error}
        </p>
      )}
      <AdminActionStatus outcome={toggleOutcome} />

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
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.matches_unconditionally}
              onChange={(e) => setForm((f) => ({ ...f, matches_unconditionally: e.target.checked }))}
              aria-describedby="matches-unconditionally-hint"
            />
            Matches unconditionally (always fires — required to save active with zero conditions)
          </label>
          <p id="matches-unconditionally-hint" className="sr-only">
            Must be checked for this recommendation to be saved as active with zero conditions. Otherwise it is refused — a recommendation with zero conditions matches every user unconditionally.
          </p>
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
          <button onClick={addCondition} disabled={saving} className="text-xs font-semibold text-trust disabled:opacity-50">
            + Add condition
          </button>
          {form.conditions.filter((c) => c.field_name.trim() !== '').length === 0 && (
            <label className="flex items-center gap-2 rounded border border-risk/30 bg-risk/5 p-2 text-xs text-gray-700">
              <input type="checkbox" checked={confirmClearConditions} onChange={(e) => setConfirmClearConditions(e.target.checked)} />
              Save with zero conditions, deliberately (this recommendation will match every user unless &quot;matches unconditionally&quot; above is also checked and it is inactive)
            </label>
          )}
        </div>

        {saveErrors && saveErrors.length > 0 && (
          <div className="mt-3 max-h-48 overflow-y-auto rounded border border-risk/30 bg-risk/5 p-3">
            <p className="text-xs font-semibold text-risk">Nothing was changed. Fix the following and try again:</p>
            <ul className="mt-2 space-y-1 text-xs text-gray-700">
              {saveErrors.map((err, i) => (
                <li key={i}>
                  {err.index > 0 && <span className="font-semibold">Condition {err.index}</span>}
                  {err.field && <> · {err.field}</>} <span className="text-gray-500">{err.code}</span> — {err.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        {/* Accessible status region — mirrors the upload section's aria-live
            pattern, so save/create outcomes are announced too. */}
        <p role="status" aria-live="polite" className="mt-2 text-xs text-gray-600">
          {saveStatus}
        </p>

        <div className="mt-4 flex gap-2">
          <button onClick={submitForm} disabled={saving} aria-disabled={saving} className="rounded bg-trust px-4 py-2 text-sm text-white disabled:opacity-50">
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Create recommendation'}
          </button>
          {editingId && (
            <button onClick={resetForm} disabled={saving} className="rounded border px-4 py-2 text-sm text-gray-600 disabled:opacity-50">
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
            <select aria-label="Filter the library by category" className="min-h-11 rounded border px-2 py-1 text-sm" value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="all">All categories</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              type="search"
              aria-label="Search the library by code, title or signal"
              className="min-h-11 rounded border px-2 py-1 text-sm"
              placeholder="Search code / title / signal"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        {loading ? (
          <p role="status" aria-live="polite" className="mt-3 text-sm text-gray-500">
            Loading recommendations…
          </p>
        ) : filtered.length === 0 ? (
          /* §8 — the library previously rendered an entirely blank panel when
             a filter matched nothing, so "no matches" and "the request
             returned nothing" were indistinguishable. */
          <div className="mt-3 rounded-card border border-dashed border-line bg-gray-50/50 px-6 py-10 text-center">
            <p className="text-sm font-semibold text-ink">
              {list.length === 0 ? 'No recommendations exist yet.' : 'No recommendations match these filters.'}
            </p>
            <p className="mt-1 text-sm text-muted">
              {list.length === 0 ? 'Create one using the form above, or bulk-import a CSV file.' : 'Try a different search, or set the category filter back to All categories.'}
            </p>
          </div>
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
                      {rec.is_active ? 'Active' : 'Inactive'}
                    </span>
                    {rec.is_premium && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700">Premium</span>}
                    {rec.matches_unconditionally && <span className="ml-2 rounded-full bg-purple-100 px-2 py-0.5 text-xs font-semibold text-purple-700">Unconditional — always fires</span>}
                    {rec.is_active && !rec.matches_unconditionally && rec.conditions.length === 0 && (
                      <span className="ml-2 rounded-full bg-risk/10 px-2 py-0.5 text-xs font-semibold text-risk" title="Active with zero conditions and not marked unconditional — this currently matches every user. Edit and either add a condition or check &quot;matches unconditionally&quot;.">
                        Warning: active, 0 conditions
                      </span>
                    )}
                    <p className="mt-1 font-semibold text-gray-900">{rec.action_title_template}</p>
                    <p className="text-xs text-gray-400">
                      {rec.recommendation_code} · {rec.trigger_type === 'score_pillar' ? rec.score_band : rec.forecast_status} · priority {rec.priority_score} ·{' '}
                      {rec.conditions.length} condition(s)
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => startEdit(rec)}
                      aria-label={`Edit ${rec.recommendation_code} — ${rec.action_title_template}`}
                      className="min-h-11 text-xs font-semibold text-trust"
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={togglingId === rec.id}
                      onClick={() => setPendingToggle(rec)}
                      aria-label={`${rec.is_active ? 'Deactivate' : 'Activate'} ${rec.recommendation_code} — ${rec.action_title_template}`}
                      className={`min-h-11 text-xs font-semibold disabled:opacity-50 ${rec.is_active ? 'text-risk' : 'text-progress'}`}
                    >
                      {togglingId === rec.id ? 'Working…' : rec.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </div>
                </div>
              </div>
            ))}
            {filtered.length > 300 && <p className="text-xs text-gray-400">Showing first 300 of {filtered.length} — narrow with the filters above to see more.</p>}
          </div>
        )}
      </section>

      {/* Gap Review — WITHHELD PENDING PRIVACY-SAFE REIMPLEMENTATION.
          Product Owner decision, Admin A0.2 Wave 5 privacy closure.

          What used to be here: a browsable list of real evaluation runs,
          each row showing a truncated user id and a "Show context" control
          that printed that person's raw evaluated financial figures —
          monthly surplus, emergency-fund months, exact variance amounts and
          forecast values — as formatted JSON.

          This is now a static, honest unavailable state. There is NO
          request, NO row list, NO expandable control and NO placeholder to
          click: the section renders the same fixed text regardless of what
          exists in the database, and the endpoint that used to feed it
          refuses to return individual-level data to any role. Hiding this
          section is a courtesy to the operator, not the control — see the
          route handler for the control. */}
      <section aria-labelledby="gap-review-heading" className="rounded-card border bg-white p-6">
        <h2 id="gap-review-heading" className="text-lg font-semibold text-gray-900">
          Gap review — unavailable
        </h2>
        <p className="mt-1 text-sm text-muted">
          Reviewing individual evaluations has been withdrawn. It showed one identified person’s exact financial figures, and no
          Admin role — including Super Admin — may hold standing access to those.
        </p>
        <p className="mt-2 text-sm text-muted">
          It will return as an aggregated report: how many evaluations matched nothing, grouped by reason and by the
          recommendation family involved, with small groups withheld so no individual can be identified from them. Until then
          there is no supported way to review gaps person by person, and none should be sought.
        </p>
        <p className="mt-2 text-sm text-muted">
          Everything else on this page is unaffected — the library, editing, activation and CSV import all work as before.
        </p>
      </section>
    </div>
  );
}
