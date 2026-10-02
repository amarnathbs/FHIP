// BENCH-1 Phase 2 - the honest states of the Market Index Data Admin client, rendered to static HTML
// with react-dom/server (no DOM needed). Proves the unavailable / empty / error / pending / automation
// OFF / not-a-publisher states say what they must, and that Publish is genuinely disabled or absent.
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BenchmarkCapabilityFlags, BenchmarkOverviewRow, PendingImportTask } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { OverviewTable } from '@/components/admin/benchmarkData/OverviewTab';
import { PublishSection } from '@/components/admin/benchmarkData/PublishParts';
import { AutomationBlock, EmptyState, ErrorPanel, PendingImportsPanel, UnavailablePanel } from '@/components/admin/benchmarkData/ui';
import { describeApiFailure } from '@/components/admin/benchmarkData/benchmarkDataUiLogic';

const NONE: BenchmarkCapabilityFlags = { view: true, upload: false, publish: false, correct: false, catalogue: false, entitlementApprove: false };
const task = (o: Partial<PendingImportTask>): PendingImportTask => ({ benchmarkKey: 'NIFTY50_TRI', benchmarkLabel: 'Nifty 50 TRI', status: 'never_imported', latestValidDataDate: null, expectedLatestSession: '2026-09-30', weekdaysBehind: null, historyMissingFrom: '2020-01-01', severity: 'critical', action: 'No Nifty 50 TRI levels have been imported. Upload a history file (Admin > Market Index Data > Upload). This is a manual import, not an automatic update.', ...o });

describe('honest states render the required text', () => {
  it('unavailable: explicit panel with the reason, never an empty healthy dashboard', () => {
    const html = renderToStaticMarkup(h(UnavailablePanel, { reason: 'The benchmark tables are not available (migration 0239 not applied).' }));
    expect(html).toContain('Market Index Data is unavailable');
    expect(html).toContain('migration 0239 not applied');
    expect(html).toContain('not an empty or healthy state');
    expect(html).toContain('role="alert"');
  });
  it('unavailable without a reason still says so', () => {
    expect(renderToStaticMarkup(h(UnavailablePanel, {}))).toContain('No reason was given by the server.');
  });
  it('empty catalogue: says nothing is shown as healthy', () => {
    const html = renderToStaticMarkup(h(OverviewTable, { rows: [], asOfDate: '2026-10-01', effectivelyEnabled: false }));
    expect(html).toContain('No benchmark is in the catalogue yet');
    expect(html).toContain('Nothing is shown as healthy or current');
    expect(renderToStaticMarkup(h(EmptyState, { title: 'Nothing here' }))).toContain('Nothing here');
  });
  it('error: a 403 is explained and offers no useless retry; a 503 offers retry', () => {
    const forbidden = renderToStaticMarkup(h(ErrorPanel, { failure: describeApiFailure(403, null, 'view Market Index Data'), what: 'Market Index Data', onRetry: () => undefined }));
    expect(forbidden).toContain('You cannot view Market Index Data');
    expect(forbidden).not.toContain('Try again');
    expect(forbidden).toContain('an error is not the same as');
    const down = renderToStaticMarkup(h(ErrorPanel, { failure: describeApiFailure(503, null, 'x'), what: 'Market Index Data', onRetry: () => undefined }));
    expect(down).toContain('Could not load Market Index Data');
    expect(down).toContain('Try again');
  });
  it('pending imports: verbatim action sentence, status chip, upload button; no button without the upload capability', () => {
    const t = task({});
    const withCap = renderToStaticMarkup(h(PendingImportsPanel, { tasks: [t], canStage: true, onUpload: () => undefined }));
    expect(withCap).toContain(t.action.replace(/>/g, '&gt;'));
    expect(withCap).toContain('Never imported');
    expect(withCap).toContain('Upload a file for Nifty 50 TRI');
    expect(withCap).toContain('Nothing here updates automatically');
    const without = renderToStaticMarkup(h(PendingImportsPanel, { tasks: [t], canStage: false }));
    expect(without).not.toContain('Upload a file for');
    expect(without).toContain('do not have the upload permission');
  });
  it('pending imports: none waiting / only up-to-date rows is an explicit empty state', () => {
    const html = renderToStaticMarkup(h(PendingImportsPanel, { tasks: [task({ status: 'current', severity: 'info' })], canStage: true }));
    expect(html).toContain('No manual import is waiting');
    expect(html).not.toContain('Upload a file for');
  });
  it('automation OFF says so and names the switch that blocks it', () => {
    const html = renderToStaticMarkup(h(AutomationBlock, { switches: { globalIngestion: true, writeIngestion: false, environmentFlag: false, effectivelyEnabled: false }, notice: 'No benchmark is automated unless every gate holds.' }));
    expect(html).toContain('Recurring ingestion is OFF');
    expect(html).toContain('Environment flag; Write switch (publishing fetched rows) are OFF');
    expect(html).toContain('No benchmark is automated unless every gate holds.');
    expect(html).toContain('Manual file uploads are a separate thing');
    expect(html).not.toContain('Recurring ingestion is ON');
  });
  it('overview row: no data, manual import wording, no approved entitlement', () => {
    const row: BenchmarkOverviewRow = {
      catalogue: { id: 'b', benchmarkKey: 'NIFTY50_TRI', label: 'Nifty 50 TRI', officialName: null, ownerName: null, officialIdentifier: null, assetClass: null, returnType: 'TRI', returnVariant: 'total_return', currencyCode: 'INR', countryCode: 'IN', baseDate: null, launchDate: null, historyStartDate: null, historyClass: 'live', backtestedThrough: null, methodologyUrl: null, sourceUrl: null, evidenceRef: null, evidenceRetrievedAt: null, catalogueStatus: 'draft', lifecycleStatus: 'active', licenceStatusSummary: 'unknown' },
      coverage: { firstDate: null, lastDate: null, rowCount: 0 }, ingestion: null, demand: null, dataState: 'blocked_no_entitlement', entitlements: [], pending: null,
    };
    const html = renderToStaticMarkup(h(OverviewTable, { rows: [row], asOfDate: '2026-10-01', effectivelyEnabled: false }));
    expect(html).toContain('Blocked: no entitlement');
    expect(html).toContain('No levels stored');
    expect(html).toContain('No approved entitlement');
    expect(html).toContain('Manual import');
    expect(html).toContain('nothing updates automatically');
    expect(html).toContain('Draft');
    expect(html).toContain('Total return (TRI)');
    expect(html).toContain('No held scheme needs this benchmark yet');
  });
});

