// BENCH-1 Phase 2 - the Benchmark Data Admin UI decision logic, tested as pure functions
// (this repository has no DOM test environment). Tests named "NEGATIVE CONTROL: ..." are the
// ones scripts/bench1_ui_negative_controls.mjs breaks on purpose, one rule at a time, to prove
// each can fail.
import { describe, expect, it } from 'vitest';
import type { BenchmarkCapabilityFlags, BenchmarkOverviewRow, EntitlementRightsView, ImportJobSummary, PendingImportTask } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import {
  ACK_INFO,
  API_BASE,
  DATE_FORMAT_OPTIONS,
  NUMBER_LOCALE_OPTIONS,
  NO_ENTITLEMENT_MESSAGE,
  apiPaths,
  asJobPreview,
  automationStatus,
  buildCatalogueBody,
  buildEntitlementBody,
  buildMappingBody,
  buildPublishBody,
  buildStageParams,
  canApproveEntitlementNow,
  canEnterStep,
  canStage,
  capabilityDecisions,
  describeApiFailure,
  describePublishSuccess,
  emptyCatalogueForm,
  emptyEntitlementForm,
  emptyMappingForm,
  emptyUploadForm,
  entitlementActions,
  entitlementGate,
  fileKindFromName,
  fileProblem,
  identityMismatch,
  ingestionModeLabel,
  jobActions,
  nextTab,
  publishDecision,
  stepIssues,
  summariseEntitlements,
  validateCatalogueForm,
  validateEntitlementForm,
  validateIngestionForm,
  validateMappingForm,
  visiblePendingTasks,
  xlsxSheetRule,
  ingestionFormFromRow,
  toInspectState,
  type InspectState,
  type PublishInputs,
  type UploadContext,
  type UploadFormState,
} from '@/components/admin/benchmarkData/benchmarkDataUiLogic';

const NONE: BenchmarkCapabilityFlags = { view: false, upload: false, publish: false, correct: false, catalogue: false, entitlementApprove: false };
const caps = (p: Partial<BenchmarkCapabilityFlags>): BenchmarkCapabilityFlags => ({ ...NONE, ...p });

const ENT: EntitlementRightsView = {
  entitlementId: '11111111-1111-4111-8111-111111111111',
  kind: 'commercial_licence',
  status: 'approved',
  rights: { ingestManual: true, automation: false, storage: true, calculation: true, customerDisplay: false, reportExport: false },
  dataFrom: null,
  dataTo: null,
  validFrom: '2025-01-01',
  validTo: null,
  postExpiryStorage: 'unknown',
  evidenceReference: 'Licence 42',
  evidenceUrl: null,
  proposedByMe: false,
  approvedAt: '2025-01-02T00:00:00Z',
};

function row(over: Partial<BenchmarkOverviewRow> = {}, ents: EntitlementRightsView[] = [ENT]): BenchmarkOverviewRow {
  return {
    catalogue: {
      id: '22222222-2222-4222-8222-222222222222', benchmarkKey: 'NIFTY50_TRI', label: 'Nifty 50 TRI', officialName: 'Nifty 50 TRI', ownerName: 'NSE', officialIdentifier: 'NIFTY50', assetClass: 'equity', returnType: 'TRI', returnVariant: 'total_return', currencyCode: 'INR', countryCode: 'IN', baseDate: null, launchDate: null, historyStartDate: null, historyClass: 'live', backtestedThrough: null, methodologyUrl: null, sourceUrl: null, evidenceRef: 'NSE doc', evidenceRetrievedAt: '2026-01-01', catalogueStatus: 'verified', lifecycleStatus: 'active', licenceStatusSummary: 'unknown',
    },
    coverage: { firstDate: null, lastDate: null, rowCount: 0 },
    ingestion: null,
    demand: null,
    dataState: 'no_data',
    entitlements: ents,
    pending: null,
    ...over,
  };
}

const ASOF = '2026-10-01';
const SHEETS: InspectState = { kind: 'xlsx', sheets: [{ name: 'Data', index: 0, state: 'visible', rowCount: 10 }, { name: 'Old', index: 1, state: 'hidden', rowCount: 3 }], problems: [], fileSha256: 'a'.repeat(64), bytes: 100 };

function goodForm(over: Partial<UploadFormState> = {}): UploadFormState {
  return { ...emptyUploadForm('NIFTY50_TRI'), shape: 'single', returnVariant: 'total_return', currencyCode: 'INR', historyClass: 'live', sourceOwner: 'NSE Indices', sourceReference: 'https://example.org/file', entitlementId: ENT.entitlementId, dateFormat: 'YYYY-MM-DD', numberLocale: 'plain', ...over };
}
function ctxOf(over: Partial<UploadContext> = {}): UploadContext {
  return { form: goodForm(), rows: [row()], caps: caps({ view: true, upload: true }), asOfDate: ASOF, file: { name: 'levels.csv', size: 1000 }, inspect: null, maxBytes: 5 * 1024 * 1024, ...over };
}

