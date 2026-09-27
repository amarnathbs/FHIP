// NAV 1 — PO decision #6(b): unit tests for the report-NAV-dependency
// integrity checker (reportNavDependencyIntegrity.ts, pure logic;
// reportNavDependencyAlertLive.ts, orchestration against a fake client).
//
// These tests prove the detector actually distinguishes "healthy" from
// "broken" (a negative control: a dependency with full coverage must NOT
// alert), and that the write-plan decision never silently churns an
// already-open alert into a duplicate or "reopens" a resolved one by
// mutating it -- a fresh break after a real resolution must be its own row
// (mirrors migration 0223's own partial-unique-index dedup, proven
// separately in scripts/nav1_0223_pglite_verification.mjs against real
// Postgres semantics).

import { describe, it, expect } from 'vitest';
import {
  deriveIntegrityVerdict,
  planAlertWrite,
  type NavCoverageProbe,
  type ReportNavDependencyRow,
} from '@/lib/services/investment-intelligence/pc6/reportNavDependencyIntegrity';
import {
  checkReportNavDependencyIntegrity,
  type ReportNavDependencyAlertClient,
} from '@/lib/services/investment-intelligence/pc6/reportNavDependencyAlertLive';

function dep(overrides: Partial<ReportNavDependencyRow> = {}): ReportNavDependencyRow {
  return {
    id: 'dep-1',
    reportId: 'report-1',
    instrumentId: 'instrument-1',
    basis: 'xirr_since_inception',
    navDateFrom: '2020-01-01',
    navDateTo: '2024-12-31',
    ...overrides,
  };
}

describe('deriveIntegrityVerdict (pure)', () => {
  it('NEGATIVE CONTROL: full coverage at both boundaries is healthy -- proves this is not a vacuous always-broken check', () => {
    const probe: NavCoverageProbe = { rowsFound: 900, hasRowNearFrom: true, hasRowNearTo: true };
    expect(deriveIntegrityVerdict(dep(), probe)).toEqual({ healthy: true });
  });

  it('zero rows anywhere in range is unhealthy, with the zero-rows reason (not a boundary reason)', () => {
    const probe: NavCoverageProbe = { rowsFound: 0, hasRowNearFrom: false, hasRowNearTo: false };
    const v = deriveIntegrityVerdict(dep(), probe);
    expect(v.healthy).toBe(false);
    if (!v.healthy) expect(v.reason).toMatch(/zero coverage/);
  });

  it('rows exist but the required latest date has none nearby is unhealthy', () => {
    const probe: NavCoverageProbe = { rowsFound: 50, hasRowNearFrom: true, hasRowNearTo: false };
    const v = deriveIntegrityVerdict(dep(), probe);
    expect(v.healthy).toBe(false);
    if (!v.healthy) expect(v.reason).toMatch(/required latest date/);
  });

  it('rows exist, latest boundary fine, but earliest boundary missing is unhealthy', () => {
    const probe: NavCoverageProbe = { rowsFound: 50, hasRowNearFrom: false, hasRowNearTo: true };
    const v = deriveIntegrityVerdict(dep(), probe);
    expect(v.healthy).toBe(false);
    if (!v.healthy) expect(v.reason).toMatch(/required earliest date/);
  });

  it('a null navDateFrom ("from inception") never checks the earliest boundary', () => {
    const probe: NavCoverageProbe = { rowsFound: 50, hasRowNearFrom: null, hasRowNearTo: true };
    expect(deriveIntegrityVerdict(dep({ navDateFrom: null }), probe)).toEqual({ healthy: true });
  });
});

describe('planAlertWrite (pure)', () => {
  it('unhealthy + no existing alert -> open a new one', () => {
    expect(planAlertWrite({ healthy: false, reason: 'x' }, false).kind).toBe('open_new');
  });
  it('unhealthy + an alert already open -> refresh it, never a duplicate', () => {
    expect(planAlertWrite({ healthy: false, reason: 'x' }, true).kind).toBe('refresh_existing');
  });
  it('healthy + an alert open -> resolve it', () => {
    expect(planAlertWrite({ healthy: true }, true).kind).toBe('resolve_existing');
  });
  it('healthy + nothing open -> no action (never writes a healthy row)', () => {
    expect(planAlertWrite({ healthy: true }, false).kind).toBe('no_action');
  });
});

/** A fully in-memory fake of ReportNavDependencyAlertClient, enough to prove the orchestration wiring end-to-end without any DB. */
function makeFakeClient(config: {
  dependencies: ReportNavDependencyRow[];
  navRowsByInstrument: Record<string, string[]>; // instrumentId -> sorted price_date strings
}): ReportNavDependencyAlertClient & {
  alerts: Array<{ id: string; reportId: string; instrumentId: string; basis: string; resolvedAt: string | null; detail: string; rowsFound: number }>;
  setNavRows(byInstrument: Record<string, string[]>): void;
} {
  const alerts: Array<{ id: string; reportId: string; instrumentId: string; basis: string; resolvedAt: string | null; detail: string; rowsFound: number }> = [];
  let nextId = 1;
  const daysBetween = (a: string, b: string) => Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
  return {
    alerts,
    setNavRows(byInstrument) {
      config.navRowsByInstrument = byInstrument;
    },
    async countNavRowsInRange(instrumentId, from, to) {
      const dates = config.navRowsByInstrument[instrumentId] ?? [];
      return dates.filter((d) => (from === null || d >= from) && d <= to).length;
    },
    async hasNavRowNear(instrumentId, date, toleranceDays) {
      const dates = config.navRowsByInstrument[instrumentId] ?? [];
      return dates.some((d) => daysBetween(d, date) <= toleranceDays);
    },
    async listDependencies() {
      return config.dependencies;
    },
    async findOpenAlert(reportId, instrumentId, basis) {
      const found = alerts.find((a) => a.reportId === reportId && a.instrumentId === instrumentId && a.basis === basis && a.resolvedAt === null);
      return found ? { id: found.id } : null;
    },
    async insertAlert(row) {
      alerts.push({ id: `alert-${nextId++}`, reportId: row.reportId, instrumentId: row.instrumentId, basis: row.basis, resolvedAt: null, detail: row.detail, rowsFound: row.rowsFound });
    },
    async refreshAlert(alertId, rowsFound, detail) {
      const a = alerts.find((x) => x.id === alertId)!;
      a.rowsFound = rowsFound;
      a.detail = detail;
    },
    async resolveAlert(alertId, detail) {
      const a = alerts.find((x) => x.id === alertId)!;
      a.resolvedAt = '2026-09-27T00:00:00.000Z';
      a.detail = detail;
    },
  };
}

