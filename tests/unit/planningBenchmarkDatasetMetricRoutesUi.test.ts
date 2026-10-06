// Planning Benchmarks dataset to metric mapping: the maintenance route and the screen.
// Evidence label: UNIT-TESTED (route handlers run for real against the in-memory Supabase fake with a spied rpc; the
// screen is a server render of the pure view, the repo has no jsdom, so interaction is not simulated).
//
// Admin Architecture Standard: s2/s4 the WRITE needs the existing activate capability (upload alone is 403), the READ needs
// view, every verb checks before the body is read; s8/s13 a missing migration is 503 and an unreadable list is "unavailable";
// s9 the audit rows returned carry no actor identifier; s14 no new capability, no service-role client.
//
// NAMED NEGATIVE CONTROLS
//   NC-R1  a Super Admin row with no capability gets 403 on every verb (row existence is not the capability);
//   NC-R2  an UPLOAD-only holder gets 403 on POST and the database function is never called;
//   NC-R3  a body without the explicit confirmation, with an unknown action, or without a kind of file is 422 and never reaches the database;
//   NC-R4  a live-figure refusal from the database is surfaced as 409 with the confirmation wording, never swallowed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { createInMemoryDb } from './support/inMemorySupabase';
import { countryRegistryFrom } from './support/countryRegistryFake';
import { FIXTURE_TODAY, pbReferenceTables } from './support/pbAllowedFixture';
import { loadAllowedValues, type AllowedValuesOk } from '@/lib/planning-benchmarks/allowedValues';
import { DatasetMetricsView, confirmWording, kindsText, type DatasetMetricsPayload } from '@/components/admin/PlanningBenchmarkDatasetMetrics';
import { MappingSection } from '@/components/admin/PlanningBenchmarkAllowedValues';

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
const db = createInMemoryDb();

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, rpc: mockRpc, from: (t: string) => countryRegistryFrom(t) ?? (db.client.from(t) as never) }),
}));

import { GET, POST } from '@/app/api/admin/benchmarks/upload/dataset-metrics/route';