describe('capability-based visibility (each capability independent)', () => {
  const flags: Array<keyof BenchmarkCapabilityFlags> = ['view', 'upload', 'publish', 'correct', 'catalogue', 'entitlementApprove'];
  it('NEGATIVE CONTROL: granting one capability never switches on another control group', () => {
    const expectedControl: Record<string, keyof ReturnType<typeof capabilityDecisions>> = {
      view: 'canViewAnything', upload: 'canStage', publish: 'canPublishNew', correct: 'canCorrect', catalogue: 'canManageCatalogue', entitlementApprove: 'canApproveEntitlement',
    };
    for (const f of flags) {
      const d = capabilityDecisions(caps({ [f]: true }));
      for (const g of flags) {
        expect(d[expectedControl[g]], `${f} alone -> ${g} control`).toBe(f === g);
      }
    }
  });
  it('catalogue capability drives proposals, mapping review and ingestion editing together, and nothing else', () => {
    const d = capabilityDecisions(caps({ catalogue: true }));
    expect([d.canProposeEntitlement, d.canReviewMappings, d.canEditIngestion, d.canManageCatalogue]).toEqual([true, true, true, true]);
    expect([d.canApproveEntitlement, d.canStage, d.canPublishNew, d.canCorrect]).toEqual([false, false, false, false]);
  });
  it('every explanation is plain text and empty only when the capability is held', () => {
    const none = capabilityDecisions(NONE);
    expect(none.why.stage).toMatch(/upload permission/);
    expect(none.why.publish).toMatch(/publish/);
    expect(none.why.correct).toMatch(/correction permission/);
    expect(capabilityDecisions(caps({ upload: true, publish: true, correct: true, catalogue: true, entitlementApprove: true })).why).toEqual({ stage: '', publish: '', correct: '', catalogue: '', entitlementApprove: '' });
  });
  it('a non-string / missing flag is not a grant', () => {
    const d = capabilityDecisions({ ...NONE, publish: 'true' as unknown as boolean });
    expect(d.canPublishNew).toBe(false);
  });
});

describe('publish enable rule', () => {
  const ready: PublishInputs = { caps: caps({ publish: true }), mode: 'new_history', hardErrorCount: 0, blockers: [], eligible: true, requiredAcks: [], acknowledged: [], stagedByMe: false, selfPublishAck: false, hasValidatedPreview: true };
  it('is enabled when everything is in order', () => {
    expect(publishDecision(ready)).toEqual({ visible: true, enabled: true, reasons: [] });
  });
  it('NEGATIVE CONTROL: publish stays disabled while hard errors remain (no partial publication)', () => {
    const d = publishDecision({ ...ready, hardErrorCount: 3 });
    expect(d.enabled).toBe(false);
    expect(d.reasons.join(' ')).toMatch(/hard validation error/);
    expect(d.reasons.join(' ')).toMatch(/no partial publication/);
  });
  it('NEGATIVE CONTROL: publish stays disabled while a required acknowledgement is missing', () => {
    const d = publishDecision({ ...ready, requiredAcks: ['scale_change', 'weekend_rows'], acknowledged: ['scale_change'] });
    expect(d.enabled).toBe(false);
    expect(d.reasons.join(' ')).toContain(ACK_INFO.weekend_rows.label);
    expect(publishDecision({ ...ready, requiredAcks: ['scale_change', 'weekend_rows'], acknowledged: ['scale_change', 'weekend_rows'] }).enabled).toBe(true);
  });
  it('NEGATIVE CONTROL: self-publication confirmation is required when staged by me', () => {
    expect(publishDecision({ ...ready, stagedByMe: true, selfPublishAck: false }).enabled).toBe(false);
    expect(publishDecision({ ...ready, stagedByMe: true, selfPublishAck: false }).reasons.join(' ')).toMatch(/self-publication/);
    expect(publishDecision({ ...ready, stagedByMe: true, selfPublishAck: true }).enabled).toBe(true);
    expect(publishDecision({ ...ready, stagedByMe: false, selfPublishAck: false }).enabled).toBe(true);
  });
  it('NEGATIVE CONTROL: a user without the publish capability never sees the publish control', () => {
    for (const c of [caps({}), caps({ view: true, upload: true }), caps({ correct: true }), caps({ catalogue: true, entitlementApprove: true })]) {
      const d = publishDecision({ ...ready, caps: c });
      expect(d.visible).toBe(false);
      expect(d.enabled).toBe(false);
      expect(d.reasons[0]).toBe('You can stage and review this upload; a user with the publish permission must publish it.');
    }
  });
  it('corrections need the correction capability, not the publish capability (and vice versa)', () => {
    expect(publishDecision({ ...ready, mode: 'correction', caps: caps({ publish: true }) }).visible).toBe(false);
    expect(publishDecision({ ...ready, mode: 'correction', caps: caps({ correct: true }) }).visible).toBe(true);
    expect(publishDecision({ ...ready, mode: 'new_history', caps: caps({ correct: true }) }).visible).toBe(false);
  });
  it('server blockers, ineligibility and a missing validated preview each disable publish', () => {
    expect(publishDecision({ ...ready, blockers: ['No approved entitlement permits publication for: X.'] }).enabled).toBe(false);
    expect(publishDecision({ ...ready, eligible: false }).enabled).toBe(false);
    expect(publishDecision({ ...ready, hasValidatedPreview: false }).enabled).toBe(false);
  });
  it('NEGATIVE CONTROL: publish stays disabled with no approved entitlement for the benchmark', () => {
    expect(entitlementGate(row({}, []), ASOF)).toEqual({ ok: false, message: NO_ENTITLEMENT_MESSAGE });
    expect(NO_ENTITLEMENT_MESSAGE).toMatch(/does not itself establish permission/);
    expect(entitlementGate(row({}, [{ ...ENT, status: 'draft' }]), ASOF).ok).toBe(false);
    expect(entitlementGate(row({}, [{ ...ENT, status: 'revoked' }]), ASOF).ok).toBe(false);
    expect(entitlementGate(row({}, [{ ...ENT, validTo: '2026-01-01' }]), ASOF).ok).toBe(false);
    expect(entitlementGate(row({}, [{ ...ENT, rights: { ...ENT.rights, storage: false } }]), ASOF).ok).toBe(false);
    expect(entitlementGate(row(), ASOF).ok).toBe(true);
  });
});