describe('checkReportNavDependencyIntegrity (orchestration, fake client)', () => {
  it('NEGATIVE CONTROL: a dependency with full real coverage produces NO alert', async () => {
    const client = makeFakeClient({
      dependencies: [dep({ navDateTo: '2024-12-31', navDateFrom: '2024-01-01' })],
      navRowsByInstrument: { 'instrument-1': ['2024-01-02', '2024-06-15', '2024-12-30'] },
    });
    const results = await checkReportNavDependencyIntegrity(client);
    expect(results[0].verdict.healthy).toBe(true);
    expect(client.alerts).toHaveLength(0);
  });

  it('a dependency whose entire range was deleted raises exactly one alert, with the zero-coverage detail', async () => {
    const client = makeFakeClient({
      dependencies: [dep()],
      navRowsByInstrument: {}, // instrument-1 has NO rows at all -- simulates a deleted range
    });
    const results = await checkReportNavDependencyIntegrity(client);
    expect(results[0].verdict.healthy).toBe(false);
    expect(client.alerts).toHaveLength(1);
    expect(client.alerts[0].resolvedAt).toBeNull();
    expect(client.alerts[0].detail).toMatch(/zero coverage/);
  });

  it('re-running the check against the SAME still-broken dependency refreshes the existing alert, never a duplicate row', async () => {
    const client = makeFakeClient({ dependencies: [dep()], navRowsByInstrument: {} });
    await checkReportNavDependencyIntegrity(client);
    await checkReportNavDependencyIntegrity(client);
    expect(client.alerts).toHaveLength(1);
  });

  it('once coverage is restored, the open alert is resolved -- never deleted, never silently forgotten', async () => {
    const client = makeFakeClient({ dependencies: [dep()], navRowsByInstrument: {} });
    await checkReportNavDependencyIntegrity(client);
    expect(client.alerts).toHaveLength(1);
    expect(client.alerts[0].resolvedAt).toBeNull();

    // Restore coverage (e.g. a real restoration attempt succeeded) and re-check.
    client.setNavRows({ 'instrument-1': ['2020-01-02', '2022-06-15', '2024-12-30'] });
    await checkReportNavDependencyIntegrity(client);
    expect(client.alerts).toHaveLength(1); // still the SAME row, not a new one
    expect(client.alerts[0].resolvedAt).not.toBeNull();
  });

  it('a fresh break AFTER a real resolution opens its own new alert row -- never reopens the resolved one', async () => {
    const client = makeFakeClient({
      dependencies: [dep()],
      navRowsByInstrument: { 'instrument-1': ['2020-01-02', '2022-06-15', '2024-12-30'] },
    });
    // First check: healthy, no alert.
    await checkReportNavDependencyIntegrity(client);
    expect(client.alerts).toHaveLength(0);

    // Manually seed a resolved alert to simulate history, then break it again.
    client.alerts.push({ id: 'alert-old', reportId: 'report-1', instrumentId: 'instrument-1', basis: 'xirr_since_inception', resolvedAt: '2026-01-01T00:00:00.000Z', detail: 'old, resolved', rowsFound: 10 });
    client.setNavRows({});
    await checkReportNavDependencyIntegrity(client);

    const openAlerts = client.alerts.filter((a) => a.resolvedAt === null);
    expect(openAlerts).toHaveLength(1);
    expect(client.alerts.find((a) => a.id === 'alert-old')!.resolvedAt).toBe('2026-01-01T00:00:00.000Z'); // untouched
  });

  it('multiple dependencies are each checked independently -- one broken instrument does not mask a healthy one', async () => {
    const client = makeFakeClient({
      dependencies: [
        dep({ id: 'dep-a', reportId: 'report-a', instrumentId: 'instrument-a' }),
        dep({ id: 'dep-b', reportId: 'report-b', instrumentId: 'instrument-b' }),
      ],
      navRowsByInstrument: { 'instrument-a': ['2020-01-02', '2024-12-30'] }, // instrument-b has nothing
    });
    const results = await checkReportNavDependencyIntegrity(client);
    expect(results.find((r) => r.dependency.instrumentId === 'instrument-a')!.verdict.healthy).toBe(true);
    expect(results.find((r) => r.dependency.instrumentId === 'instrument-b')!.verdict.healthy).toBe(false);
    expect(client.alerts).toHaveLength(1);
    expect(client.alerts[0].instrumentId).toBe('instrument-b');
  });
});