const U = '11111111-1111-4111-8111-111111111111';
const ACTOR = '99999999-9999-4999-8999-999999999999';
const DS = '22222222-2222-4222-8222-222222222222';
const profile = { user_id: U, country_of_residence: 'AU', country_confirmed_at: '2026-08-29T00:00:00Z', country_source: 'USER_CONFIRMED', onboarding_completed: true };
const ROOT = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function actor(flags: { upload?: boolean; activate?: boolean } | 'not-admin', events: unknown[] = []) {
  db.reset({
    ...(pbReferenceTables() as Record<string, never[]>),
    user_profiles: [profile] as never[],
    admin_users: (flags === 'not-admin' ? [] : [{ user_id: U, can_upload_planning_benchmarks: flags.upload === true, can_activate_planning_benchmarks: flags.activate === true }]) as never[],
    benchmark_dataset_metric_events: events as never[],
  });
}
const post = (body: unknown) => POST(new Request('http://t/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const setBody = (over: Record<string, unknown> = {}) => ({ action: 'set', datasetId: DS, metricCode: 'savings_rate', appliesToValues: true, appliesToTargetRanges: false, reason: 'add for a refresh', confirmed: true, ...over });
const removeBody = (over: Record<string, unknown> = {}) => ({ action: 'remove', datasetId: DS, metricCode: 'savings_rate', reason: 'wrong pairing', confirmed: true, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetUser.mockResolvedValue({ data: { user: { id: U } } });
  mockRpc.mockResolvedValue({ data: { status: 'added' }, error: null });
});

describe('GET /api/admin/benchmarks/upload/dataset-metrics', () => {
  it('a holder of upload OR activate reads the mapping and the audit rows; no actor identifier is returned; no-store', async () => {
    for (const flags of [{ upload: true }, { activate: true }]) {
      actor(flags, [{ created_at: '2026-10-07T01:00:00Z', action: 'added', dataset_name: 'AU household wealth distribution', dataset_version: '1.0', metric_code: 'net_worth', values_before: null, ranges_before: null, values_after: true, ranges_after: false, live_figures: 0, live_confirmed: false, reason: 'because', actor_user_id: ACTOR }]);
      const res = await GET();
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const raw = await res.text();
      expect(raw).not.toContain(ACTOR);
      const body = JSON.parse(raw) as { data: { allowed: { state: string; mapping: { installed: boolean; pairs: number } }; events: { state: string; events: unknown[] }; capabilities: { activate: boolean } } };
      expect(body.data.allowed.state).toBe('ok');
      expect(body.data.allowed.mapping.installed).toBe(true);
      expect(body.data.events).toMatchObject({ state: 'ok' });
      expect(body.data.events.events).toHaveLength(1);
      expect(body.data.capabilities.activate).toBe(flags.activate === true);
    }
  });

  it('NC-R1: a Super Admin row without either capability is 403; a logged-out caller is 401; a non-admin is 403', async () => {
    actor({});
    expect((await GET()).status).toBe(403);
    actor('not-admin');
    expect((await GET()).status).toBe(403);
    mockGetUser.mockResolvedValue({ data: { user: null } });
    expect((await GET()).status).toBe(401);
  });
});

describe('POST /api/admin/benchmarks/upload/dataset-metrics', () => {
  it('an activate holder adds (set) and removes with the exact database parameters', async () => {
    actor({ activate: true });
    const a = await post(setBody({ confirmLiveFigures: false }));
    expect(a.status).toBe(200);
    expect(mockRpc).toHaveBeenLastCalledWith('set_planning_benchmark_dataset_metric', { p_dataset: DS, p_metric: 'savings_rate', p_values: true, p_ranges: false, p_reason: 'add for a refresh', p_confirm_live: false });
    mockRpc.mockResolvedValue({ data: { status: 'removed' }, error: null });
    const r = await post(removeBody({ confirmLiveFigures: true }));
    expect(r.status).toBe(200);
    expect(mockRpc).toHaveBeenLastCalledWith('remove_planning_benchmark_dataset_metric', { p_dataset: DS, p_metric: 'savings_rate', p_reason: 'wrong pairing', p_confirm_live: true });
  });

  it('NC-R2: an upload-only holder, a Super Admin without a capability, a non-admin and a logged-out caller never reach the database function', async () => {
    for (const who of [{ upload: true }, {}, 'not-admin'] as const) {
      actor(who as never);
      expect((await post(setBody())).status).toBe(403);
    }
    mockGetUser.mockResolvedValue({ data: { user: null } });
    actor({ activate: true });
    expect((await post(setBody())).status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('NC-R3: no confirmation, an unknown action, no kind of file, a short reason and a bad metric code are 422 and never reach the database', async () => {
    actor({ activate: true });
    const bad = [
      setBody({ confirmed: false }),
      { ...setBody(), confirmed: undefined },
      setBody({ action: 'delete_everything' }),
      setBody({ appliesToValues: false, appliesToTargetRanges: false }),
      setBody({ reason: 'ab' }),
      setBody({ metricCode: 'Bad Code; drop table' }),
      setBody({ datasetId: 'not-a-uuid' }),
      removeBody({ confirmed: false }),
    ];
    for (const b of bad) expect((await post(b)).status, JSON.stringify(b)).toBe(422);
    expect((await POST(new Request('http://t/x', { method: 'POST', body: 'not json' }))).status).toBe(422);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('NC-R4: a live-figure refusal is 409 with the confirmation wording; a mapping refusal is 422; the raw database text is never forwarded', async () => {
    actor({ activate: true });
    mockRpc.mockResolvedValue({ data: null, error: { code: '55000', message: 'PB_E_LIVE: 4 live figure(s) exist for this metric in this dataset. Tick the confirmation to continue' } });
    const live = await post(removeBody());
    expect(live.status).toBe(409);
    expect(await live.json()).toMatchObject({ code: 'LIVE_FIGURES_NEED_CONFIRMATION', error: expect.stringContaining('4 live figure(s)') });
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'relation "public.secret_table" blew up at /var/lib/pg' } });
    const raw = await post(setBody());
    expect(raw.status).toBe(500);
    expect(JSON.stringify(await raw.json())).not.toContain('secret_table');
    mockRpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'PB_E_DENIED: the planning benchmark activate permission is required' } });
    expect((await post(setBody())).status).toBe(403);
  });

  it('a missing migration is a 503 that names the mapping, not the upload feature', async () => {
    actor({ activate: true });
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.set_planning_benchmark_dataset_metric in the schema cache' } });
    const res = await post(setBody());
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(body.error).toContain('mapping is not installed on this database yet (migration 0277)');
  });

  it('an unexpected database reply is not reported as success', async () => {
    actor({ activate: true });
    mockRpc.mockResolvedValue({ data: { status: 'weird' }, error: null });
    expect((await post(setBody())).status).toBe(503);
  });

  it('statically: the route and the service never import the service-role client and use the existing activate capability only', () => {
    for (const f of ['app/api/admin/benchmarks/upload/dataset-metrics/route.ts', 'lib/planning-benchmarks/datasetMetricService.ts']) {
      const t = read(f);
      expect(t, f).not.toMatch(/supabase\/admin|createAdminClient|adminClient\(/);
    }
    const route = read('app/api/admin/benchmarks/upload/dataset-metrics/route.ts');
    expect(route).toMatch(/guarded\('view'\)/);
    expect(route).toMatch(/guarded\('activate'\)/);
    expect(read('lib/planning-benchmarks/guards.ts')).not.toMatch(/mapping/i);
  });
});

async function payload(opts: { mapping?: boolean; events?: DatasetMetricsPayload['events'] } = {}): Promise<{ data: DatasetMetricsPayload; av: AllowedValuesOk }> {
  const tables = pbReferenceTables();
  const d = createInMemoryDb();
  d.reset({ ...(tables as Record<string, never[]>), ...(opts.mapping === false ? {} : {}) });
  const av = await loadAllowedValues(d.client as never, FIXTURE_TODAY);
  if (av.state !== 'ok') throw new Error('lists');
  const allowed: AllowedValuesOk = opts.mapping === false ? { ...av, mapping: { installed: false, pairs: 0 } } : av;
  return { data: { allowed, events: opts.events ?? { state: 'ok', events: [] }, capabilities: { activate: true } }, av: allowed };
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
const noop = () => undefined;
const props = (data: DatasetMetricsPayload, over: Record<string, unknown> = {}) => ({
  data, canManage: true, busy: false, datasetId: (data.allowed.state === 'ok' && data.allowed.datasets[0]?.id) || '', onDatasetChange: noop, form: { metricCode: '', values: true, targetRanges: false, reason: '' },
  onFormChange: noop, onSubmitSet: noop, onRemove: noop, onEdit: noop, ...over,
});

describe('the Dataset metric mapping section', () => {
  it('shows the dataset, its mapped metrics with unit, kind and live figures, the evidence, and the controls for an activate holder', async () => {
    const { data } = await payload();
    const html = renderToStaticMarkup(createElement(DatasetMetricsView, props(data, { datasetId: 'ds-fhip' })));
    const t = text(html);
    expect(t).toContain('2 metrics are mapped to this dataset');
    expect(t).toContain('savings_rate');
    expect(t).toContain('planning target ranges');
    expect(t).toContain('fixture: savings rate bands');
    expect(html).toContain('data-testid="pb-mapping-form"');
    expect(html).toMatch(/aria-label="Remove savings_rate from FHIP Planning Benchmarks v1.0"/);
    expect(html).toMatch(/<caption class="sr-only">Metrics mapped to FHIP Planning Benchmarks v1.0<\/caption>/);
    expect(html).toContain('scope="col"');
    expect(html).toMatch(/role="region" aria-label="Metrics mapped to FHIP Planning Benchmarks v1.0" tabindex="0"/);
    // Remove stays disabled until a reason is typed, and says so
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Remove savings_rate/);
    expect(t).toContain('To remove a metric, first type the reason');
  });

  it('a read-only viewer sees the mapping and the history but no controls, and is told why', async () => {
    const { data } = await payload();
    const html = renderToStaticMarkup(createElement(DatasetMetricsView, props(data, { canManage: false, datasetId: 'ds-fhip' })));
    expect(html).not.toContain('data-testid="pb-mapping-form"');
    expect(html).not.toMatch(/aria-label="Remove /);
    expect(text(html)).toContain('you do not hold the permission to change it');
  });

  it('a dataset with nothing mapped says nothing can be uploaded to it', async () => {
    const { data } = await payload();
    const html = renderToStaticMarkup(createElement(DatasetMetricsView, props(data, { datasetId: 'ds-old' })));
    expect(text(html)).toContain('No metric is mapped to this dataset yet');
    expect(text(html)).toContain('Nothing can be uploaded to this dataset until at least one metric is added');
  });

  it('NOT INSTALLED is a visible warning with no controls, never an empty table; unavailable lists are a different message', async () => {
    const { data } = await payload({ mapping: false });
    const html = renderToStaticMarkup(createElement(DatasetMetricsView, props(data)));
    expect(html).toContain('data-testid="pb-mapping-not-installed"');
    expect(text(html)).toContain('not installed on this database yet (migration 0277)');
    expect(html).not.toContain('pb-mapping-form');
    const un = renderToStaticMarkup(createElement(DatasetMetricsView, props({ ...data, allowed: { state: 'unavailable', reason: 'x' } })));
    expect(un).toContain('data-testid="pb-mapping-unavailable"');
    expect(text(un)).toContain('allowed lists are unavailable');
  });

  it('the history is day-first, names the change and the reason, and never shows a year-first date; an unreadable history is said, not shown empty', async () => {
    const events: DatasetMetricsPayload['events'] = {
      state: 'ok',
      events: [
        { at: '2026-10-07T03:30:00Z', action: 'removed', datasetName: 'AU household wealth distribution', datasetVersion: '1.0', metricCode: 'net_worth', valuesBefore: true, rangesBefore: false, valuesAfter: false, rangesAfter: false, liveFigures: 4, liveConfirmed: true, reason: 'wrong pairing' },
        { at: '2026-10-06T03:30:00Z', action: 'changed', datasetName: 'FHIP Planning Benchmarks v1.0', datasetVersion: '1.0', metricCode: 'savings_rate', valuesBefore: false, rangesBefore: true, valuesAfter: true, rangesAfter: true, liveFigures: 0, liveConfirmed: false, reason: 'both' },
      ],
    };
    const { data } = await payload({ events });
    const t = text(renderToStaticMarkup(createElement(DatasetMetricsView, props(data))));
    expect(t).toMatch(/07\/10\/2026/);
    expect(t).toContain('Removed (was observed values), 4 live figure(s) were held and confirmed');
    expect(t).toContain('Changed from planning target ranges to observed values and planning target ranges');
    expect(t).toContain('wrong pairing');
    expect(/\b(19|20)\d{2}-\d{2}-\d{2}\b/.test(t)).toBe(false);
    const un = text(renderToStaticMarkup(createElement(DatasetMetricsView, props({ ...data, events: { state: 'unavailable' } }))));
    expect(un).toContain('The history could not be read right now');
  });

  it('confirmation wording: a removal with live figures is a destructive-style warning that says the figures stay; one without says no live figure is affected', async () => {
    const { av } = await payload();
    const ds = av.datasets.find((d) => d.id === 'ds-wealth')!;
    const live = { ...ds.mappedMetrics[0], liveValues: 4, liveBands: null };
    const w = confirmWording({ action: 'remove', dataset: ds, metricCode: 'net_worth', values: true, targetRanges: false, existing: live });
    expect(w.live).toBe(4);
    expect(w.destructive).toBe(true);
    expect(w.title).toBe('Remove a metric that has live figures?');
    expect(w.message).toMatch(/WARNING: 4 live figure\(s\) exist.*NOT deleted and stay live/);
    expect(w.confirmLabel).toBe('Remove the mapping anyway');
    const none = confirmWording({ action: 'remove', dataset: ds, metricCode: 'net_worth', values: true, targetRanges: false, existing: { ...live, liveValues: 0 } });
    expect(none.live).toBe(0);
    expect(none.message).toContain('No live figure is affected');
    const add = confirmWording({ action: 'set', dataset: ds, metricCode: 'savings_rate', values: true, targetRanges: true, existing: undefined });
    expect(add.title).toBe('Allow this metric in the dataset?');
    expect(add.message).toContain('observed values and planning target ranges');
    expect(kindsText({ values: false, targetRanges: true })).toBe('planning target ranges');
  });

  it('the Allowed values panel prints the allowed metrics per dataset from the same rows, and the not-installed warning otherwise', async () => {
    const { av } = await payload();
    const t = text(renderToStaticMarkup(createElement(MappingSection, { data: av })));
    expect(t).toContain('Allowed metrics per dataset');
    expect(t).toContain('emergency_fund_months');
    expect(t).toContain('AU household wealth distribution');
    const off = renderToStaticMarkup(createElement(MappingSection, { data: { ...av, mapping: { installed: false, pairs: 0 } } }));
    expect(off).toContain('pb-mapping-not-installed');
  });

  it('the Upload tab carries the section, the stage warnings and the preview warning; the maintenance section sits inside the capability-gated tab', () => {
    const t = read('components/admin/PlanningBenchmarkUpload.tsx');
    expect(t).toMatch(/<PlanningBenchmarkDatasetMetrics canManage=\{caps\.activate\} \/>/);
    expect(t).toContain('pb-stage-warnings');
    expect(t).toContain('pb-preview-mapping-warning');
    expect(read('app/api/admin/benchmarks/upload/[id]/route.ts')).toMatch(/loadMappingStatus/);
  });
});