describe('publish request body', () => {
  const src = { fileSha256: 'a'.repeat(64), stagingDigest: 'b'.repeat(64), mutation: { new: 10, revive: 2, identical: 5, correction: 1 } };
  it('binds the checksum, digest and counts (revived rows count as new, as the database compares)', () => {
    const b = buildPublishBody(src, ['scale_change'], ['scale_change'], false, false);
    expect(b).toEqual({ expectedSha256: 'a'.repeat(64), expectedDigest: 'b'.repeat(64), expectedCounts: { new: 12, identical: 5, correction: 1 }, acknowledged: ['scale_change'] });
  });
  it('sends selfPublishAck only when staged by me, and only acknowledgements the job requires', () => {
    expect(buildPublishBody(src, ['x', 'weekend_rows'], ['weekend_rows'], true, true).selfPublishAck).toBe(true);
    expect(buildPublishBody(src, ['x', 'weekend_rows'], ['weekend_rows'], true, true).acknowledged).toEqual(['weekend_rows']);
    expect('selfPublishAck' in buildPublishBody(src, [], [], true, false)).toBe(false);
  });
});

describe('upload steps', () => {
  it('step 1 needs a shape, a benchmark, and a confirmed matching return type and currency', () => {
    expect(stepIssues(1, ctxOf({ form: emptyUploadForm() })).length).toBeGreaterThanOrEqual(3);
    expect(stepIssues(1, ctxOf())).toEqual([]);
    expect(stepIssues(1, ctxOf({ form: goodForm({ returnVariant: 'price' }) })).join(' ')).toMatch(/Price, total return and net total return are different/);
    expect(stepIssues(1, ctxOf({ form: goodForm({ currencyCode: 'USD' }) })).join(' ')).toMatch(/quoted in INR/);
    expect(identityMismatch({ returnVariant: 'net_total_return', currencyCode: 'INR' }, row().catalogue)).toMatch(/Net total return/);
  });
  it('a multi-benchmark file needs no benchmark pick but still needs the variant and currency', () => {
    expect(stepIssues(1, ctxOf({ form: goodForm({ shape: 'multi', benchmarkKey: '' }) }))).toEqual([]);
    expect(stepIssues(1, ctxOf({ form: goodForm({ shape: 'multi', benchmarkKey: '', returnVariant: '' }) })).length).toBe(1);
  });
  it('a benchmark that is not in the catalogue cannot be chosen', () => {
    expect(stepIssues(1, ctxOf({ form: goodForm({ benchmarkKey: 'NOPE_KEY' }) })).join(' ')).toMatch(/not in the catalogue/);
  });
  it('a catalogue row with no declared variant cannot be uploaded to', () => {
    const r = row();
    r.catalogue.returnVariant = null;
    expect(stepIssues(1, ctxOf({ rows: [r] })).join(' ')).toMatch(/no declared return type/);
  });
  it('step 2 needs source, reference, history class and an approved entitlement', () => {
    expect(stepIssues(2, ctxOf())).toEqual([]);
    expect(stepIssues(2, ctxOf({ form: goodForm({ sourceOwner: '' }) })).join(' ')).toMatch(/source owner/);
    expect(stepIssues(2, ctxOf({ form: goodForm({ sourceReference: 'x' }) })).join(' ')).toMatch(/URL or delivery reference/);
    expect(stepIssues(2, ctxOf({ form: goodForm({ historyClass: '' }) })).join(' ')).toMatch(/live, backtested/);
    expect(stepIssues(2, ctxOf({ form: goodForm({ dataAsOf: '2026-13-40' }) })).join(' ')).toMatch(/data-as-of/);
    expect(stepIssues(2, ctxOf({ form: goodForm({ entitlementId: '' }) })).join(' ')).toMatch(/Choose the approved entitlement/);
    expect(stepIssues(2, ctxOf({ form: goodForm({ entitlementId: 'other-id' }) })).join(' ')).toMatch(/not an approved/);
    expect(stepIssues(2, ctxOf({ rows: [row({}, [])] })).join(' ')).toContain(NO_ENTITLEMENT_MESSAGE);
  });
  it('NEGATIVE CONTROL: a correction needs a written reason of at least 20 characters', () => {
    const c = caps({ view: true, upload: true, correct: true });
    expect(stepIssues(2, ctxOf({ caps: c, form: goodForm({ mode: 'correction', reason: '' }) })).join(' ')).toMatch(/reason of at least 20/);
    expect(stepIssues(2, ctxOf({ caps: c, form: goodForm({ mode: 'correction', reason: 'too short' }) })).join(' ')).toMatch(/reason of at least 20/);
    expect(stepIssues(2, ctxOf({ caps: c, form: goodForm({ mode: 'correction', reason: 'Provider reissued the file after an error' }) }))).toEqual([]);
  });
  it('a correction is blocked for a user without the correction capability, with an explanation', () => {
    const issues = stepIssues(2, ctxOf({ form: goodForm({ mode: 'correction', reason: 'Provider reissued the file after an error' }) }));
    expect(issues.join(' ')).toMatch(/correction permission/);
  });
  it('NEGATIVE CONTROL: an ambiguous date format has no default and cannot proceed without an explicit choice', () => {
    expect(emptyUploadForm().dateFormat).toBe('');
    expect(emptyUploadForm().numberLocale).toBe('');
    expect(stepIssues(3, ctxOf({ form: goodForm({ dateFormat: '' }) })).join(' ')).toMatch(/never guessed/);
    expect(stepIssues(3, ctxOf({ form: goodForm({ numberLocale: '' }) })).join(' ')).toMatch(/How numbers are written|how numbers/i);
    expect(canStage(ctxOf({ form: goodForm({ dateFormat: '' }) })).ok).toBe(false);
  });
  it('NEGATIVE CONTROL: an XLSX file cannot proceed without an explicit sheet choice', () => {
    const x = ctxOf({ file: { name: 'levels.xlsx', size: 2000 }, form: goodForm({ dateFormat: 'excel_1900' }) });
    expect(stepIssues(3, { ...x, inspect: null }).join(' ')).toMatch(/not been inspected/);
    expect(stepIssues(3, { ...x, inspect: SHEETS }).join(' ')).toMatch(/Choose the sheet to process/);
    expect(stepIssues(3, { ...x, inspect: SHEETS, form: { ...x.form, sheetName: 'Nope' } }).join(' ')).toMatch(/not in this workbook/);
    expect(stepIssues(3, { ...x, inspect: SHEETS, form: { ...x.form, sheetName: 'Data' } })).toEqual([]);
    expect(xlsxSheetRule('csv', null, '').required).toBe(false);
    expect(xlsxSheetRule('xlsx', { ...SHEETS, sheets: [] }, 'Data').ok).toBe(false);
  });
  it('step 3 rejects a missing file, a wrong extension, an oversize file and Excel serial dates in a CSV', () => {
    expect(stepIssues(3, ctxOf({ file: null })).join(' ')).toMatch(/Choose a file/);
    for (const n of ['x.pdf', 'x.xlsm', 'x.xls', 'x', 'x.csv.exe']) expect(fileKindFromName(n), n).toBeNull();
    expect(fileKindFromName('LEVELS.CSV')).toBe('csv');
    expect(fileKindFromName('a.XLSX')).toBe('xlsx');
    expect(fileProblem({ name: 'a.csv', size: 6 * 1024 * 1024 }, 5 * 1024 * 1024)).toMatch(/over the 5 MB limit/);
    expect(fileProblem({ name: 'a.csv', size: 0 }, 100)).toMatch(/empty/);
    expect(stepIssues(3, ctxOf({ form: goodForm({ dateFormat: 'excel_1904' }) })).join(' ')).toMatch(/only apply to .xlsx/);
    expect(stepIssues(3, ctxOf({ form: goodForm({ headerRow: '0' }) })).join(' ')).toMatch(/header row/);
  });
  it('step 3 needs the upload capability', () => {
    expect(stepIssues(3, ctxOf({ caps: caps({ view: true }) })).join(' ')).toMatch(/upload permission/);
  });
  it('a provider export needs a layout, or an explicit date and value column (never inferred)', () => {
    const f = (o: Partial<UploadFormState>) => stepIssues(3, ctxOf({ form: goodForm({ shape: 'provider_export', ...o }) }));
    expect(f({}).join(' ')).toMatch(/Choose how the columns are identified/);
    expect(f({ columnChoice: 'layout' }).join(' ')).toMatch(/Choose the provider layout/);
    expect(f({ columnChoice: 'layout', providerLayoutId: 'nse_tri_export' })).toEqual([]);
    expect(f({ columnChoice: 'layout', providerLayoutId: 'made_up' }).join(' ')).toMatch(/Choose the provider layout/);
    expect(f({ columnChoice: 'explicit', dateColumn: 'Date' }).join(' ')).toMatch(/value/);
    expect(f({ columnChoice: 'explicit', dateColumn: 'Date', valueColumn: 'Date' }).join(' ')).toMatch(/different columns/);
    expect(f({ columnChoice: 'explicit', dateColumn: 'Date', valueColumn: 'Level' })).toEqual([]);
  });
  it('steps cannot be skipped: each needs every earlier step; the preview step needs a staged job', () => {
    expect(canEnterStep(2, ctxOf({ form: emptyUploadForm() }), false)).toBe(false);
    expect(canEnterStep(3, ctxOf({ form: goodForm({ sourceOwner: '' }) }), false)).toBe(false);
    expect(canEnterStep(3, ctxOf(), false)).toBe(true);
    expect(canEnterStep(4, ctxOf(), false)).toBe(false);
    expect(canEnterStep(5, ctxOf(), false)).toBe(false);
    expect(canEnterStep(4, ctxOf(), true)).toBe(true);
  });
});

