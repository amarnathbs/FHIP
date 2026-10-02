'use client';

// Market Index Data (BENCH-1 Phase 2): the single Admin workspace for historical
// benchmark uploads, the catalogue, entitlements, scheme mappings and
// ingestion mode. It replaces the earlier Nifty 50 / Sensex-only upload page.
//
// Every control shown or hidden here follows the caller's capability flags
// returned by the overview API. That is a convenience only: the server and the
// database re-check every capability on every request (Admin Architecture
// Standard sections 2 and 4). Result states follow section 8: an unavailable
// service is shown as unavailable, never as an empty healthy dashboard.
import { useCallback, useState } from 'react';
import type { OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import { AdminActionStatus, useAdminActionStatus } from '@/components/admin/AdminActionStatus';
import { useLoad } from './benchmarkData/api';
import { TAB_IDS, TAB_LABELS, apiPaths, nextTab, overviewIsUnavailable, type TabId } from './benchmarkData/benchmarkDataUiLogic';
import CatalogueTab from './benchmarkData/CatalogueTab';
import EntitlementsTab from './benchmarkData/EntitlementsTab';
import IngestionTab from './benchmarkData/IngestionTab';
import JobsTab from './benchmarkData/JobsTab';
import MappingsTab from './benchmarkData/MappingsTab';
import OverviewTab from './benchmarkData/OverviewTab';
import UploadTab from './benchmarkData/UploadTab';
import { ErrorPanel, LoadingPanel, UnavailablePanel } from './benchmarkData/ui';

export default function BenchmarkDataClient() {
  const { state, reload } = useLoad<OverviewResponse>(apiPaths.overview(), 'load Market Index Data');
  const { outcome, reportSuccess, reportFailure } = useAdminActionStatus();
  const [tab, setTab] = useState<TabId>('overview');
  const [preselect, setPreselect] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [announce, setAnnounce] = useState('');

  const say = useCallback((kind: 'success' | 'failure', message: string) => (kind === 'success' ? reportSuccess(message) : reportFailure(message)), [reportSuccess, reportFailure]);
  const changed = useCallback(() => {
    setRefreshKey((k) => k + 1);
    reload();
  }, [reload]);
  const go = useCallback((t: TabId) => {
    setTab(t);
    setAnnounce(`${TAB_LABELS[t]} tab`);
  }, []);

  function onTabKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    const n = nextTab(tab, e.key);
    if (!n) return;
    e.preventDefault();
    go(n);
    requestAnimationFrame(() => document.getElementById(`bm-tab-${n}`)?.focus());
  }

  let body: React.ReactNode;
  if (state.status === 'loading') body = <LoadingPanel what="Market Index Data" />;
  else if (state.status === 'error') body = <ErrorPanel failure={state.failure} what="Market Index Data" onRetry={reload} />;
  else if (overviewIsUnavailable(state.data)) body = <UnavailablePanel reason={state.data.reason} />;
  else {
    const ov = state.data;
    body = (
      <>
        <div role="tablist" aria-label="Market Index Data sections" className="flex flex-wrap gap-1 border-b border-line">
          {TAB_IDS.map((t) => (
            <button key={t} id={`bm-tab-${t}`} type="button" role="tab" aria-selected={tab === t} aria-controls={`bm-panel-${t}`} tabIndex={tab === t ? 0 : -1} onClick={() => go(t)} onKeyDown={onTabKey} className={`min-h-11 rounded-t-compact border border-b-0 px-3 py-2 text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-trust ${tab === t ? 'border-line bg-white text-trust' : 'border-transparent text-muted hover:text-ink'}`}>
              {TAB_LABELS[t]}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`bm-panel-${tab}`} aria-labelledby={`bm-tab-${tab}`} tabIndex={0} className="pt-4 focus-visible:outline-none">
          {tab === 'overview' ? <OverviewTab ov={ov} onUpload={(k) => { setPreselect(k); go('upload'); }} /> : null}
          {tab === 'upload' ? <UploadTab key={`upload-${preselect}`} ov={ov} preselect={preselect} goTab={go} onChanged={changed} /> : null}
          {tab === 'jobs' ? <JobsTab caps={ov.capabilities} refreshKey={refreshKey} onChanged={changed} say={say} /> : null}
          {tab === 'catalogue' ? <CatalogueTab ov={ov} onChanged={changed} say={say} /> : null}
          {tab === 'entitlements' ? <EntitlementsTab ov={ov} onChanged={changed} say={say} /> : null}
          {tab === 'mappings' ? <MappingsTab ov={ov} refreshKey={refreshKey} onChanged={changed} say={say} /> : null}
          {tab === 'ingestion' ? <IngestionTab ov={ov} onChanged={changed} say={say} /> : null}
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-4 py-6">
      <header>
        <h1 className="text-2xl font-semibold text-ink">Market Index Data</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Historical index levels for the benchmarks that funds are compared against, with the permission records that allow FHIP to use them. Uploading a file never gives permission by itself, and a benchmark on manual import only updates when someone uploads a file.
        </p>
      </header>
      <p aria-live="polite" role="status" className="sr-only">{announce}</p>
      <AdminActionStatus outcome={outcome} />
      {body}
    </div>
  );
}
