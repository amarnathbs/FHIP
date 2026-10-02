// Overview: per-benchmark honest state, pending manual imports, automation status.
// Presentational (no hooks of its own) so every state can be rendered to static HTML in tests.
import type { BenchmarkOverviewRow, OverviewResponse } from '@/lib/services/investment-intelligence/benchmarkData/apiTypes';
import {
  catalogueStatusChip,
  dataStateChip,
  formatCount,
  formatDate,
  formatDateTime,
  ingestionModeLabel,
  summariseEntitlements,
  variantLabel,
} from './benchmarkDataUiLogic';
import { AutomationBlock, Chip, EmptyState, PendingImportsPanel, Panel, ScrollTable, Td, Th } from './ui';

export function OverviewTable({ rows, asOfDate, effectivelyEnabled }: { rows: readonly BenchmarkOverviewRow[]; asOfDate: string; effectivelyEnabled: boolean }) {
  if (rows.length === 0) {
    return <EmptyState title="No benchmark is in the catalogue yet">Nothing is shown as healthy or current because nothing exists. Add benchmarks on the Catalogue tab.</EmptyState>;
  }
  return (
    <ScrollTable label="Benchmarks and their data state" minWidth="min-w-[1100px]">
      <thead>
        <tr><Th>Benchmark</Th><Th>Return type and currency</Th><Th>Catalogue</Th><Th>Data</Th><Th>Coverage</Th><Th>Ingestion</Th><Th>Demand</Th><Th>Entitlements</Th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const cat = catalogueStatusChip(r.catalogue.catalogueStatus);
          const ds = dataStateChip(r.dataState);
          const mode = ingestionModeLabel(r.ingestion, effectivelyEnabled);
          const ent = summariseEntitlements(r.entitlements, asOfDate);
          const i = r.ingestion;
          return (
            <tr key={r.catalogue.benchmarkKey}>
              <Td><span className="font-medium text-ink">{r.catalogue.label}</span><br /><span className="font-mono text-xs text-muted">{r.catalogue.benchmarkKey}</span></Td>
              <Td>{variantLabel(r.catalogue.returnVariant)}<br /><span className="text-xs text-muted">{r.catalogue.currencyCode ?? 'currency not declared'}</span></Td>
              <Td><Chip label={cat.label} tone={cat.tone} /></Td>
              <Td><Chip label={ds.label} tone={ds.tone} /></Td>
              <Td>
                {r.coverage.rowCount === 0 ? 'No levels stored' : `${formatDate(r.coverage.firstDate)} to ${formatDate(r.coverage.lastDate)}`}
                <br /><span className="text-xs text-muted">{formatCount(r.coverage.rowCount)} level(s)</span>
              </Td>
              <Td>
                <Chip label={mode.label} tone={mode.tone} />
                {i ? (
                  <dl className="mt-1 text-xs text-muted">
                    <div><dt className="inline">Latest valid data date: </dt><dd className="inline text-ink">{formatDate(i.latestValidDataDate)}</dd></div>
                    <div><dt className="inline">Completeness watermark: </dt><dd className="inline text-ink">{formatDate(i.completenessWatermark)}</dd></div>
                    <div><dt className="inline">Last attempt: </dt><dd className="inline text-ink">{formatDateTime(i.lastAttemptAt)}</dd></div>
                    <div><dt className="inline">Last successful run: </dt><dd className="inline text-ink">{formatDateTime(i.lastSuccessfulRunAt)}</dd></div>
                  </dl>
                ) : <p className="mt-1 text-xs text-muted">No ingestion state recorded.</p>}
              </Td>
              <Td>
                {r.demand ? (
                  <span className="text-xs">Needed from {r.demand.requiredFrom}{r.demand.requiredFromInvestor ? `; investor periods from ${r.demand.requiredFromInvestor}` : ''}; {formatCount(r.demand.schemeCount)} scheme(s) in {formatCount(r.demand.familyCount)} family(ies)</span>
                ) : <span className="text-xs text-muted">No held scheme needs this benchmark yet</span>}
              </Td>
              <Td>
                {ent.noApproved ? <Chip label="No approved entitlement" tone="bad" /> : (
                  <div className="flex flex-wrap gap-1">{ent.granted.map((g) => <Chip key={g.key} label={g.label} tone="ok" />)}</div>
                )}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </ScrollTable>
  );
}

export default function OverviewTab({ ov, onUpload }: { ov: OverviewResponse; onUpload: (benchmarkKey: string) => void }) {
  return (
    <div className="space-y-4">
      <AutomationBlock switches={ov.switches} notice={ov.automationNotice} />
      <PendingImportsPanel tasks={ov.pendingImports} canStage={ov.capabilities.upload} onUpload={onUpload} />
      <Panel title="Indices" description={`As at ${ov.asOfDate}. A benchmark with no stored levels is shown as no data, never as up to date.`}>
        <OverviewTable rows={ov.rows} asOfDate={ov.asOfDate} effectivelyEnabled={ov.switches.effectivelyEnabled} />
      </Panel>
    </div>
  );
}