describe('request params', () => {
  it('builds the exact single-benchmark params and refuses to build anything incomplete', () => {
    const b = buildStageParams(ctxOf());
    expect(b.ok).toBe(true);
    if (b.ok) {
      expect(b.params).toMatchObject({ shape: 'single', mode: 'new_history', benchmarkKey: 'NIFTY50_TRI', returnVariant: 'total_return', currencyCode: 'INR', historyClass: 'live', dateFormat: 'YYYY-MM-DD', numberLocale: 'plain', sourceOwner: 'NSE Indices', originalFileName: 'levels.csv', dataAsOf: null, reason: null, headerRow: 1, entitlementIds: { NIFTY50_TRI: ENT.entitlementId } });
      expect('sheetName' in b.params).toBe(false);
    }
    expect(buildStageParams(ctxOf({ form: goodForm({ dateFormat: '' }) })).ok).toBe(false);
  });
  it('carries the sheet, hidden-row choice and the correction reason', () => {
    const c = ctxOf({ caps: caps({ upload: true, correct: true }), file: { name: 'a.xlsx', size: 10 }, inspect: SHEETS, form: goodForm({ dateFormat: 'excel_1900', sheetName: 'Data', includeHiddenRows: true, mode: 'correction', reason: '  The provider reissued the corrected file  ' }) });
    const b = buildStageParams(c);
    expect(b.ok && b.params.sheetName === 'Data' && b.params.includeHiddenRows === true && b.params.reason === 'The provider reissued the corrected file').toBe(true);
  });
  it('a provider export sends either a layout or an explicit column map, never both', () => {
    const lay = buildStageParams(ctxOf({ form: goodForm({ shape: 'provider_export', columnChoice: 'layout', providerLayoutId: 'nse_tri_export' }) }));
    expect(lay.ok && lay.params.providerLayoutId === 'nse_tri_export' && lay.params.columnMap === undefined).toBe(true);
    const ex = buildStageParams(ctxOf({ form: goodForm({ shape: 'provider_export', columnChoice: 'explicit', dateColumn: 'Date', valueColumn: 'Level' }) }));
    expect(ex.ok && ex.params.columnMap?.date === 'Date' && ex.params.providerLayoutId === undefined).toBe(true);
  });
});