describe('publish section render', () => {
  const base = { jobId: 'j1', mode: 'new_history', fileSha256: 'a'.repeat(64), stagingDigest: 'b'.repeat(64), mutation: { new: 1, revive: 0, identical: 0, correction: 0 }, benchmarks: ['NIFTY50_TRI'], hardErrorCount: 0, blockers: [] as string[], eligible: true, requiredAcks: [] as string[], stagedByMe: false, onPublished: () => undefined };
  it('NEGATIVE CONTROL: a user without the publish capability sees no Publish button, only the explanation', () => {
    const html = renderToStaticMarkup(h(PublishSection, { ...base, caps: { ...NONE, upload: true } }));
    expect(html).not.toContain('Publish this history');
    expect(html).toContain('You can stage and review this upload; a user with the publish permission must publish it.');
  });
  it('a publisher sees Publish, enabled when clean', () => {
    const html = renderToStaticMarkup(h(PublishSection, { ...base, caps: { ...NONE, publish: true } }));
    expect(html).toContain('Publish this history');
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Publish this history/);
  });
  it('NEGATIVE CONTROL: Publish is rendered disabled while hard errors remain, and the reason is listed', () => {
    const html = renderToStaticMarkup(h(PublishSection, { ...base, hardErrorCount: 4, caps: { ...NONE, publish: true } }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish this history/);
    expect(html).toContain('4 hard validation error(s) remain');
  });
  it('required acknowledgements render as explicit checkboxes with their warning text; self-publication needs its own box', () => {
    const html = renderToStaticMarkup(h(PublishSection, { ...base, requiredAcks: ['scale_change', 'weekend_rows'], stagedByMe: true, caps: { ...NONE, publish: true } }));
    expect((html.match(/type="checkbox"/g) ?? []).length).toBe(3);
    expect(html).toContain('possible scale change');
    expect(html).toContain('I staged this upload myself and confirm self-publication');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish this history/);
  });
});