describe('acknowledgement and option catalogues', () => {
  it('every server acknowledgement id has a checkbox label and a warning', () => {
    for (const id of ['scale_change', 'large_moves', 'weekend_rows', 'coverage_gaps', 'hidden_rows_included']) {
      expect(ACK_INFO[id].label.length).toBeGreaterThan(10);
      expect(ACK_INFO[id].warning.length).toBeGreaterThan(20);
    }
  });
  it('the date format and number locale lists cover the contract and show an example for each', () => {
    expect(DATE_FORMAT_OPTIONS.map((o) => o.value)).toEqual(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MM-YYYY', 'DD-MMM-YYYY', 'DD MMM YYYY', 'excel_1900', 'excel_1904']);
    expect(NUMBER_LOCALE_OPTIONS.map((o) => o.value)).toEqual(['plain', 'en', 'in', 'eu']);
    for (const o of [...DATE_FORMAT_OPTIONS, ...NUMBER_LOCALE_OPTIONS]) expect(o.example.length).toBeGreaterThan(0);
    expect(NUMBER_LOCALE_OPTIONS.find((o) => o.value === 'in')?.example).toBe('1,23,456.78');
  });
});

describe('response and error mapping', () => {
  it('a stale preview (409 / 40001) says to upload again and offers a restart', () => {
    for (const body of [{ error: 'benchmark import: stale preview (staging digest differs)', code: 'stale' }, { error: 'x', code: '40001' }, { error: 'The approved counts differ' }]) {
      const f = describeApiFailure(409, body, 'publish');
      expect(f.kind === 'stale' || f.kind === 'conflict').toBe(true);
      expect(f.restart).toBe(true);
    }
    expect(describeApiFailure(409, { error: 'e', code: 'stale' }, 'p').message).toMatch(/preview is out of date - upload the file again/);
  });
  it('duplicate, forbidden, invalid, not found, too large and unavailable each have their own message', () => {
    expect(describeApiFailure(409, { error: 'this exact file was already published by job x', code: 'duplicate' }, 'p').kind).toBe('duplicate');
    expect(describeApiFailure(403, null, 'publish this import')).toMatchObject({ kind: 'forbidden', restart: false });
    expect(describeApiFailure(403, null, 'publish this import').message).toMatch(/permission to publish this import/);
    expect(describeApiFailure(422, { error: 'A correction needs a reason of at least 20 characters.' }, 'x').kind).toBe('invalid');
    expect(describeApiFailure(404, null, 'x').kind).toBe('not_found');
    expect(describeApiFailure(413, null, 'x').kind).toBe('too_large');
    expect(describeApiFailure(401, null, 'x').kind).toBe('unauthenticated');
    expect(describeApiFailure(503, null, 'x')).toMatchObject({ kind: 'unavailable', retryable: true });
    expect(describeApiFailure(500, null, 'x').kind).toBe('error');
  });
  it('raw engine text from the server is never shown', () => {
    const f = describeApiFailure(500, { error: 'relation "ii_benchmarks" does not exist' }, 'load');
    expect(f.message).not.toMatch(/relation/);
    expect(describeApiFailure(403, { error: 'permission denied for table ii_benchmarks' }, 'x').message).not.toMatch(/permission denied for/);
  });
  it('a curated server refusal is shown as given (ingestion automation refusal)', () => {
    const msg = 'benchmark ingestion: no approved, in-term entitlement grants the automation right for this benchmark';
    expect(describeApiFailure(403, { error: msg }, 'x').message).toBe(msg);
  });
  it('publish success reports counts, range and batch; already-published is stated plainly', () => {
    const r = { jobId: 'j', batchId: 'b1', inserted: 5, revived: 1, corrected: 2, identicalSkipped: 3, dateFrom: '2020-01-01', dateTo: '2020-02-01' };
    expect(describePublishSuccess({ alreadyPublished: false, result: r })).toMatchObject({ headline: 'Published.' });
    expect(describePublishSuccess({ alreadyPublished: false, result: r }).lines.join(' ')).toMatch(/5 new, 1 revived, 2 corrected; 3 identical skipped/);
    expect(describePublishSuccess({ alreadyPublished: true, result: r }).headline).toMatch(/Already published/);
  });
  it('the inspect answer is parsed defensively', () => {
    expect(toInspectState(null)).toBeNull();
    const s = toInspectState({ kind: 'xlsx', sheets: [{ name: 'A', index: 0, state: 'veryHidden', rowCount: 4 }, { bad: 1 }], problems: [{ code: 'X', message: 'm' }], fileSha256: 'h', bytes: 9 });
    expect(s?.sheets).toHaveLength(1);
    expect(s?.sheets[0].state).toBe('veryHidden');
    expect(toInspectState({ data: { kind: 'csv', problems: [], fileSha256: 'h', bytes: 1 } })?.kind).toBe('csv');
  });
  it('a stored preview is only trusted when it has the expected shape', () => {
    expect(asJobPreview(null)).toBeNull();
    expect(asJobPreview({ fileSha256: 'x' })).toBeNull();
    expect(asJobPreview('str')).toBeNull();
  });
});

describe('overview presentation rules', () => {
  it('NEVER describes manual import as automatic', () => {
    expect(ingestionModeLabel(null, false).label).toMatch(/Manual import/);
    expect(ingestionModeLabel(null, false).label).toMatch(/nothing updates automatically/);
    const base = { mode: 'manual_import' as const, automationEnabled: true, adapterId: null, publicationLagDays: 1, latestValidDataDate: null, completenessWatermark: null, lastAttemptAt: null, lastSuccessfulRunAt: null, lastManualImportAt: null, lastRunStatus: null, consecutiveFailures: 0 };
    expect(ingestionModeLabel(base, true).label).toBe('Manual import');
    expect(ingestionModeLabel({ ...base, mode: 'disabled' }, true).label).toBe('Disabled');
    expect(ingestionModeLabel({ ...base, mode: 'automated' }, true).label).toBe('Automated');
    expect(ingestionModeLabel({ ...base, mode: 'automated' }, false).label).toMatch(/OFF/);
    expect(ingestionModeLabel({ ...base, mode: 'automated', automationEnabled: false }, true).label).toMatch(/OFF/);
  });
  it('recurring ingestion is OFF unless every switch holds', () => {
    expect(automationStatus({ globalIngestion: true, writeIngestion: true, environmentFlag: true, effectivelyEnabled: true }).headline).toBe('Recurring ingestion is ON');
    const off = automationStatus({ globalIngestion: true, writeIngestion: false, environmentFlag: true, effectivelyEnabled: false });
    expect(off.headline).toBe('Recurring ingestion is OFF');
    expect(off.blockedBy).toEqual(['Write switch (publishing fetched rows)']);
    // contradictory input fails closed
    expect(automationStatus({ globalIngestion: false, writeIngestion: true, environmentFlag: true, effectivelyEnabled: true }).on).toBe(false);
  });
  it('entitlement summary lists only rights of approved, in-term records', () => {
    expect(summariseEntitlements([], ASOF)).toMatchObject({ noApproved: true, text: 'No approved entitlement' });
    expect(summariseEntitlements([{ ...ENT, status: 'draft' }, { ...ENT, status: 'revoked' }, { ...ENT, validTo: '2026-01-01' }], ASOF).noApproved).toBe(true);
    expect(summariseEntitlements([ENT], ASOF).granted.map((g) => g.label)).toEqual(['Ingest', 'Storage', 'Calculation']);
  });
  it('pending list shows only work that needs an operator, most severe first', () => {
    const t = (o: Partial<PendingImportTask>): PendingImportTask => ({ benchmarkKey: 'K', benchmarkLabel: 'L', status: 'due', latestValidDataDate: null, expectedLatestSession: ASOF, weekdaysBehind: 1, historyMissingFrom: null, severity: 'warning', action: 'a', ...o });
    const v = visiblePendingTasks([t({ status: 'current', benchmarkKey: 'A' }), t({ status: 'not_manual', benchmarkKey: 'B' }), t({ status: 'due', benchmarkKey: 'C' }), t({ status: 'overdue', severity: 'critical', benchmarkKey: 'D' })]);
    expect(v.map((x) => x.benchmarkKey)).toEqual(['D', 'C']);
  });
});

describe('job row actions', () => {
  const job = (o: Partial<ImportJobSummary> = {}) => ({ status: 'validated', mode: 'new_history', stagedByMe: false, hardErrorTotal: 0, warningCount: 0, rolledBackAt: null, ...o });
  it('publish is shown only for validated jobs and only to the matching publisher capability', () => {
    expect(jobActions(job(), caps({ publish: true })).canPublishVisible).toBe(true);
    expect(jobActions(job(), caps({ upload: true, correct: true })).canPublishVisible).toBe(false);
    expect(jobActions(job({ status: 'published' }), caps({ publish: true })).canPublishVisible).toBe(false);
    expect(jobActions(job({ mode: 'correction' }), caps({ correct: true })).canPublishVisible).toBe(true);
    expect(jobActions(job(), caps({ upload: true })).publishNotice).toMatch(/publish permission must publish it/);
  });
  it('rollback needs the correction capability and a published, not-yet-rolled-back job', () => {
    expect(jobActions(job({ status: 'published' }), caps({ correct: true })).canRollback).toBe(true);
    expect(jobActions(job({ status: 'published' }), caps({ publish: true, upload: true })).canRollback).toBe(false);
    expect(jobActions(job({ status: 'published', rolledBackAt: '2026-01-01' }), caps({ correct: true })).canRollback).toBe(false);
    expect(jobActions(job({ status: 'validated' }), caps({ correct: true })).canRollback).toBe(false);
  });
  it('cancel follows the database rule (staging admin, publisher or corrector) and live statuses only', () => {
    expect(jobActions(job({ stagedByMe: true }), caps({ upload: true })).canCancel).toBe(true);
    expect(jobActions(job({ stagedByMe: false }), caps({ upload: true })).canCancel).toBe(false);
    expect(jobActions(job({ stagedByMe: false }), caps({ publish: true })).canCancel).toBe(true);
    expect(jobActions(job({ status: 'published', stagedByMe: true }), caps({ upload: true, publish: true })).canCancel).toBe(false);
  });
  it('the error download needs view access and something to download', () => {
    expect(jobActions(job({ hardErrorTotal: 2 }), caps({ view: true })).canDownloadErrors).toBe(true);
    expect(jobActions(job(), caps({ view: true })).canDownloadErrors).toBe(false);
    expect(jobActions(job({ hardErrorTotal: 2 }), caps({})).canDownloadErrors).toBe(false);
  });
});

describe('catalogue, entitlement, mapping and ingestion forms', () => {
  const goodCat = () => ({ ...emptyCatalogueForm(), benchmarkKey: 'NIFTY50_TRI', officialName: 'Nifty 50 TRI', ownerName: 'NSE', assetClass: 'equity', countryCode: 'in', currencyCode: 'inr', returnType: 'TRI', returnVariant: 'total_return' as const, evidenceRef: 'NSE factsheet', evidenceRetrievedAt: '2026-09-30' });
  it('catalogue: key pattern, required fields, type/variant coherence, backtest date and URLs', () => {
    expect(validateCatalogueForm(goodCat())).toEqual({});
    expect(validateCatalogueForm({ ...goodCat(), benchmarkKey: 'nifty-50' }).benchmarkKey).toBeDefined();
    expect(validateCatalogueForm({ ...goodCat(), benchmarkKey: 'AB' }).benchmarkKey).toBeDefined();
    expect(validateCatalogueForm({ ...goodCat(), returnType: 'TRI', returnVariant: 'price' }).returnVariant).toMatch(/Total return/);
    expect(validateCatalogueForm({ ...goodCat(), returnType: 'PRI', returnVariant: 'total_return' }).returnVariant).toMatch(/Price/);
    expect(validateCatalogueForm({ ...goodCat(), returnType: 'OTHER', returnVariant: 'net_total_return' })).toEqual({});
    expect(validateCatalogueForm({ ...goodCat(), historyClass: 'backtested' }).backtestedThrough).toBeDefined();
    expect(validateCatalogueForm({ ...goodCat(), methodologyUrl: 'ftp://x' }).methodologyUrl).toBeDefined();
    expect(validateCatalogueForm({ ...goodCat(), evidenceRetrievedAt: '' }).evidenceRetrievedAt).toBeDefined();
    expect(validateCatalogueForm({ ...goodCat(), assetClass: 'crypto' }).assetClass).toBeDefined();
  });
  it('catalogue body uses the route contract (snake_case, upper-cased codes, nulls for blanks)', () => {
    const b = buildCatalogueBody(goodCat());
    expect(b).toMatchObject({ benchmark_key: 'NIFTY50_TRI', country_code: 'IN', currency_code: 'INR', return_variant: 'total_return', asset_class: 'equity', base_value: null, evidence_retrieved_at: '2026-09-30' });
  });
  const goodEnt = () => ({ ...emptyEntitlementForm(), benchmarkKey: 'NIFTY50_TRI', kind: 'commercial_licence' as const, rights: { ...emptyEntitlementForm().rights, ingestManual: true, storage: true }, validFrom: '2026-01-01', evidenceReference: 'Licence 42' });
  it('entitlement: needs a right, a coherent rights chain, a valid term and evidence', () => {
    expect(validateEntitlementForm(goodEnt())).toEqual({});
    expect(validateEntitlementForm({ ...goodEnt(), rights: emptyEntitlementForm().rights }).rights).toBeDefined();
    expect(validateEntitlementForm({ ...goodEnt(), rights: { ...goodEnt().rights, storage: false, calculation: true } }).rights).toMatch(/storage/);
    expect(validateEntitlementForm({ ...goodEnt(), rights: { ...goodEnt().rights, customerDisplay: true } }).rights).toMatch(/calculation/);
    expect(validateEntitlementForm({ ...goodEnt(), rights: { ...goodEnt().rights, calculation: true, reportExport: true } }).rights).toMatch(/customer display/);
    expect(validateEntitlementForm({ ...goodEnt(), validTo: '2025-01-01' }).validTo).toMatch(/before the start/);
    expect(validateEntitlementForm({ ...goodEnt(), dataFrom: '2020-02-01', dataTo: '2020-01-01' }).dataTo).toBeDefined();
  });
  it('NEGATIVE CONTROL: a public-use permission requires the evidence URL, document date and retrieval date', () => {
    const pub = { ...goodEnt(), kind: 'public_use_permission' as const };
    const e = validateEntitlementForm(pub);
    expect(Object.keys(e).sort()).toEqual(['evidenceDocumentDate', 'evidenceRetrievedAt', 'evidenceUrl']);
    expect(validateEntitlementForm({ ...pub, evidenceUrl: 'https://example.org/terms', evidenceDocumentDate: '2026-01-01', evidenceRetrievedAt: '2026-09-01' })).toEqual({});
  });
  it('entitlement body: the catalogue row supplies the benchmark id, variant and currency', () => {
    const b = buildEntitlementBody(goodEnt(), { id: 'bid', returnVariant: 'total_return', currencyCode: 'INR' });
    expect(b).toMatchObject({ benchmark_id: 'bid', entitlement_kind: 'commercial_licence', return_variant: 'total_return', currency_code: 'INR', allow_manual_ingest: true, allow_storage: true, allow_automation: false });
  });
  it('approve and revoke: self-approval needs its acknowledgement; revoke is only for non-revoked records', () => {
    expect(canApproveEntitlementNow({ note: 'checked the signed licence', proposedByMe: false, selfApprovalAck: false }).ok).toBe(true);
    expect(canApproveEntitlementNow({ note: 'ok', proposedByMe: false, selfApprovalAck: false }).ok).toBe(false);
    expect(canApproveEntitlementNow({ note: 'checked the signed licence', proposedByMe: true, selfApprovalAck: false }).ok).toBe(false);
    expect(canApproveEntitlementNow({ note: 'checked the signed licence', proposedByMe: true, selfApprovalAck: true }).ok).toBe(true);
    expect(entitlementActions({ status: 'draft', proposedByMe: true }, caps({ entitlementApprove: true }))).toEqual({ canApprove: true, needsSelfApprovalAck: true, canRevoke: true });
    expect(entitlementActions({ status: 'approved', proposedByMe: false }, caps({ entitlementApprove: true })).canApprove).toBe(false);
    expect(entitlementActions({ status: 'revoked', proposedByMe: false }, caps({ entitlementApprove: true })).canRevoke).toBe(false);
    expect(entitlementActions({ status: 'draft', proposedByMe: false }, caps({ catalogue: true, publish: true })).canApprove).toBe(false);
  });
  it('mapping: evidence is required and the body follows the route contract', () => {
    const good = { ...emptyMappingForm(), instrumentId: '33333333-3333-4333-8333-333333333333', proposedBenchmarkName: 'Nifty 50 TRI', effectiveFrom: '2024-01-01', evidenceSource: 'amc_sid', evidenceUrl: 'https://example.org/sid.pdf', evidenceDocumentDate: '2024-01-01', evidenceRetrievedAt: '2026-09-01', resolutionMethod: 'deterministic_exact', confidence: 'high' };
    expect(validateMappingForm(good)).toEqual({});
    expect(Object.keys(validateMappingForm(emptyMappingForm())).length).toBeGreaterThanOrEqual(8);
    expect(validateMappingForm({ ...good, instrumentId: 'abc' }).instrumentId).toBeDefined();
    expect(validateMappingForm({ ...good, evidenceUrl: 'javascript:alert(1)' }).evidenceUrl).toBeDefined();
    expect(buildMappingBody(good, 'bm-id')).toMatchObject({ instrument_id: good.instrumentId, benchmark_id: 'bm-id', relationship_type: 'primary', evidence_source: 'amc_sid', effective_to: null });
  });
  it('ingestion: reason, lag, adapter and the automation-only-when-automated rule', () => {
    const base = ingestionFormFromRow(row());
    expect(base.mode).toBe('manual_import');
    expect(validateIngestionForm({ ...base, reason: 'switching to manual' })).toEqual({});
    expect(validateIngestionForm(base).reason).toBeDefined();
    expect(validateIngestionForm({ ...base, reason: 'a long enough reason', automationEnabled: true }).automationEnabled).toBeDefined();
    expect(validateIngestionForm({ ...base, reason: 'a long enough reason', mode: 'automated' }).adapterId).toBeDefined();
    expect(validateIngestionForm({ ...base, reason: 'a long enough reason', publicationLagDays: '99' }).publicationLagDays).toBeDefined();
  });
});

describe('api paths and tabs', () => {
  it('every path is under the benchmark-data base and ids are encoded', () => {
    expect(apiPaths.overview()).toBe(`${API_BASE}/overview`);
    expect(apiPaths.job('a/b')).toBe(`${API_BASE}/jobs/a%2Fb`);
    expect(apiPaths.ingestionMode('x')).toBe(`${API_BASE}/ingestion/x/mode`);
    expect(apiPaths.template('single_date_value')).toBe(`${API_BASE}/templates/single_date_value`);
  });
  it('tab keyboard navigation wraps and supports Home and End', () => {
    expect(nextTab('overview', 'ArrowLeft')).toBe('ingestion');
    expect(nextTab('ingestion', 'ArrowRight')).toBe('overview');
    expect(nextTab('jobs', 'Home')).toBe('overview');
    expect(nextTab('jobs', 'End')).toBe('ingestion');
    expect(nextTab('jobs', 'a')).toBeNull();
  });
});
